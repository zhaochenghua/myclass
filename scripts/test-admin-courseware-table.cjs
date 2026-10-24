const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

const items = [
  { id: 'cw-10', userId: 'alice', owner: '张三', title: '数学 10', fileName: 'math10.pdf', size: 2 * 1024, createdAt: '2026-10-01T08:00:00.000Z' },
  { id: 'cw-2', userId: 'admin', owner: '所有人', title: '数学 2', fileName: '16_20403IMG_20250316_204035123_abcdefghijklmnop.jpg', size: 1024 * 1024, createdAt: '2026-10-03T08:00:00.000Z' },
  { id: 'cw-cn', userId: 'bob', owner: '李四', title: '语文', fileName: 'chinese.pdf', size: 500 * 1024, createdAt: '2026-10-02T08:00:00.000Z' }
];

const titles = page => page.locator('#coursewareTableBody tr td:first-child').allInnerTexts();

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-admin-courseware-table-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('admin_token', 'admin-test-token'));
    await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 'admin', username: 'admin_test', role: 'admin' } }));
    await page.route('**/api/admin/**', route => route.fulfill({ json: { error: 'not used by this test' } }));
    await page.route('**/api/courseware*', route => route.fulfill({ json: { items } }));
    await page.goto(`${server.base}/admin.html`);
    await page.getByRole('button', { name: '课件管理', exact: true }).click();
    await page.waitForSelector('#coursewareTableBody tr');

    assert.deepEqual(await titles(page), ['数学 10', '数学 2', '语文'], 'initial order must match the server response');
    const titleHeader = page.locator('#coursewareTable thead th[data-sort-key="title"]');
    await titleHeader.locator('.sort-button').click();
    assert.deepEqual(await titles(page), ['数学 2', '数学 10', '语文'], 'title ascending must use numeric-aware locale ordering');
    assert.equal(await titleHeader.getAttribute('aria-sort'), 'ascending');
    await titleHeader.locator('.sort-button').click();
    assert.deepEqual(await titles(page), ['语文', '数学 10', '数学 2'], 'second title click must reverse the order');
    assert.equal(await titleHeader.getAttribute('aria-sort'), 'descending');

    const sizeHeader = page.locator('#coursewareTable thead th[data-sort-key="size"]');
    await sizeHeader.locator('.sort-button').click();
    assert.deepEqual(await titles(page), ['数学 2', '语文', '数学 10'], 'size must sort by bytes, not by formatted text');
    assert.equal(await sizeHeader.getAttribute('aria-sort'), 'descending');

    const createdHeader = page.locator('#coursewareTable thead th[data-sort-key="createdAt"]');
    await createdHeader.locator('.sort-button').click();
    assert.deepEqual(await titles(page), ['数学 2', '语文', '数学 10'], 'upload time must sort newest first on first click');
    assert.equal(await createdHeader.getAttribute('aria-sort'), 'descending');

    const titleWidthBefore = await page.locator('#coursewareTable col[data-col="title"]').evaluate(col => parseFloat(col.style.width));
    const handle = page.locator('#coursewareTable thead th[data-sort-key="title"] .column-resizer');
    const box = await handle.boundingBox();
    assert.ok(box, 'title column must expose a resize handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const titleWidthAfter = await page.locator('#coursewareTable col[data-col="title"]').evaluate(col => parseFloat(col.style.width));
    assert.ok(titleWidthAfter >= titleWidthBefore + 70, `dragging right must widen the title column (${titleWidthBefore} -> ${titleWidthAfter})`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('myclass.admin.courseware.widths.v1')));
    assert.ok(saved.title >= titleWidthBefore + 70, 'column width must be written to localStorage');

    await page.reload();
    await page.getByRole('button', { name: '课件管理', exact: true }).click();
    await page.waitForSelector('#coursewareTableBody tr');
    assert.deepEqual(await titles(page), ['数学 2', '语文', '数学 10'], 'sort choice must survive a reload');
    assert.equal(await page.locator('#coursewareTable thead th[data-sort-key="createdAt"]').getAttribute('aria-sort'), 'descending');
    const restoredWidth = await page.locator('#coursewareTable col[data-col="title"]').evaluate(col => parseFloat(col.style.width));
    assert.equal(restoredWidth, saved.title, 'column width must survive a reload');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'resized table must stay inside the page on mobile');
    const fileNameCell = page.locator('#coursewareTableBody td:nth-child(2)').first();
    const fileNameStyle = await fileNameCell.evaluate(element => {
      const style = getComputedStyle(element);
      return { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
    });
    assert.equal(fileNameStyle.overflow, 'hidden', 'long file names must not spill into neighbouring columns');
    assert.equal(fileNameStyle.textOverflow, 'ellipsis');
    assert.equal(fileNameStyle.whiteSpace, 'nowrap');
    await page.evaluate(() => { document.querySelector('#tab-courseware .table-scroll').scrollLeft = 220; });
    await page.screenshot({ path: path.join(output, 'mobile-scrolled.png'), fullPage: true });

    const userPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    userPage.on('pageerror', error => errors.push(error.message));
    await userPage.addInitScript(() => localStorage.setItem('admin_token', 'alice-test-token'));
    await userPage.route('**/api/auth/me', route => route.fulfill({ json: { id: 'alice', username: 'alice_test', role: 'user' } }));
    await userPage.route('**/api/courseware*', route => route.fulfill({ json: { items } }));
    await userPage.goto(`${server.base}/admin.html`);
    await userPage.getByRole('button', { name: '我的课件', exact: true }).click();
    await userPage.waitForSelector('#coursewareTableBody tr');
    assert.equal(await userPage.locator('#ownerTh').isHidden(), true, 'owner column must stay hidden for teachers');
    assert.equal(await userPage.locator('#coursewareTableBody tr').first().locator('td').count(), 5, 'teacher table must not render the owner cell');
    await userPage.close();

    assert.deepEqual(errors, []);
    console.log(`PASS: courseware sorting (title/size/time), resizable columns, persistence, mobile containment, teacher view. Screenshots: ${output}`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
