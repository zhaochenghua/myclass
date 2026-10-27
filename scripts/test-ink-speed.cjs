// 大屏端"速度笔锋"回归验证：
//   * 慢写段明显比快写段粗（笔迹按速度变细）；
//   * 起笔处收尖，比行笔段细；
//   * 本地采样点带上了相对时间戳 t，远端回放同样按 t 渲染。
// 用法：node scripts/test-ink-speed.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>'
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((s, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${s}\nendobj\n`;
  });
  const pos = Buffer.byteLength(data);
  data += 'xref\n0 4\n0000000000 65535 f \n'
    + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
  return data;
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    await page.route('**/ink-check.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfFixture() }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    await page.evaluate(base => openCourseware({ url: base + '/ink-check.pdf', page: 1, title: 'Ink check' }), server.base);
    await page.waitForFunction(() => state.courseware?.displayedPage === 1);
    await page.waitForTimeout(500);

    const measured = await page.evaluate(() => {
      // 一条横线：前段慢（4px/30ms），后段快（24px/8ms）
      const points = [];
      let x = 0.12;
      let t = 0;
      for (let i = 0; i < 26; i += 1) { points.push({ x, y: 0.5, t }); x += 0.006; t += 30; }
      for (let i = 0; i < 26; i += 1) { points.push({ x, y: 0.5, t }); x += 0.03; t += 8; }
      state.annotations.strokes = [{
        color: '#ff0000', width: 4, isEraser: false, mode: 'solid', lineMode: false,
        points, page: currentCoursewarePage()
      }];
      drawAnnotations();

      const canvas = document.getElementById('annotationCanvas');
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(1, rect.width);
      const ctx = canvas.getContext('2d');
      const thicknessAt = (cssX) => {
        // 每次都重新取像素：缩放后画布已经重绘，用第一次的快照会测到旧笔迹
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const px = Math.round(cssX * dpr);
        // 按 alpha 覆盖率累加，得到亚像素精度；整数游程在 4px 线宽上会四舍五入成一样粗
        let coverage = 0;
        for (let y = 0; y < canvas.height; y += 1) {
          const index = (y * canvas.width + px) * 4;
          const alpha = image[index + 3] / 255;
          if (image[index] > 90 && alpha > 0.03) coverage += alpha;
        }
        return Math.round(coverage * 100) / 100;
      };
      const videoRect = currentVideoContentRect();
      const at = (fraction) => videoRect.left - rect.left + videoRect.width * fraction;
      const before = {
        slow: thicknessAt(at(0.25)),
        fast: thicknessAt(at(0.8)),
        // 起笔是圆珠笔式的圆头：比行笔略细，但不能细成一个尖
        tip: thicknessAt(at(0.122)),
        mid: thicknessAt(at(0.5))
      };

      // 课件放大 2 倍后，同一笔的线宽应同比变粗（保持与页面的相对比例），而不是不变/变细
      state.imageView.scale = 2;
      applyCoursewareImageViewTransform();
      const zoomedRect = currentVideoContentRect();
      const atZoomed = (fraction) => zoomedRect.left - rect.left + zoomedRect.width * fraction;
      const zoomed = thicknessAt(atZoomed(0.5));
      const debug = {
        kind: currentContentKind(),
        baseRectWidth: videoRect.width,
        zoomedRectWidth: zoomedRect.width
      };
      state.imageView.scale = 1;
      applyCoursewareImageViewTransform();
      return { ...before, zoomed, debug, canvasWidth: canvas.width };
    });
    assert.ok(measured.canvasWidth > 0, '标注画布未初始化');
    assert.ok(measured.slow >= 3, `慢写段没有墨迹: ${JSON.stringify(measured)}`);
    assert.ok(measured.slow > measured.fast, `快写段没有变细: ${JSON.stringify(measured)}`);
    assert.ok(measured.slow <= measured.fast * 2, `快慢段粗细相差过大: ${JSON.stringify(measured)}`);
    assert.ok(measured.tip >= measured.slow * 0.4, `起笔不是圆头（太尖）: ${JSON.stringify(measured)}`);
    assert.ok(measured.tip <= measured.slow, `起笔比行笔还粗: ${JSON.stringify(measured)}`);
    assert.ok(measured.zoomed >= measured.mid * 1.7, `放大后笔迹没有变粗: ${JSON.stringify(measured)}`);
    assert.ok(measured.zoomed >= measured.slow * 1.7, `放大后笔迹没有变粗: ${JSON.stringify(measured)}`);

    // 第一笔锚定：先把课件放大 3 倍再落笔，宽度按 档位/3 折算（屏幕上与 1x 时一样粗）
    const anchored = await page.evaluate(async () => {
      state.annotations.strokes = [];
      state.annotations.tool = 'pen';
      state.annotations.penWidth = 6;
      state.imageView.scale = 3;
      applyCoursewareImageViewTransform();
      const canvas = document.getElementById('annotationCanvas');
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      const rect = canvas.getBoundingClientRect();
      const fire = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 78, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons, clientX: x, clientY: y
      }));
      const y = rect.height * 0.5;
      fire('pointerdown', rect.width * 0.4, y, 1);
      for (let i = 1; i <= 20; i += 1) fire('pointermove', rect.width * 0.4 + i * 8, y, 1);
      fire('pointerup', rect.width * 0.4 + 160, y, 0);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const stroke = state.annotations.strokes[state.annotations.strokes.length - 1];
      const result = { width: stroke?.width, inkZoom: stroke?.inkZoom };
      state.imageView.scale = 1;
      applyCoursewareImageViewTransform();
      return result;
    });
    assert.ok(Math.abs(anchored.inkZoom - 3) < 0.01, `锚定缩放应为 3: ${JSON.stringify(anchored)}`);
    assert.ok(Math.abs(anchored.width - 2) < 0.1, `放大 3 倍后宽度应约为 2: ${JSON.stringify(anchored)}`);

    // 输入链路：真实指针事件也要带上相对时间戳
    const captured = await page.evaluate(async () => {
      state.annotations.strokes = [];
      state.annotations.tool = 'pen';
      const canvas = document.getElementById('annotationCanvas');
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      const rect = canvas.getBoundingClientRect();
      const fire = (type, clientX, clientY, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 91, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons, clientX, clientY
      }));
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      fire('pointerdown', rect.left + 200, rect.top + 300, 1);
      for (let i = 1; i <= 6; i += 1) {
        await wait(25);
        fire('pointermove', rect.left + 200 + i * 12, rect.top + 300, 1);
      }
      await wait(25);
      fire('pointerup', rect.left + 272, rect.top + 300, 0);
      const stroke = state.annotations.strokes.at(-1);
      return {
        count: state.annotations.strokes.length,
        times: stroke ? stroke.points.map(point => point.t) : []
      };
    });
    assert.equal(captured.count, 1, '指针事件没有生成笔画');
    assert.ok(captured.times.length >= 5, `采样点太少: ${captured.times.length}`);
    assert.equal(captured.times[0], 0, '首点时间戳应为 0');
    for (let i = 1; i < captured.times.length; i += 1) {
      assert.ok(captured.times[i] > captured.times[i - 1], `时间戳未递增: ${captured.times}`);
    }

    // 防误触：手写笔抬笔后的屏蔽窗口内，手指 / 掌托落屏不应起新笔
    const palm = await page.evaluate(async () => {
      const canvas = document.getElementById('annotationCanvas');
      state.annotations.strokes = [];
      state.annotations.tool = 'pen';
      const rect = canvas.getBoundingClientRect();
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const fire = (type, clientX, clientY, pointerType) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: pointerType === 'pen' ? 71 : 72,
        pointerType, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY
      }));
      fire('pointerdown', rect.left + 300, rect.top + 200, 'pen');
      for (let i = 1; i <= 5; i += 1) { await wait(20); fire('pointermove', rect.left + 300 + i * 10, rect.top + 200, 'pen'); }
      fire('pointerup', rect.left + 350, rect.top + 200, 'pen');
      // 抬笔后 100ms，掌托落下并滑动：不能被当成新的一笔
      await wait(100);
      fire('pointerdown', rect.left + 500, rect.top + 400, 'touch');
      for (let i = 1; i <= 5; i += 1) { await wait(20); fire('pointermove', rect.left + 500 + i * 12, rect.top + 400, 'touch'); }
      fire('pointerup', rect.left + 560, rect.top + 400, 'touch');
      await wait(80);
      return { strokes: state.annotations.strokes.length };
    });
    assert.equal(palm.strokes, 1, `手写笔抬笔后掌托被误判成笔画: ${JSON.stringify(palm)}`);
    assert.deepEqual(errors, [], '页面存在 JS 异常');

    await page.screenshot({ path: path.join(os.tmpdir(), 'myclass-ink-speed.png') });
    console.log('PASS 大屏速度笔锋:', JSON.stringify(measured), '时间戳', captured.times.join(','));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
