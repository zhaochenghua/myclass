// Isolated end-to-end fixture: actual Android client <-> server <-> classroom browser.
const { chromium } = require('playwright');
const { startTestServer } = require('../server/testSupport');
const { zip, fixtureFiles } = require('../server/testFixtures/pptxVideoFixture');
const WebSocket = require('../server/node_modules/ws');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true }); let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    ...Array(3).fill('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>')];
  let data = '%PDF-1.4\n', offsets = [0];
  objects.forEach((item, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${item}\nendobj\n`; });
  const offset = Buffer.byteLength(data);
  return data + 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
}
(async () => {
  const server = process.env.MYCLASS_TEST_DIRECTORY ? { base: 'http://127.0.0.1:3107/myclass', directory: process.env.MYCLASS_TEST_DIRECTORY, close: async () => {} }
    : await startTestServer({ port: 3107, withWeb: true });
  assert.ok(path.basename(server.directory).startsWith('myclass-classroom-test-'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  let teacher;
  const output = path.join(os.tmpdir(), 'myclass-android-features'); await fs.mkdir(output, { recursive: true });
  try {
    const viewer = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [], events = [];
    viewer.on('pageerror', e => errors.push(e.message));
    viewer.on('websocket', socket => socket.on('framereceived', event => { try { events.push(JSON.parse(event.payload)); } catch {} }));
    await viewer.goto(server.base + '/'); await viewer.waitForFunction(() => !!state.roomCode);
    await viewer.waitForFunction(() => !!document.querySelector('.embedded-card video'));
    await viewer.locator('.embedded-card video').evaluate(v => { v.loop = true; });
    const media = await viewer.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 360; const ctx = c.getContext('2d'); let n = 0;
      const draw = () => { ctx.fillStyle = '#16424d'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.font = '32px sans-serif'; ctx.fillText('Android embedded video ' + n++, 40, 180); }; draw();
      const image = c.toDataURL('image/png').split(',')[1];
      const stream = c.captureStream(15), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }), chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data); const done = new Promise(resolve => recorder.onstop = resolve);
      recorder.start(); const timer = setInterval(draw, 66); await new Promise(resolve => setTimeout(resolve, 2200)); recorder.stop(); await done;
      clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      const video = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' })); });
      return { image, video };
    });
    const root = path.join(server.directory, 'courseware'); await fs.mkdir(root, { recursive: true });
    const url = '/myclass/public/courseware/android-features.pdf', imageUrl = '/myclass/public/courseware/android-image.png';
    const files = fixtureFiles(Buffer.from(media.video, 'base64'), 'webm');
    files['ppt/slides/slide2.xml'] = files['ppt/slides/slide2.xml'].replace('</p:spTree>', '<p:extLst><a:videoFile r:link="other"/></p:extLst></p:spTree>');
    files['ppt/slides/_rels/slide2.xml.rels'] = files['ppt/slides/_rels/slide2.xml.rels'].replace('</Relationships>', '<Relationship Id="other" Target="../media/other.webm" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"/></Relationships>');
    files['ppt/media/other.webm'] = files['ppt/media/lesson.webm'];
    await fs.writeFile(path.join(root, 'android-features.pptx'), zip(files));
    await fs.writeFile(path.join(root, 'android-features.pdf'), pdf());
    await fs.writeFile(path.join(root, 'android-image.png'), Buffer.from(media.image, 'base64'));
    await fs.writeFile(path.join(root, 'index.json'), JSON.stringify([
      { id: 'android-features', userId: 'alice', url, title: '安卓适配验证', originalUrl: '/myclass/public/courseware/android-features.pptx', conversion: { slideCount: 2, statePages: [1, 1, 2] } },
      { id: 'android-image', userId: 'alice', url: imageUrl, title: '图片笔记验证' }
    ]));
    const code = await viewer.evaluate(() => state.roomCode);
    async function seedConnection() {
      const ws = new WebSocket(server.base.replace('http:', 'ws:') + '/ws'); const messages = [];
      ws.on('message', data => messages.push(JSON.parse(data))); await new Promise(resolve => ws.once('open', resolve));
      ws.send(JSON.stringify({ type: 'teacher.join', code, token: 'alice-test-token' }));
      const wait = async predicate => { for (let i = 0; i < 200; i++) { const value = messages.find(predicate); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Seed WebSocket timeout'); };
      await wait(m => m.type === 'join.accepted');
      return { ws, messages, wait, send: message => ws.send(JSON.stringify(message)) };
    }
    teacher = await seedConnection();
    async function seed(url, page, id, mode) {
      teacher.send({ type: 'courseware.open', url, title: '安卓适配验证', page });
      teacher.send({ type: 'courseware.annotation', url, action: 'clear', page });
      teacher.send({ type: 'courseware.annotation', url, action: 'begin', strokeId: id, page, color: '#ff4d6d', width: 4, mode, lineMode: true, points: [{ x: .2, y: .35 }] });
      teacher.send({ type: 'courseware.annotation', url, action: 'points', strokeId: id, page, points: [{ x: .7, y: .65 }] });
      teacher.send({ type: 'courseware.annotation', url, action: 'end', strokeId: id, page });
      await teacher.wait(m => m.type === 'annotations.saved' && m.url === url);
    }
    await seed(imageUrl, 1, 'saved-image', 'solid');
    await seed(url, 1, 'saved-page-1', 'highlighter');
    teacher.messages.length = 0; await seed(url, 3, 'saved-page-3', 'dashed');
    await new Promise(resolve => setTimeout(resolve, 300)); teacher.ws.close();
    const adb = 'C:/Users/zch/.local/android-sdk/platform-tools/adb.exe';
    const captures = [], captureErrors = [];
    const instrument = spawn(adb, ['-s', 'emulator-5554', 'shell', 'am', 'instrument', '-w', '-e', 'notesVideosRoom', code, 'cn.edu.nb3.myclass.test/cn.edu.nb3.myclass.ImportFlowInstrumentation'], { windowsHide: true });
    let instrumentOutput = '';
    instrument.stdout.on('data', data => {
      const chunk = String(data); instrumentOutput += chunk; process.stdout.write(data);
      for (const [phase, text] of [['NOTES_READY', '本页视频'], ['LANDSCAPE_READY', '本页视频'], ['VIDEO_READY', '暂停']]) if (chunk.includes(phase)) captures.push((async () => {
        try {
        const proof = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `& 'C:/Users/zch/.local/android-dev/ui.ps1'; & 'C:/Users/zch/.local/android-dev/shot.ps1' -Out '${path.join(output, phase + '.png')}'`]);
        assert.ok(proof.includes(text), 'Target UI missing: ' + text);
        if (phase === 'VIDEO_READY') {
          await viewer.waitForFunction(() => document.querySelector('.embedded-card video').currentTime > .1);
          await viewer.screenshot({ path: path.join(output, 'big-screen-video.png') });
        }
        } finally { await run(adb, ['-s', 'emulator-5554', 'shell', 'run-as', 'cn.edu.nb3.myclass', 'touch', `cache/parity-${phase}.continue`]); }
      })().catch(error => { captureErrors.push(error); }));
    });
    instrument.stderr.on('data', data => { instrumentOutput += data; process.stderr.write(data); });
    await new Promise((resolve, reject) => { instrument.on('error', reject); instrument.on('close', code => code === 0 ? resolve() : reject(new Error('Instrumentation exit ' + code))); });
    await Promise.all(captures);
    assert.deepEqual(captureErrors, []);
    assert.ok(instrumentOutput.includes('PASS:'), instrumentOutput);
    for (const action of ['open', 'play', 'pause', 'back', 'forward', 'close']) assert.ok(events.some(m => m.type === 'courseware.embedded-video' && m.action === action), 'Missing action: ' + action);
    await viewer.waitForFunction(() => state.courseware?.page === 3);
    teacher = await seedConnection(); teacher.messages.length = 0;
    teacher.send({ type: 'courseware.open', url: imageUrl, page: 1 });
    const imageNotes = await teacher.wait(m => m.type === 'annotations.snapshot'); assert.equal(imageNotes.strokes.length, 0);
    teacher.messages.length = 0; teacher.send({ type: 'courseware.open', url, page: 3 });
    const pdfNotes = await teacher.wait(m => m.type === 'annotations.snapshot'); assert.equal(pdfNotes.strokes.length, 2);
    assert.deepEqual(errors, []);
    console.log('PASS: actual Android/server/viewer notes and embedded video interoperability; evidence:', output);
  } finally { teacher?.ws.close(); await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
