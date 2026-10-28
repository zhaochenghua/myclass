const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

const students = [
  { number: '01', name: '张三' },
  { number: '02', name: '李四' },
  { number: '03', name: '王五' },
  { number: '04', name: '赵六' }
];

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-admin-homework-status-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    const { item: teachingClass } = await (await server.api('/classes', 'alice', 'POST', { name: '七年级（2）班' })).json();
    await server.api(`/classes/${teachingClass.id}`, 'alice', 'PUT', {
      name: teachingClass.name, students, revision: 1
    });

    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('admin_token', 'alice-test-token'));
    await page.goto(`${server.base}/admin.html`);
    await page.getByRole('button', { name: '任教班级', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#homeworkEmpty')?.textContent.includes('还没有作业登记'));
    await page.waitForFunction(() => !document.querySelector('#toggleHomeworkStatusSettingsButton')?.disabled);

    await page.locator('#toggleHomeworkStatusSettingsButton').click();
    await page.waitForSelector('#homeworkStatusSettings:not([hidden])');
    assert.equal(await page.locator('.homework-status-row').count(), 4);

    const row = statusId => page.locator(`.homework-status-row[data-status-id="${statusId}"]`);
    await row('copy').locator('.homework-status-label').fill('抄袭');
    await row('copy').locator('.homework-status-tone').selectOption('blue');
    await row('copy').locator('.homework-status-row-action').filter({ hasText: '保存' }).click();
    await page.waitForFunction(() => document.querySelector('.homework-status-row[data-status-id="copy"] .homework-status-preview')?.textContent === '抄袭');

    // Create an assignment after renaming so the new label is used by the
    // registration buttons and the saved record.
    await page.locator('#newHomeworkTitle').fill('第一单元练习');
    await page.getByRole('button', { name: '新建并开始登记' }).click();
    await page.waitForSelector('.homework-student');
    const student = number => page.locator(`.homework-student[data-number="${number}"]`);
    assert.equal(await student('01').locator('.homework-status').count(), 4);
    assert.equal(await student('01').locator('[data-status="copy"]').innerText(), '抄袭');
    await student('01').locator('[data-status="copy"]').click();

    // Add a custom fifth status and register it for another student.
    await page.locator('#toggleHomeworkStatusSettingsButton').click();
    await page.waitForSelector('#homeworkStatusSettings:not([hidden])');
    await page.locator('#newHomeworkStatusLabel').fill('未订正');
    await page.locator('#newHomeworkStatusTone').selectOption('purple');
    await page.locator('#createHomeworkStatusButton').click();
    await page.waitForFunction(() => document.querySelectorAll('.homework-status-row').length === 5);
    assert.equal(await student('02').locator('.homework-status').count(), 5);
    await student('02').locator('[data-status]').filter({ hasText: '未订正' }).click();
    await page.waitForFunction(() => document.querySelector('#homeworkSaveState')?.textContent === '已保存');
    assert.match(await page.locator('#homeworkCounts').innerText(), /已登记 2 \/ 4 · 优秀 0 · 抄袭 1 · 错多 0 · 未交 0 · 未订正 1/);

    await page.getByRole('button', { name: '历次作业统计', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#homeworkStatsTables .homework-assignment-table tbody tr').length === 1);
    const headers = await page.locator('#homeworkStatsTables .homework-assignment-table thead th').allInnerTexts();
    assert.deepEqual(headers, ['日期', '作业名称', '优秀', '抄袭', '错多', '未交', '未订正', '未登记', '已登记']);
    const firstRow = await page.locator('#homeworkStatsTables .homework-matrix tbody tr').first().innerText();
    assert.match(firstRow, /抄袭/);

    // Archiving a used status removes its registration button but keeps the
    // history label and count in the statistics.
    page.once('dialog', async dialog => {
      assert.match(dialog.message(), /已用于 1 条历史记录/);
      await dialog.accept();
    });
    await row('copy').locator('.homework-status-row-action').filter({ hasText: '停用' }).click();
    await page.waitForFunction(() => document.querySelector('.homework-status-row[data-status-id="copy"]')?.classList.contains('is-archived'));
    assert.equal(await student('01').locator('[data-status="copy"]').count(), 0);
    assert.equal(await student('01').locator('.homework-status-clear').count(), 1);
    await page.waitForFunction(() => [...document.querySelectorAll('#homeworkStatsTables .homework-assignment-table thead th')].some(th => th.textContent.includes('抄袭（停用）')));

    // An archived record can still be cleared for the current assignment.
    await student('01').locator('.homework-status-clear').click();
    await page.waitForFunction(() => document.querySelector('#homeworkSaveState')?.textContent === '已保存');
    assert.match(await page.locator('#homeworkCounts').innerText(), /已登记 1 \/ 4/);
    assert.equal(await student('01').locator('.homework-status-clear').isHidden(), true);

    // Restoring it brings the button back while the history is unchanged.
    await row('copy').locator('.homework-status-row-action').filter({ hasText: '恢复' }).click();
    await page.waitForFunction(() => !document.querySelector('.homework-status-row[data-status-id="copy"]')?.classList.contains('is-archived'));
    assert.equal(await student('01').locator('[data-status="copy"]').count(), 1);
    await student('01').locator('[data-status="copy"]').click();
    await page.waitForFunction(() => document.querySelector('#homeworkSaveState')?.textContent === '已保存');
    await page.waitForFunction(() => [...document.querySelectorAll('#homeworkStatsTables .homework-assignment-table thead th')].some(th => th.textContent === '抄袭'));

    // Unused statuses are deleted rather than archived.
    await page.locator('#newHomeworkStatusLabel').fill('临时');
    await page.locator('#createHomeworkStatusButton').click();
    await page.waitForFunction(() => document.querySelectorAll('.homework-status-row').length === 6);
    page.once('dialog', async dialog => {
      assert.match(dialog.message(), /确定删除“临时”/);
      await dialog.accept();
    });
    await page.locator('.homework-status-row').last().locator('.homework-status-row-action').filter({ hasText: '停用' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.homework-status-row').length === 5);
    await page.waitForFunction(() => ![...document.querySelectorAll('#homeworkStatsTables .homework-assignment-table thead th')]
      .some(th => th.textContent.includes('临时')));

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    const download = await downloadPromise;
    const csv = await fs.readFile(await download.path(), 'utf8');
    assert.match(csv, /日期,作业名称,优秀,抄袭,错多,未交,未订正,未登记,已登记/);
    assert.match(csv, /"=""01""",张三,抄袭,0,1,0,0,0,0/);
    assert.match(csv, /"=""02""",李四,未订正,0,0,0,0,1,0/);

    await page.screenshot({ path: path.join(output, 'desktop-status-settings.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
      && document.body.scrollWidth <= innerWidth + 1), true, 'status settings must fit on mobile');
    await page.screenshot({ path: path.join(output, 'mobile-status-settings.png'), fullPage: true });
    assert.deepEqual(errors, [], 'the admin page must not raise uncaught errors');
    console.log(JSON.stringify({ output, csv: download.suggestedFilename() }));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
