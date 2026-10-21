// Disposable server + actual Android management UI. No real accounts or classroom data.
const { startTestServer } = require('../server/testSupport');
const { AnnotationStore } = require('../server/annotationStore');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const adb = 'C:/Users/zch/.local/android-sdk/platform-tools/adb.exe';
const helpers = 'C:/Users/zch/.local/android-dev';
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true }); let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
const powershell = command => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);

function pdf(count, animation) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < count; i++) {
    const final = !animation || i % 2 === 1;
    const color = final ? ['0.1 0.45 0.65', '0.1 0.55 0.3', '0.2 0.3 0.65'][Math.floor(i / 2) % 3] : '0.9 0.15 0.15';
    const text = final ? `SLIDE ${animation ? Math.floor(i / 2) + 1 : i + 1} - FINAL STATE` : 'INTERMEDIATE - MUST NOT APPEAR';
    const stream = `${color} rg 0 0 960 540 re f\n1 1 1 rg BT /F1 32 Tf 50 440 Td (${text}) Tj 0 -70 Td /F1 23 Tf (Full-width continuous document preview) Tj 0 -70 Td (Completed content / answers visible) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let data = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  return data + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}

(async () => {
  const server = await startTestServer();
  const requests = [];
  const proxy = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const upstream = http.request(new URL(request.url, server.base), { method: request.method,
      headers: { ...request.headers, host: new URL(server.base).host } }, remote => {
      response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
    });
    upstream.on('error', error => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '0.0.0.0', resolve));
  const port = proxy.address().port;
  const output = path.join(os.tmpdir(), 'myclass-continuous-preview');
  await fs.mkdir(output, { recursive: true });
  const size = await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'size']);
  const density = await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'density']);
  try {
    // The shared AVD may have been left in TV/tablet mode by another task.
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'size', '1080x2400']);
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'density', '420']);
    const root = path.join(server.directory, 'courseware');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'continuous.pdf'), pdf(16, true));
    await fs.writeFile(path.join(root, 'ordinary.pdf'), pdf(3, false));
    await fs.writeFile(path.join(root, 'index.json'), JSON.stringify([
      { id: 'continuous-animation', userId: 'alice', title: '连续预览动画验证', url: '/myclass/public/courseware/continuous.pdf',
        conversion: { mode: 'animation-states', slideCount: 8, statePages: Array.from({ length: 16 }, (_, i) => Math.floor(i / 2) + 1) } },
      { id: 'ordinary-document', userId: 'alice', title: '普通PDF验证', url: '/myclass/public/courseware/ordinary.pdf' }
    ]));
    const notes = new AnnotationStore(path.join(root, '.annotations'));
    await notes.apply('continuous-animation', { type: 'courseware.annotation', action: 'begin', page: 2,
      strokeId: 'preserve-this-note', color: '#ff0000', width: 4, points: [{ x: .1, y: .2 }] }, 'teacher');
    const notesFile = notes.file('continuous-animation'), before = await fs.readFile(notesFile);
    const props = `'-PMYCLASS_SERVER_URL=http://10.0.2.2:${port}/myclass','-PMYCLASS_EXTERNAL_SERVER_URL=http://10.0.2.2:${port}/myclass'`;
    await powershell(`& '${helpers}/emu.ps1'; & '${helpers}/dev.ps1' -GradleArgs @(${props})`);
    await powershell(`$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'; & 'C:/Users/zch/.local/gradle-8.9/bin/gradle.bat' -p android/AndroidStudioProject :app:assembleDebugAndroidTest -PdebugAbi=x86_64 ${props.replaceAll("','", "' '")}`);
    await run(adb, ['-s', 'emulator-5554', 'install', '-r', path.resolve('android/AndroidStudioProject/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
    await run(adb, ['-s', 'emulator-5554', 'logcat', '-c']);
    const captures = [], captureErrors = [];
    const child = spawn(adb, ['-s', 'emulator-5554', 'shell', 'am', 'instrument', '-w', '-e', 'continuousPreview', 'true',
      'cn.edu.nb3.myclass.test/cn.edu.nb3.myclass.ImportFlowInstrumentation'], { windowsHide: true });
    let log = '';
    child.stdout.on('data', data => {
      const chunk = String(data); log += chunk; process.stdout.write(data);
      for (const phase of ['CONTINUOUS_READY', 'SCROLLED_READY']) if (chunk.includes(phase)) captures.push((async () => {
        try {
          const proof = await powershell(`& '${helpers}/ui.ps1'; & '${helpers}/shot.ps1' -Out '${path.join(output, phase + '.png')}'`);
          assert.ok(proof.includes('返回课件管理'));
          assert.ok(proof.includes('第 '));
          assert.ok(!proof.includes('清除笔记'));
        } finally {
          await run(adb, ['-s', 'emulator-5554', 'shell', 'run-as', 'cn.edu.nb3.myclass', 'touch', `cache/continuous-${phase}.continue`]);
        }
      })().catch(error => captureErrors.push(error)));
    });
    child.stderr.on('data', data => { log += data; process.stderr.write(data); });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(log))); });
    await Promise.all(captures);
    await fs.writeFile(path.join(output, 'instrumentation.txt'), log);
    const crash = await run(adb, ['-s', 'emulator-5554', 'logcat', '-d', '-s', 'AndroidRuntime:E']);
    await fs.writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
    assert.deepEqual(captureErrors, []);
    assert.ok(log.includes('PASS:'), log);
    assert.ok(!/FATAL EXCEPTION|ANR in/.test(crash), crash);
    assert.deepEqual(await fs.readFile(notesFile), before, 'Classroom notes changed');
    assert.ok(!requests.some(route => /annotation|notes/.test(route)), 'Standalone reader accessed notes');
    console.log('PASS: server notes untouched; no annotation requests; no crash. Evidence:', output);
  } catch (error) {
    await powershell(`& '${helpers}/shot.ps1' -Out '${path.join(output, 'failure.png')}'`);
    await run(adb, ['-s', 'emulator-5554', 'logcat', '-d', '-s', 'AndroidRuntime:E']);
    throw error;
  } finally {
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'size', size.match(/Override size: (\S+)/)?.[1] || 'reset']);
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'density', density.match(/Override density: (\S+)/)?.[1] || 'reset']);
    await new Promise(resolve => proxy.close(resolve));
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
