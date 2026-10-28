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
  const output = path.join(os.tmpdir(), 'myclass-admin-homework-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    const { item: teachingClass } = await (await server.api('/classes', 'alice', 'POST', { name: '七年级（1）班' })).json();
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
    await page.waitForSelector('#classHomework:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#homeworkEmpty')?.textContent.includes('还没有作业登记'));

    await page.locator('#newHomeworkTitle').fill('第一单元练习');
    await page.getByRole('button', { name: '新建并开始登记' }).click();
    await page.waitForSelector('.homework-student');
    const firstTitle = await page.locator('#classHomeworkTitle').textContent();
    assert.ok(firstTitle.includes('第一单元练习'), 'new assignment must become the active one');
    assert.equal(await page.locator('.homework-student').count(), 4, 'one row per student');

    const student = number => page.locator(`.homework-student[data-number="${number}"]`);
    const waitSaved = () => page.waitForFunction(() => document.querySelector('#homeworkSaveState')?.textContent === '已保存');
    await student('01').locator('[data-status="excellent"]').click();
    await student('02').locator('[data-status="copy"]').click();
    await student('03').locator('[data-status="wrong"]').click();
    await student('04').locator('[data-status="missing"]').click();
    await waitSaved();
    assert.match(await page.locator('#homeworkCounts').textContent(), /已登记 4 \/ 4 · 优秀 1 · 涉抄 1 · 错多 1 · 未交 1/);
    assert.equal(await student('01').locator('[data-status="excellent"]').getAttribute('aria-pressed'), 'true');

    // Clicking the active status again clears it.
    await student('01').locator('[data-status="excellent"]').click();
    await waitSaved();
    assert.match(await page.locator('#homeworkCounts').textContent(), /已登记 3 \/ 4/);
    assert.equal(await student('01').locator('[data-status="excellent"]').getAttribute('aria-pressed'), 'false');
    await student('01').locator('[data-status="excellent"]').click();
    await waitSaved();

    const firstList = await (await server.api(`/classes/${teachingClass.id}/homework`, 'alice')).json();
    assert.deepEqual(firstList.items[0].counts, {
      excellent: 1, copy: 1, wrong: 1, missing: 1, recorded: 4, unmarked: 0, total: 4
    });

    await page.locator('#newHomeworkTitle').fill('第二单元练习');
    await page.getByRole('button', { name: '新建并开始登记' }).click();
    await page.waitForFunction(() => document.querySelector('#classHomeworkTitle')?.textContent.includes('第二单元练习'));
    await page.waitForFunction(() => document.querySelectorAll('.homework-student').length === 4);
    assert.equal(await page.locator('.homework-student [aria-pressed="true"]').count(), 0, 'a new assignment starts unmarked');

    await student('01').locator('[data-status="missing"]').click();
    await student('02').locator('[data-status="excellent"]').click();
    await student('03').locator('[data-status="excellent"]').click();
    await waitSaved();
    assert.match(await page.locator('#homeworkCounts').textContent(), /已登记 3 \/ 4/);

    const stats = await (await server.api(`/classes/${teachingClass.id}/homework/stats`, 'alice')).json();
    assert.deepEqual(stats.totals, { excellent: 3, copy: 1, wrong: 1, missing: 2, recorded: 7, unmarked: 1, total: 8 });
    assert.deepEqual(stats.students[0].records, ['excellent', 'missing']);

    await page.getByRole('button', { name: '历次作业统计', exact: true }).click();
    await page.waitForSelector('#homeworkStats:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#homeworkStatsTables .homework-assignment-table tbody tr').length === 2);
    const summaryText = await page.locator('#homeworkStatsSummary').innerText();
    assert.match(summaryText, /作业次数\s*2/);
    assert.match(summaryText, /已登记\s*7 \/ 8/);
    assert.match(summaryText, /优秀\s*3/);
    assert.match(summaryText, /涉抄\s*1/);
    assert.match(summaryText, /错多\s*1/);
    assert.match(summaryText, /未交\s*2/);
    assert.match(summaryText, /未登记\s*1/);
    const firstStudentRow = page.locator('#homeworkStatsTables .homework-matrix tbody tr').first();
    const firstStudentText = await firstStudentRow.innerText();
    assert.match(firstStudentText, /01\s*张三/);
    assert.match(firstStudentText, /优秀/);
    assert.match(firstStudentText, /未交/);
    await page.screenshot({ path: path.join(output, 'desktop-stats.png'), fullPage: true });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const csv = await fs.readFile(downloadPath, 'utf8');
    assert.match(download.suggestedFilename(), /作业统计/);
    assert.match(csv, /日期,作业名称,优秀,涉抄,错多,未交,未登记,已登记/);
    assert.match(csv, /"=""01""",张三,优秀,未交,1,0,0,1,0/);
    assert.match(csv, /合计,,3,1,1,2,1,7\/8/);

    // Reload keeps the newest assignment selected and the saved statuses intact.
    await page.reload();
    await page.getByRole('button', { name: '任教班级', exact: true }).click();
    await page.waitForSelector('.homework-student');
    await page.waitForFunction(() => document.querySelector('#classHomeworkTitle')?.textContent.includes('第二单元练习'));
    assert.equal(await student('01').locator('[data-status="missing"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#teachingClassList button').innerText(), /2 次作业/);
    assert.equal(await page.locator('#homeworkDateWarning').isHidden(), true, 'a today assignment needs no date warning');

    // Switching to the older assignment shows its own records.
    const options = await page.locator('#homeworkSelect option').allTextContents();
    assert.equal(options.length, 2);
    const firstAssignmentLabel = options.find(label => label.includes('第一单元练习'));
    await page.locator('#homeworkSelect').selectOption({ label: firstAssignmentLabel });
    await page.waitForFunction(() => document.querySelector('#classHomeworkTitle')?.textContent.includes('第一单元练习'));
    assert.equal(await student('01').locator('[data-status="excellent"]').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(output, 'desktop-register.png'), fullPage: true });

    // Selecting an assignment from another day warns before the teacher
    // accidentally records today's homework into an older session.
    const previous = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pad = value => String(value).padStart(2, '0');
    const yesterday = `${previous.getFullYear()}-${pad(previous.getMonth() + 1)}-${pad(previous.getDate())}`;
    await server.api(`/classes/${teachingClass.id}/homework`, 'alice', 'POST', { title: '昨日作业', date: yesterday });
    await page.reload();
    await page.getByRole('button', { name: '任教班级', exact: true }).click();
    await page.waitForSelector('.homework-student');
    const reloadedOptions = await page.locator('#homeworkSelect option').allTextContents();
    const yesterdayLabel = reloadedOptions.find(label => label.includes('昨日作业'));
    assert.ok(yesterdayLabel, 'the older session must be selectable');
    await page.locator('#homeworkSelect').selectOption({ label: yesterdayLabel });
    await page.waitForFunction(() => document.querySelector('#classHomeworkTitle')?.textContent.includes('昨日作业'));
    await page.waitForSelector('#homeworkDateWarning:not([hidden])');
    assert.match(await page.locator('#homeworkDateWarning').innerText(), /当前选中的是 .* 的作业/);

    await page.getByRole('button', { name: '历次作业统计', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#homeworkStatsTables .homework-assignment-table tbody tr').length === 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
      && document.body.scrollWidth <= innerWidth + 1), true,
      'the homework panel and statistics must stay inside the viewport on mobile');
    await page.screenshot({ path: path.join(output, 'mobile-stats.png'), fullPage: true });
    assert.deepEqual(errors, [], 'the admin page must not raise uncaught errors');
    console.log(JSON.stringify({ output, csv: download.suggestedFilename() }));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
