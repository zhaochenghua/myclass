// End-to-end native TV validation. Requires ws (server), playwright, pdf-lib, sharp,
// PowerShell 7, ffmpeg and the Android tools described in the TV README.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('../server/node_modules/ws');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { startTestServer } = require('../server/testSupport');

const adb = process.env.ADB || 'C:/Users/zch/.local/android-sdk/platform-tools/adb.exe';
const helpers = process.env.ANDROID_DEV || 'C:/Users/zch/.local/android-dev';
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const output = path.resolve(process.env.TV_TEST_OUTPUT || 'android/AndroidStudioProject/tv/build/evidence');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shell = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true });
const key = code => shell('shell', 'input', 'keyevent', String(code));
const ps = args => execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true });

function controls() {
  // Always obtain the project's UI listing before operating coordinates.
  ps(['-File', path.join(helpers, 'ui.ps1'), '-Serial', serial]);
  const rows = ps(['-Command', `
    $raw = (& '${adb}' -s '${serial}' exec-out uiautomator dump /dev/tty) -join ''
    $start = $raw.IndexOf('<?xml'); $end = $raw.IndexOf('</hierarchy>') + 12
    [xml]$document = $raw.Substring($start, $end - $start)
    @($document.SelectNodes('//node') | ForEach-Object {
      [pscustomobject]@{ text=$_.GetAttribute('text'); desc=$_.GetAttribute('content-desc');
        bounds=$_.GetAttribute('bounds'); focused=$_.GetAttribute('focused'); class=$_.GetAttribute('class') }
    }) | ConvertTo-Json -Compress
  `]);
  return JSON.parse(rows);
}
function tap(name) {
  const node = controls().find(n => n.text === name || n.desc === name);
  assert.ok(node, `Missing control: ${name}`);
  const b = node.bounds.match(/\d+/g).map(Number);
  shell('shell', 'input', 'tap', String(Math.round((b[0] + b[2]) / 2)), String(Math.round((b[1] + b[3]) / 2)));
}
async function waitUi(predicate, timeout = 20000) {
  const start = Date.now();
  do {
    const rows = controls();
    const result = predicate(rows);
    if (result) return result;
    await sleep(400);
  } while (Date.now() - start < timeout);
  throw new Error('Timed out waiting for TV UI');
}
async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  ps(['-File', path.join(helpers, 'shot.ps1'), '-Serial', serial, '-Out', file]);
  return file;
}
async function pixels(file, predicate) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) if (predicate(data[i], data[i + 1], data[i + 2])) count++;
  return count;
}
async function endpoint(url) {
  key(82); await sleep(200); tap('服务器地址');
  await sleep(200);
  const edit = controls().find(n => n.class === 'android.widget.EditText');
  assert.ok(edit, 'Server URL field');
  const b = edit.bounds.match(/\d+/g).map(Number);
  shell('shell', 'input', 'tap', String(Math.round((b[0] + b[2]) / 2)), String(Math.round((b[1] + b[3]) / 2)));
  await sleep(400);
  shell('shell', 'input', 'keycombination', '113', '29'); // Android emulator: Ctrl+A.
  key(67);
  shell('shell', 'input', 'text', url);
  if (!controls().some(n => n.class === 'android.widget.EditText' && n.text === url)) {
    key(204); // Gboard Chinese/English hardware-language switch.
    shell('shell', 'input', 'keycombination', '113', '29'); key(67);
    shell('shell', 'input', 'text', url);
  }
  key(4); await sleep(200);
  assert.ok(controls().some(n => n.class === 'android.widget.EditText' && n.text === url), 'Exact URL entered');
  tap('保存');
  return waitUi(rows => rows.find(n => /^\d{4}$/.test(n.text))?.text);
}
async function client(url) {
  const ws = new WebSocket(url); ws.messages = [];
  ws.on('message', raw => ws.messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  ws.sendJson = value => ws.send(JSON.stringify(value));
  ws.take = async (predicate, timeout = 15000) => {
    const start = Date.now();
    do {
      const index = ws.messages.findIndex(typeof predicate === 'string' ? m => m.type === predicate : predicate);
      if (index >= 0) return ws.messages.splice(index, 1)[0];
      await sleep(50);
    } while (Date.now() - start < timeout);
    throw new Error(`No message: ${predicate}`);
  };
  return ws;
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  shell('logcat', '-c');
  const server = await startTestServer();
  let teacher; let browser;
  try {
    const root = path.join(server.directory, 'courseware');
    await fs.mkdir(root, { recursive: true });
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    for (const [i, color] of [rgb(.8, .12, .18), rgb(.05, .5, .4)].entries()) {
      const page = pdf.addPage([960, 540]);
      page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color });
      page.drawText(`TV TEST - PAGE ${i + 1}`, { x: 100, y: 250, size: 60, font, color: rgb(1, 1, 1) });
    }
    await fs.writeFile(path.join(root, 'tv-test.pdf'), await pdf.save());
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#123456' } }).png().toFile(path.join(root, 'tv-image.png'));
    execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(root, 'tv-video.mp4')], { windowsHide: true });
    await fs.writeFile(path.join(root, 'index.json'), JSON.stringify([{ id: 'tv-test', title: 'TV Test', userId: 'alice', url: '/myclass/public/courseware/tv-test.pdf' }]));
    const create = await server.api('/classes', 'alice', 'POST', { name: 'TV Test Class' });
    const item = (await create.json()).item;
    const update = await server.api(`/classes/${item.id}`, 'alice', 'PUT', { name: item.name, revision: item.revision, students: [{ number: '01', name: 'Test Alice' }, { number: '09', name: 'Test Bob' }] });
    assert.equal(update.status, 200);
    const code = await endpoint(server.base.replace('127.0.0.1', '10.0.2.2') + '/');
    console.log(`PASS: classroom created (${code})`);
    teacher = await client(server.base.replace('http:', 'ws:') + '/ws');
    teacher.sendJson({ type: 'teacher.join', code, token: 'alice-test-token', supportsStudentSelection: true });
    await teacher.take('join.accepted');
    await waitUi(rows => rows.some(n => n.text === 'alice_test'));
    await screenshot('waiting-1080p');
    console.log('PASS: authenticated teacher connected');

    teacher.sendJson({ type: 'courseware.open', url: '/myclass/public/courseware/tv-test.pdf', title: 'TV Test', page: 1 });
    const state = await teacher.take(m => m.type === 'courseware.state' && m.pageCount === 2 && m.page === 1);
    const first = await screenshot('pdf-page-1');
    assert.ok(await pixels(first, (r, g, b) => r > 150 && g < 80 && b < 100) > 300000);
    key(93); // Page Down remains a command even after touch-based setup.
    await teacher.take(m => m.type === 'courseware.state' && m.page === 2);
    const second = await screenshot('pdf-page-2');
    assert.ok(await pixels(second, (r, g, b) => r < 70 && g > 100 && b > 70) > 300000);
    console.log('PASS: PDF decoded, remote page-down key navigated to page 2');

    teacher.sendJson({ type: 'courseware.annotation', action: 'begin', page: 2, strokeId: 'ink', color: '#ffd166', width: 12, points: [{ x: .1, y: .1 }] });
    teacher.sendJson({ type: 'courseware.annotation', action: 'points', page: 2, strokeId: 'ink', points: [{ x: .9, y: .1 }] });
    teacher.sendJson({ type: 'courseware.annotation', action: 'end', page: 2, strokeId: 'ink' });
    await sleep(400);
    const annotated = await screenshot('pdf-annotated');
    assert.ok(await pixels(annotated, (r, g, b) => r > 220 && g > 160 && b < 130) > 2000);
    key(3); await sleep(500); shell('shell', 'am', 'start', '-n', 'cn.edu.nb3.myclass.tv/.MainActivity');
    await teacher.take(m => m.type === 'courseware.state' && m.page === 2);
    const restored = await screenshot('pdf-restored');
    assert.ok(await pixels(restored, (r, g, b) => r > 220 && g > 160 && b < 130) > 2000);
    console.log('PASS: teacher annotations and page restored after background/resume');

    teacher.sendJson({ type: 'courseware.close' });
    await waitUi(rows => rows.some(n => n.text === code));
    teacher.sendJson({ type: 'student.selection.set', requestId: 'selection', classId: item.id, mode: 'name', count: 50 });
    assert.equal((await teacher.take(m => m.type === 'student.selection.state' && m.requestId === 'selection')).confirmed, true);
    const drawn = new Set();
    for (let i = 0; i < 2; i++) {
      teacher.sendJson({ type: 'student.roll', requestId: `draw-${i}` });
      const result = await teacher.take(m => m.type === 'student.roll.result' && m.status === 'done');
      assert.ok(!drawn.has(result.message)); drawn.add(result.message);
      await waitUi(rows => rows.some(n => n.text === '抽取结果'));
      await screenshot(`student-${i + 1}`); key(23); await sleep(300);
    }
    console.log('PASS: phone selection acknowledged; roster draw did not repeat');

    teacher.sendJson({ type: 'courseware.open', url: '/myclass/public/courseware/tv-image.png', title: 'TV Image' });
    await sleep(1600);
    const image = await screenshot('image');
    assert.ok(await pixels(image, (r, g, b) => r === 18 && g === 52 && b === 86) > 200000);
    teacher.sendJson({ type: 'courseware.image.viewport', scale: 2, centerX: .5, centerY: .5, rotation: 90 });
    await sleep(300); await screenshot('image-zoom-rotation');
    console.log('PASS: native image display and viewport messages');

    teacher.sendJson({ type: 'courseware.open', url: '/myclass/public/courseware/tv-video.mp4', title: 'TV Video' });
    await teacher.take(m => m.type === 'courseware.video.state' && m.playing && m.duration > 10);
    await screenshot('video-playing');
    teacher.sendJson({ type: 'courseware.video.control', action: 'pause' });
    await teacher.take(m => m.type === 'courseware.video.state' && !m.playing && m.duration > 10);
    teacher.sendJson({ type: 'courseware.video.control', action: 'seek', position: 6 });
    await teacher.take(m => m.type === 'courseware.video.state' && m.position >= 5);
    teacher.sendJson({ type: 'courseware.video.control', action: 'mute', muted: true });
    await teacher.take(m => m.type === 'courseware.video.state' && m.muted);
    console.log('PASS: H.264 video playback, pause, seek and mute synchronized');

    teacher.close();
    browser = await chromium.launch({ headless: true });
    const browserPage = await browser.newPage();
    await browserPage.goto(server.base + '/health');
    await browserPage.evaluate(async ({ url, code }) => {
      const socket = new WebSocket(url); const pc = new RTCPeerConnection({ iceServers: [] });
      window.tvPeer = pc;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      window.tvTimer = setInterval(() => {
        ctx.fillStyle = '#19b34d'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff'; ctx.fillRect((frame++ * 7) % 500, 140, 100, 80);
        ctx.font = '40px sans-serif'; ctx.fillText('LIVE TV TEST', 80, 80);
      }, 66);
      pc.addTrack(canvas.captureStream(15).getVideoTracks()[0]);
      pc.onicecandidate = e => { if (e.candidate) socket.send(JSON.stringify({ type: 'webrtc.ice-candidate', candidate: e.candidate.toJSON() })); };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebRTC connection timeout')), 25000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'teacher.join', code }));
        socket.onmessage = async event => {
          const m = JSON.parse(event.data);
          if (m.type === 'join.accepted') {
            const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
            socket.send(JSON.stringify({ type: 'webrtc.offer', sdp: offer.sdp }));
          }
          if (m.type === 'webrtc.answer') await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          if (m.type === 'webrtc.ice-candidate') await pc.addIceCandidate(m.candidate);
        };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') { clearTimeout(timer); resolve(); } };
      });
    }, { url: server.base.replace('http:', 'ws:') + '/ws', code });
    await sleep(1500);
    const live = await screenshot('webrtc-live');
    assert.ok(await pixels(live, (r, g, b) => r < 90 && g > 120 && b < 130) > 200000, 'Live video pixels');
    console.log('PASS: browser WebRTC offer/ICE/answer and native moving video decoded');
    key(20); key(20); const rows = controls();
    assert.ok(rows.some(n => n.focused === 'true' && n.desc === '重新连接'));
    await screenshot('remote-focus');
    console.log('PASS: remote down key opened toolbar with a visible focused button');
    await browser.close(); browser = null;

    const logs = shell('logcat', '-d');
    await fs.writeFile(path.join(output, 'logcat.txt'), logs);
    assert.ok(!/FATAL EXCEPTION|ANR in cn\.edu\.nb3\.myclass\.tv/.test(logs), 'No crash/ANR');
    console.log('PASS: no FATAL EXCEPTION or TV ANR');
  } catch (error) {
    console.error('Original test failure:', error);
    await screenshot('failure');
    await fs.writeFile(path.join(output, 'failure-logcat.txt'), shell('logcat', '-d'));
    throw error;
  } finally {
    teacher?.terminate(); if (browser) await browser.close();
    await server.close();
    key(4); key(4);
    shell('shell', 'am', 'force-stop', 'cn.edu.nb3.myclass.tv');
    shell('shell', 'am', 'start', '-n', 'cn.edu.nb3.myclass.tv/.MainActivity');
    await waitUi(rows => rows.some(n => n.text === 'MyClass 大屏'));
    await endpoint('https://sz.imst.xyz/myclass/');
    await screenshot('external-final');
  }
  console.log(`ALL TV EMULATOR CHECKS PASSED. Evidence: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
