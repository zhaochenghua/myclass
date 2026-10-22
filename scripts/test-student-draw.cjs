// Real viewer UI and phone WebSocket flow against isolated fictional rosters.
const { chromium } = require('playwright');
const WebSocket = require('../server/node_modules/ws');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = process.env.DRAW_TEST_OUTPUT || path.join(os.tmpdir(), 'myclass-draw-proof');
  await fs.mkdir(output, { recursive: true });
  let browser, phone;
  const errors = [];
  try {
    const item = (await (await server.api('/classes', 'alice', 'POST', { name: 'Draw test' })).json()).item;
    const students = ['01', '03', '09', '12'].map(number => ({ number, name: `Student ${number}` }));
    await server.api(`/classes/${item.id}`, 'alice', 'PUT', { name: item.name, students, revision: 1 });
    browser = await chromium.launch({ headless: true,
      ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      Element.prototype.requestFullscreen = async () => {};
      Math.random = () => 0;
    });
    const open = async () => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.base}/`);
      await page.waitForFunction(() => !!state.roomCode && !!studentRoller);
      return page;
    };
    const setup = async (page, classId, user = 'alice') => {
      await page.evaluate(async ({ classId, user }) => {
        await studentRoller.setTeacher(`${user}-test-token`, false);
        await studentRoller.receiveSelection({ type: 'student.selection.set', requestId: 'setup', classId, mode: 'number', count: 4 });
        toggleBlackboard(true);
      }, { classId, user });
    };
    const roll = async page => {
      const response = page.waitForResponse(r => r.url().endsWith(`/classes/${item.id}/draw`) && r.request().method() === 'POST');
      await page.locator('#rollStudentButton').click();
      const outcome = await (await response).json();
      await page.waitForFunction(() => document.getElementById('rollStudentResult').classList.contains('done'));
      assert.equal(await page.locator('#rollStudentResult').textContent(), outcome.candidate.text);
      return outcome;
    };
    let page = await open();
    await setup(page, item.id);
    const outcomes = [await roll(page)];
    await page.screenshot({ path: path.join(output, '01-first-lesson.png') });
    await page.reload();
    await page.waitForFunction(() => !!state.roomCode && !!studentRoller);
    await setup(page, item.id);
    outcomes.push(await roll(page));
    // A different viewer/browser context shares the server's class progress.
    const otherContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const other = await otherContext.newPage();
    other.on('pageerror', error => errors.push(error.message));
    await other.goto(`${server.base}/`);
    await other.waitForFunction(() => !!state.roomCode && !!studentRoller);
    await setup(other, item.id);
    outcomes.push(await roll(other));
    await otherContext.close();
    // A phone uses the existing protocol and receives the viewer's same result.
    phone = new WebSocket(`${server.base.replace('http', 'ws')}/ws`);
    const messages = [];
    phone.on('message', raw => messages.push(JSON.parse(raw)));
    await once(phone, 'open');
    phone.send(JSON.stringify({ type: 'teacher.join', code: await page.evaluate(() => state.roomCode),
      token: 'alice-test-token', supportsStudentSelection: true }));
    const take = async (type, status) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const found = messages.find(m => m.type === type && (!status || m.status === status));
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Phone timeout: ${type}/${status}: ${JSON.stringify(messages)}`);
    };
    await take('join.accepted');
    const response = page.waitForResponse(r => r.url().endsWith(`/classes/${item.id}/draw`) && r.request().method() === 'POST');
    phone.send(JSON.stringify({ type: 'student.roll', requestId: 'phone-draw-4' }));
    const final = await (await response).json();
    const message = await take('student.roll.result', 'done');
    assert.equal(message.requestId, 'phone-draw-4');
    assert.ok(message.message.includes(final.candidate.text));
    assert.equal(await page.locator('#rollStudentResult').textContent(), final.candidate.text);
    outcomes.push(final);
    assert.equal(new Set(outcomes.map(o => o.candidate.id)).size, 4);
    assert.ok(outcomes.every(o => o.round === 1));
    assert.equal(final.remaining, 0);
    await page.screenshot({ path: path.join(output, '02-phone-result.png') });
    phone.terminate(); phone = null;
    await page.close();
    // Number-only mode persists on reload and is isolated between teachers.
    page = await open();
    await setup(page, '', 'bob');
    await page.locator('#rollStudentButton').click();
    await page.waitForFunction(() => document.getElementById('rollStudentResult').classList.contains('done'));
    assert.equal(await page.locator('#rollStudentResult').textContent(), '01');
    await page.reload();
    await page.waitForFunction(() => !!state.roomCode && !!studentRoller);
    await setup(page, '', 'bob');
    await page.locator('#rollStudentButton').click();
    await page.waitForFunction(() => document.getElementById('rollStudentResult').classList.contains('done'));
    assert.equal(await page.locator('#rollStudentResult').textContent(), '02');
    await setup(page, '');
    await page.locator('#rollStudentButton').click();
    await page.waitForFunction(() => document.getElementById('rollStudentResult').classList.contains('done'));
    assert.equal(await page.locator('#rollStudentResult').textContent(), '01');
    const progress = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('myclass.studentDraw.')));
    assert.ok(progress.every(key => !key.includes('test-token')));
    assert.equal(progress.length, 2);
    await page.screenshot({ path: path.join(output, '03-number-mode.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', idsAcrossLessons: outcomes.map(o => o.candidate.id),
      phoneResult: message.message, numberModeAfterReload: '02', output }, null, 2));
  } catch (error) {
    if (browser) {
      const pages = browser.contexts().flatMap(c => c.pages());
      if (pages.length) await pages[0].screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    phone?.terminate();
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
