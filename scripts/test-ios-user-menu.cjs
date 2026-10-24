const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-ios-user-menu-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    browser = process.env.MYCLASS_WEBKIT ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.addInitScript(() => {
      try { localStorage.setItem('myclass.ios.token', JSON.stringify('alice-test-token')); } catch { /* 空白文档没有 storage */ }
    });
    const phone = await context.newPage();
    await phone.goto(`${server.base}/ios/`);
    await phone.waitForFunction(() => !document.getElementById('viewConnect').hidden);
    assert.equal(await phone.locator('#switchUserButton').count(), 0, 'old switch-user button must be replaced');
    assert.equal((await phone.locator('#userManageButton').innerText()).trim(), '用户管理');

    await phone.locator('#userManageButton').click();
    assert.equal(await phone.locator('#userMenuDialog').isVisible(), true);
    assert.equal(await phone.locator('#userMenuDialog .user-menu-item').count(), 2);
    assert.deepEqual(await phone.locator('#userMenuDialog .user-menu-item-title').allInnerTexts(), ['后台管理', '切换用户']);
    const card = await phone.locator('#userMenuDialog .user-menu-card').boundingBox();
    assert.ok(card.x >= 0 && card.y >= 0 && card.x + card.width <= 390 && card.y + card.height <= 844, JSON.stringify(card));
    await phone.screenshot({ path: path.join(output, 'user-menu.png') });

    // 点遮罩可关闭，且焦点回到入口按钮
    await phone.mouse.click(8, 8);
    assert.equal(await phone.locator('#userMenuDialog').isVisible(), false);
    assert.equal(await phone.evaluate(() => document.activeElement?.id), 'userManageButton');

    // 后台管理：带登录态进入 admin.html，并可返回 iOS 端
    await phone.locator('#userManageButton').click();
    await phone.locator('#userMenuAdmin').click();
    await phone.waitForURL('**/admin.html?from=ios');
    assert.equal(await phone.evaluate(() => localStorage.getItem('admin_token')), 'alice-test-token');
    await phone.waitForFunction(() => !document.getElementById('mainPanel').hidden);
    await phone.locator('#homeButton').click();
    await phone.waitForURL('**/ios/');
    await phone.waitForFunction(() => !document.getElementById('viewConnect').hidden);
    assert.equal(await phone.evaluate(() => localStorage.getItem('admin_token')), null);

    // 切换用户：清空登录态并回到登录页
    await phone.locator('#userManageButton').click();
    await phone.locator('#userMenuSwitch').click();
    await phone.waitForFunction(() => !document.getElementById('viewAuth').hidden);
    assert.equal(await phone.evaluate(() => localStorage.getItem('myclass.ios.token')), null);
    assert.equal(await phone.evaluate(() => localStorage.getItem('admin_token')), null);
    assert.deepEqual(errors, []);
    console.log(`PASS: iOS 用户管理菜单（后台管理/切换用户）、登录态传递、返回 iOS、旧按钮移除。Screenshot: ${output}`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
