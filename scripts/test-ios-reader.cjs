const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const colors = ['0.8 0.1 0.1', '0.1 0.6 0.2', '0.1 0.3 0.8', '0.9 0.6 0.1', '0.6 0.1 0.7', '0.1 0.7 0.8'];
  const kids = [];
  colors.forEach((color, index) => {
    const page = objects.length + 1; kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${page + 1} 0 R >>`);
    const content = `${color} rg 0 0 595 842 re f\n1 1 1 rg 24 24 547 794 re f\n${color} rg 50 600 495 150 re f\n${Array.from({length:index + 1}, (_, i) => `50 ${550 - i * 50} 400 20 re f`).join('\n')}\n`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-ios-reader-proof'); await fs.mkdir(output, { recursive: true });
  let browser, viewerBrowser;
  try {
    browser = process.env.MYCLASS_WEBKIT ? await webkit.launch({headless:true}) : await chromium.launch({channel:'msedge',headless:true});
    if (process.env.MYCLASS_WEBKIT) viewerBrowser = await chromium.launch({channel:'msedge',headless:true});
    for (const viewport of [{width:390,height:844},{width:375,height:568},{width:768,height:1024},{width:844,height:390},{width:1180,height:820}]) {
      const context = await browser.newContext({ viewport, hasTouch:true, serviceWorkers:'block' });
      const errors = [];
      context.on('page', page => page.on('pageerror', error => { errors.push(error.message); console.error('Browser:',error.message); }));
      await context.addInitScript(() => {
        try {
          localStorage.setItem('myclass.ios.token', JSON.stringify('alice-test-token'));
          localStorage.setItem('myclass.ios.screen_orientation', JSON.stringify('landscape'));
        } catch { /* Opaque media frames have no storage. */ }
      });
      const item = {id:'reader',url:server.base+'/reader.pdf',title:'A4 连续文档与动画课件测试',createdAt:new Date().toISOString(),size:5000};
      await context.route('**/reader.pdf', route => route.fulfill({ contentType:'application/pdf',body:pdfFixture() }));
      await context.route('**/reader.pdf.metadata*', route => route.fulfill({json:{conversion:{slideCount:5,statePages:[1,1,3,4,4,5]},videos:[]}}));
      await context.route('**/api/courseware', route => route.fulfill({json:{items:[item]}}));
      const source = await fs.readFile(path.join(__dirname, '../web/ios/js/app.js'), 'utf8');
      await context.route('**/ios/js/app.js?*', route => route.fulfill({contentType:'application/javascript',body:source + '\nwindow.probe = {state,openCourseware,connectToRoom,showMenu,layoutRect,layoutPoint};'}));
      // Windows WebKit has no WebRTC; the classroom viewer runs in Edge while iOS uses WebKit.
      const viewerContext = viewerBrowser ? await viewerBrowser.newContext({serviceWorkers:'block'}) : context;
      if (viewerBrowser) {
        await viewerContext.route('**/reader.pdf', route => route.fulfill({contentType:'application/pdf',body:pdfFixture()}));
        await viewerContext.route('**/reader.pdf.metadata*', route => route.fulfill({json:{conversion:{slideCount:5,statePages:[1,1,3,4,4,5]},videos:[]}}));
      }
      const viewer = await viewerContext.newPage(); await viewer.setViewportSize({width:1280,height:800});
      await viewer.goto(server.base + '/'); await viewer.waitForFunction(() => !!state.roomCode).catch(async error => {
        await viewer.screenshot({path:path.join(output,'viewer-failure.png')}); throw error;
      });
      const code = await viewer.evaluate(() => state.roomCode);
      const phone = await context.newPage(); await phone.goto(server.base + '/ios/');
      await phone.waitForFunction(() => window.probe?.state.screen === 'Connect');
      assert.equal(await phone.evaluate(() => getComputedStyle(document.getElementById('orientationRoot')).transform), 'none', 'orientation follows system');
      await phone.locator('#manageCoursewareButton').click();
      const thumb = phone.locator('#cwListBody button.file-thumbnail'); await thumb.waitFor();
      const size = await thumb.boundingBox(); assert.ok(Math.abs(size.width/size.height - 16/9) < 0.01);
      await thumb.click();
      await phone.waitForFunction(() => document.querySelector('.document-preview'), null, { timeout: 5000 }).catch(async error => {
        console.error('preview debug', await phone.evaluate(() => ({ screen: probe.state.screen, root: Boolean(document.getElementById('orientationRoot')), body: document.getElementById('cwListBody')?.innerHTML.slice(0, 500), errors: window.__errors })));
        throw error;
      });
      await phone.waitForFunction(() => document.querySelectorAll('.document-page').length === 4 && document.querySelector('.document-page canvas[aria-label="第 1 页预览"]'));
      assert.equal(await phone.evaluate(() => probe.state.joined), false);
      const sample = await phone.locator('.document-page canvas').first().evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(5,5,1,1).data));
      assert.ok(sample[1] > sample[0] * 3, 'continuous reader uses final animation state of slide 1');
      await phone.locator('.document-pages').evaluate(list => { list.scrollTop = list.scrollHeight; });
      await phone.waitForFunction(() => /[34] \/ 4/.test(document.querySelector('.preview-status').textContent) && [...document.querySelectorAll('.document-page canvas')].at(-1).width > 0);
      await phone.screenshot({path:path.join(output,`continuous-${viewport.width}.png`)});
      await phone.locator('.document-preview .pill').click(); await phone.locator('#cwListBack').click();
      await phone.evaluate(code => probe.connectToRoom(code), code); await phone.waitForFunction(() => probe.state.joined);
      await phone.evaluate(() => {
        window.sent = []; const send = probe.state.signaling.send.bind(probe.state.signaling);
        probe.state.signaling.send = message => { sent.push(message); return send(message); };
      });
      await phone.evaluate(item => probe.openCourseware(item), item);
      await phone.waitForFunction(() => probe.state.cwPdf.doc && !probe.state.cwPdf.rendering && probe.state.cwBoard.enabled);
      await viewer.waitForFunction(() => state.courseware?.displayedPage === 1);
      await phone.locator('#cwPenButton').click();
      const bounds = await phone.evaluate(() => {
        const root = document.getElementById('orientationRoot');
        const side = document.querySelector('#viewCoursewarePlay > .cw-side');
        const nodes = ['cwPrevPage','cwNextPage','cwQuickPage','cwResetView','cwCloseButton','cwClearButton'];
        return {width:root.clientWidth,height:root.clientHeight,
          // 与 style.css 的手机横屏块一致：竖栏收窄到 8rem，控件排不下时在竖栏内部滚动
          landscapePhone:window.innerWidth>window.innerHeight&&window.innerHeight<=480,
          stage:probe.layoutRect(document.getElementById('cwStage')),
          side:{...probe.layoutRect(side),scrollHeight:side.scrollHeight,clientHeight:side.clientHeight},
          buttons:nodes.map(id => ({id,...probe.layoutRect(document.getElementById(id))}))};
      });
      assert.ok(bounds.stage.height >= 80, JSON.stringify(bounds));
      for (const button of bounds.buttons) {
        assert.ok(button.left >= 0 && button.right <= bounds.width+1, JSON.stringify(button));
        const bottom = bounds.landscapePhone ? bounds.side.top + bounds.side.scrollHeight : bounds.height;
        assert.ok(button.top >= 0 && button.bottom <= bottom+1, JSON.stringify(button));
      }
      if (bounds.landscapePhone) {
        assert.ok(bounds.side.bottom <= bounds.height+1 && bounds.side.right <= bounds.width+1, JSON.stringify(bounds.side));
        const reachable = await phone.evaluate(async () => {
          const side = document.querySelector('#viewCoursewarePlay > .cw-side');
          side.scrollTop = side.scrollHeight;
          await new Promise(resolve => requestAnimationFrame(resolve));
          const root = document.getElementById('orientationRoot').getBoundingClientRect();
          const button = document.getElementById('cwCloseButton').getBoundingClientRect();
          side.scrollTop = 0;
          return button.top >= root.top - 1 && button.bottom <= root.bottom + 1;
        });
        assert.ok(reachable, 'landscape phone can scroll to the close button');
      }
      // 旧 Safari（iPadOS 15.x 等）不支持 @container，只会命中 style.css 里的兜底网格：
      // 那套布局同样必须把翻页按钮留在屏幕内，否则底部会露出黑色舞台、按钮被挤出视口。
      if (viewport.width === 768) {
        const legacy = await phone.evaluate(async () => {
          const style = document.createElement('style');
          style.textContent = '#orientationRoot { container-type: normal !important; }';
          document.head.append(style);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const root = document.getElementById('orientationRoot').getBoundingClientRect();
          const close = document.getElementById('cwCloseButton').getBoundingClientRect();
          document.head.removeChild(style);
          await new Promise(resolve => requestAnimationFrame(resolve));
          return {inside:close.top >= root.top-1 && close.bottom <= root.bottom+1, closeBottom:Math.round(close.bottom), rootBottom:Math.round(root.bottom)};
        });
        assert.ok(legacy.inside, `container-query fallback keeps controls on screen ${JSON.stringify(legacy)}`);
      }
      await phone.screenshot({path:path.join(output,`a4-portrait-pen-${viewport.width}.png`)});
      // Draw a real pointer stroke in the current layout and check normalized wire coordinates.
      const target = await phone.evaluate(() => {
        const canvas = document.getElementById('cwPageCanvas'); const stage = document.getElementById('cwStage');
        const rect = canvas.getBoundingClientRect(), clip = stage.getBoundingClientRect();
        const x = (Math.max(rect.left,clip.left)+Math.min(rect.right,clip.right))/2;
        const y = (Math.max(rect.top,clip.top)+Math.min(rect.bottom,clip.bottom))/2;
        const point = probe.layoutPoint({x,y}), logical = probe.layoutRect(canvas);
        return {x,y,nx:(point.x-logical.left)/logical.width,ny:(point.y-logical.top)/logical.height};
      });
      await phone.mouse.move(target.x,target.y); await phone.mouse.down(); await phone.mouse.move(target.x+18,target.y+18,{steps:4}); await phone.mouse.up();
      const point = await phone.evaluate(() => sent.find(message => message.type === 'courseware.annotation' && message.action === 'begin')?.points[0]);
      assert.ok(point && Math.abs(point.x-target.nx)<0.01 && Math.abs(point.y-target.ny)<0.01, JSON.stringify({point,target}));
      await phone.locator('#cwQuickPage').click();
      await phone.waitForFunction(() => document.querySelector('.quick-page-preview canvas')?.width > 0);
      const before = await phone.evaluate(() => sent.filter(message => message.type === 'courseware.page').length);
      await phone.locator('.quick-page-panel input').evaluate(slider => {slider.value=2;slider.dispatchEvent(new Event('input',{bubbles:true}));});
      await phone.waitForFunction(() => document.querySelector('.quick-page-preview canvas')?.getAttribute('aria-label') === '第 4 页预览');
      assert.equal(await phone.evaluate(() => sent.filter(message => message.type === 'courseware.page').length),before);
      await phone.screenshot({path:path.join(output,`quick-page-${viewport.width}.png`)});
      await phone.locator('.quick-page-panel input').dispatchEvent('change');
      await viewer.waitForFunction(() => state.courseware?.displayedPage === 4);
      assert.equal(await phone.evaluate(() => probe.state.courseware.page),4,'commit first animation state of selected original slide');
      await phone.locator('#cwQuickPage').click(); await phone.keyboard.press('Escape');
      assert.equal(await phone.locator('.quick-page-modal').count(),0);
      await phone.locator('#cwLeaveButton').click();
      await phone.locator('#menuCourseware').click(); await phone.locator('#cwServerButton').click();
      const sentBeforePreview = await phone.evaluate(() => sent.length);
      await phone.locator('#cwListBody button.file-thumbnail').click();
      await phone.waitForFunction(() => document.querySelector('.document-page canvas')?.width > 0);
      assert.equal(await phone.evaluate(() => sent.length),sentBeforePreview,'independent preview sends no classroom messages');
      assert.equal(await viewer.evaluate(() => state.courseware.displayedPage),4);
      await phone.locator('.document-preview .pill').click(); await phone.locator('#cwListBack').click();
      await phone.locator('#menuResumeCourseware').click();
      await phone.waitForFunction(() => !probe.state.cwPdf.rendering);
      await phone.waitForTimeout(200);
      await phone.screenshot({path:path.join(output,`locked-landscape-${viewport.width}.png`)});
      await phone.setViewportSize({width:viewport.height,height:viewport.width});
      await phone.locator('#cwLeaveButton').click();
      await phone.locator('#menuDisconnect').click();
      assert.equal(await phone.evaluate(() => getComputedStyle(document.getElementById('orientationRoot')).transform), 'none');
      assert.deepEqual(errors,[]);
      await context.close();
      if (viewerBrowser) await viewerContext.close();
      console.log(`PASS ${viewport.width}x${viewport.height}: 16:9 thumbnails, final-state continuous reader, quick paging, A4 controls, orientation and ink`);
    }
    console.log('Screenshots: '+output);
  } finally { if (browser) await browser.close(); if (viewerBrowser) await viewerBrowser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
