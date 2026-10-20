// Native TV regression: real PPTX extraction, animation mapping and playback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('../server/node_modules/ws');
const { PDFDocument, rgb } = require('pdf-lib');
const sharp = require('sharp');
const { startTestServer } = require('../server/testSupport');
const { zip, fixtureFiles } = require('../server/testFixtures/pptxVideoFixture');
const { XMLParser } = require('../server/node_modules/fast-xml-parser');

const adb = process.env.ADB || 'C:/Users/zch/.local/android-sdk/platform-tools/adb.exe';
const helpers = process.env.ANDROID_DEV || 'C:/Users/zch/.local/android-dev';
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const output = path.resolve(process.env.TV_TEST_OUTPUT || 'android/AndroidStudioProject/tv/build/evidence/embedded');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shell = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const key = code => shell('shell', 'input', 'keyevent', String(code));
const ps = args => execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true });
function controls() {
  // Reuse ui.ps1's XML to avoid launching a second UiAutomation process per read.
  const raw = ps(['-Command', `. '${path.join(helpers, 'ui.ps1').replaceAll("'", "''")}' -Serial '${serial.replaceAll("'", "''")}' | Out-Null; $xml`]);
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
    .parse(raw.slice(raw.indexOf('<?xml'), raw.lastIndexOf('</hierarchy>') + 12));
  const rows = [];
  const visit = node => {
    if (!node) return;
    for (const item of Array.isArray(node) ? node : [node]) { rows.push(item); visit(item.node); }
  };
  visit(parsed.hierarchy.node);
  return rows;
}
function click(node) {
  assert.ok(node, 'UI control exists');
  const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number);
  shell('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
}
function tap(name) { click(controls().find(n => n.text === name || n['content-desc'] === name)); }
async function waitFor(fn, timeout = 25000) {
  const start = Date.now();
  do { const value = await fn(); if (value) return value; await pause(250); } while (Date.now() - start < timeout);
  throw new Error('Timed out: ' + fn.toString());
}
async function shot(name) {
  const file = path.join(output, name + '.png');
  ps(['-File', path.join(helpers, 'shot.ps1'), '-Serial', serial, '-Out', file]);
  return file;
}
async function pixels(file, predicate) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) if (predicate(data[i], data[i + 1], data[i + 2])) count++;
  return count;
}
async function setEndpoint(url) {
  tap('设置'); tap('服务器地址');
  click(controls().find(n => n.class === 'android.widget.EditText'));
  shell('shell', 'input', 'keycombination', '113', '29'); key(67);
  shell('shell', 'input', 'text', url);
  if (!controls().some(n => n.class === 'android.widget.EditText' && n.text === url)) {
    key(204); shell('shell', 'input', 'keycombination', '113', '29'); key(67);
    shell('shell', 'input', 'text', url);
  }
  key(4);
  assert.ok(controls().some(n => n.class === 'android.widget.EditText' && n.text === url), 'Exact server URL');
  tap('保存');
  return waitFor(() => controls().find(n => /^\d{4}$/.test(n.text))?.text);
}
async function connect(url) {
  const ws = new WebSocket(url); ws.messages = [];
  ws.on('message', raw => ws.messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  ws.sendJson = value => ws.send(JSON.stringify(value));
  ws.take = predicate => waitFor(() => {
    const i = ws.messages.findIndex(typeof predicate === 'string' ? m => m.type === predicate : predicate);
    return i < 0 ? null : ws.messages.splice(i, 1)[0];
  });
  return ws;
}
const progress = () => {
  const node = controls().find(n => /(?:播放中|已暂停).*\d+ \/ \d+ 秒/.test(n.text));
  if (!node) return null;
  const [, position, duration] = node.text.match(/(\d+) \/ (\d+) 秒/);
  return { position: +position, duration: +duration, playing: node.text.includes('播放中') };
};

async function main() {
  await fs.mkdir(output, { recursive: true });
  shell('logcat', '-c');
  const server = await startTestServer();
  let teacher;
  try {
    const root = path.join(server.directory, 'courseware');
    await fs.mkdir(root, { recursive: true });
    const pdf = await PDFDocument.create();
    for (const color of [rgb(.8, .12, .18), rgb(.05, .5, .4), rgb(.3, .3, .7)]) {
      pdf.addPage([960, 540]).drawRectangle({ x: 0, y: 0, width: 960, height: 540, color });
    }
    await fs.writeFile(path.join(root, 'tv-embedded.pdf'), await pdf.save());
    const mp4 = path.join(root, 'tv-video.mp4');
    execFileSync(process.env.FFMPEG || 'C:/ffmpeg/bin/ffmpeg.exe', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-movflags', '+faststart', mp4], { windowsHide: true });
    await fs.writeFile(path.join(root, 'tv-embedded.pptx'), zip(fixtureFiles(await fs.readFile(mp4))));
    const url = '/myclass/public/courseware/tv-embedded.pdf';
    await fs.writeFile(path.join(root, 'index.json'), JSON.stringify([{
      id: 'tv-embedded', title: 'TV Embedded Test', userId: 'alice', url,
      originalUrl: '/myclass/public/courseware/tv-embedded.pptx', conversion: { statePages: [1, 1, 2] }
    }]));
    const code = await setEndpoint(server.base.replace('127.0.0.1', '10.0.2.2') + '/');
    const appPid = shell('shell', 'pidof', 'cn.edu.nb3.myclass.tv').trim();
    teacher = await connect(server.base.replace('http:', 'ws:') + '/ws');
    teacher.sendJson({ type: 'teacher.join', code, token: 'alice-test-token' });
    await teacher.take('join.accepted');
    console.log('PASS: isolated classroom and authenticated teacher');
    const action = (action, index = 0, target = url) => teacher.sendJson({ type: 'courseware.embedded-video', action, index, url: target });
    const opened = () => teacher.take(m => m.type === 'viewer.embedded-video' && m.action === 'open');
    const closed = () => teacher.take(m => m.type === 'viewer.embedded-video' && m.action === 'close');
    const page = number => teacher.take(m => m.type === 'courseware.state' && m.page === number && m.pageCount === 3);

    // Send immediately: metadata and PDF may still be loading. Physical page 2 is original slide 1.
    teacher.sendJson({ type: 'courseware.open', url, title: 'TV Embedded Test', page: 2 });
    action('open');
    assert.equal((await opened()).index, 0); await page(2);
    await waitFor(() => { const p = progress(); return p?.playing && p.duration >= 89; });
    const moving1 = await shot('01-embedded-playing');
    await pause(1300);
    const moving2 = await shot('02-embedded-moving');
    assert.ok(await pixels(moving1, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 100) > 200000, 'Decoded video pixels');
    const first = await sharp(moving1).resize(320, 200).raw().toBuffer();
    const second = await sharp(moving2).resize(320, 200).raw().toBuffer();
    assert.ok(first.some((v, i) => Math.abs(v - second[i]) > 60), 'Video changes between frames');
    console.log('PASS: PPTX media extracted, animation page mapped, queued open and moving H.264/AAC decoded');

    action('pause');
    await waitFor(() => { const p = progress(); return p && !p.playing; });
    const before = progress().position;
    await pause(1200); assert.ok(Math.abs(progress().position - before) <= 1, 'Paused time stable');
    action('forward');
    await waitFor(() => { const p = progress(); return p && p.position >= before + 8; });
    action('back');
    await waitFor(() => { const p = progress(); return p && p.position <= before + 2; });
    action('play'); await waitFor(() => progress()?.playing);
    action('close'); await closed();
    console.log('PASS: phone pause, play, +10/-10 seconds and close');

    teacher.sendJson({ type: 'courseware.annotation', action: 'begin', page: 2, strokeId: 'ink', color: '#ffd166', width: 12, points: [{ x: .1, y: .1 }] });
    teacher.sendJson({ type: 'courseware.annotation', action: 'points', page: 2, strokeId: 'ink', points: [{ x: .9, y: .1 }] });
    teacher.sendJson({ type: 'courseware.annotation', action: 'end', page: 2, strokeId: 'ink' });
    await pause(400);
    const inkPixels = file => pixels(file, (r, g, b) => r > 220 && g > 160 && b < 130);
    const inkBefore = await inkPixels(await shot('03-pdf-ink-before'));
    assert.ok(inkBefore > 2000);
    // Show toolbar via a click on the actual PDF node obtained from UI inspection.
    tap('课件画面'); tap('本页视频'); await opened();
    await waitFor(() => progress()?.playing);
    tap('暂停视频'); await waitFor(() => { const p = progress(); return p && !p.playing; });
    tap('播放视频'); await waitFor(() => progress()?.playing);
    tap('返回课件'); await closed();
    const inkAfter = await inkPixels(await shot('04-pdf-ink-preserved'));
    assert.equal(inkAfter, inkBefore, 'Original PDF page and annotations preserved exactly');
    console.log('PASS: TV launcher, native controls and unchanged PDF annotations on return');

    action('open', 199); await pause(400);
    assert.ok(!controls().some(n => n['content-desc'] === '返回课件'), 'Unknown clip index rejected');
    action('open'); await opened(); await waitFor(() => progress()?.playing);
    teacher.sendJson({ type: 'courseware.page', page: 3 }); await closed(); await page(3);
    if (!controls().some(n => n.text === '结束展示')) tap('课件画面');
    assert.ok(!controls().some(n => n['content-desc'] === '本页视频'), 'Original slide 2 has no video');
    action('open'); await pause(500);
    assert.ok(!controls().some(n => n['content-desc'] === '返回课件'), 'Video from another slide rejected');
    await shot('05-no-video-on-slide-two');
    teacher.sendJson({ type: 'courseware.page', page: 1 }); await page(1);
    if (!controls().some(n => n['content-desc'] === '本页视频')) tap('课件画面');
    tap('本页视频'); await opened(); await waitFor(() => progress()?.playing);
    // The room has no presentation after close, so the server drops overlay acknowledgements.
    teacher.sendJson({ type: 'courseware.close' });
    await waitFor(() => controls().some(n => n.text === code));
    assert.ok(!controls().some(n => n['content-desc'] === '返回课件'), 'Video overlay closed with presentation');
    console.log('PASS: invalid clip and wrong-slide commands rejected; page/document changes stop video');

    teacher.sendJson({ type: 'courseware.open', url: '/myclass/public/courseware/tv-video.mp4', title: 'Standalone video' });
    await teacher.take(m => m.type === 'courseware.video.state' && m.playing && m.duration > 80);
    teacher.sendJson({ type: 'courseware.video.control', action: 'pause' });
    await teacher.take(m => m.type === 'courseware.video.state' && !m.playing && m.duration > 80);
    teacher.sendJson({ type: 'courseware.video.control', action: 'seek', position: 20 });
    await teacher.take(m => m.type === 'courseware.video.state' && m.position >= 19);
    teacher.sendJson({ type: 'courseware.close' });
    console.log('PASS: standalone video playback, pause and seek regression');
    const logs = shell('logcat', '-d');
    const appLogs = shell('logcat', '-d', '--pid=' + appPid);
    await fs.writeFile(path.join(output, 'logcat.txt'), logs);
    await fs.writeFile(path.join(output, 'app-logcat.txt'), appLogs);
    assert.equal(shell('shell', 'pidof', 'cn.edu.nb3.myclass.tv').trim(), appPid, 'TV process stayed alive');
    assert.ok(!/FATAL EXCEPTION/.test(appLogs) && !/ANR in cn\.edu\.nb3\.myclass\.tv/.test(logs), 'No app crash or ANR');
    console.log('PASS: no TV FATAL EXCEPTION or ANR');
  } catch (error) {
    console.error('Original test failure:', error.message);
    await shot('failure'); await fs.writeFile(path.join(output, 'failure-logcat.txt'), shell('logcat', '-d'));
    throw error;
  } finally {
    teacher?.terminate();
    try {
      shell('shell', 'am', 'force-stop', 'cn.edu.nb3.myclass.tv');
      shell('shell', 'am', 'start', '-n', 'cn.edu.nb3.myclass.tv/.MainActivity');
      await waitFor(() => controls().some(n => n.text === 'MyClass 大屏'));
      await setEndpoint('https://sz.imst.xyz/myclass/');
      await shot('06-production-restored');
    } finally { await server.close(); }
  }
  console.log('ALL EMBEDDED VIDEO CHECKS PASSED: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
