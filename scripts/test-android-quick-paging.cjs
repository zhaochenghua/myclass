const { startTestServer } = require('../server/testSupport');
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
const ps = command => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);

(async () => {
  const server = await startTestServer();
  const proxy = http.createServer((request, response) => {
    const upstream = http.request(new URL(request.url, server.base), { method: request.method,
      headers: { ...request.headers, host: new URL(server.base).host } }, remote => {
      response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
    });
    upstream.on('error', error => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '0.0.0.0', resolve));
  const port = proxy.address().port;
  const output = path.join(os.tmpdir(), 'myclass-quick-paging');
  await fs.mkdir(output, { recursive: true });
  await ps(`& '${helpers}/emu.ps1'`);
  const size = await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'size']);
  const density = await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'density']);
  try {
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'size', '1080x2400']);
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'density', '420']);
    const props = [`-PMYCLASS_SERVER_URL=http://10.0.2.2:${port}/myclass`, `-PMYCLASS_EXTERNAL_SERVER_URL=http://10.0.2.2:${port}/myclass`];
    await ps(`& '${helpers}/dev.ps1' -GradleArgs @(${props.map(p => `'${p}'`).join(',')})`);
    await ps(`$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'; & 'C:/Users/zch/.local/gradle-8.9/bin/gradle.bat' -p android/AndroidStudioProject :app:assembleDebugAndroidTest -PdebugAbi=x86_64 ${props.map(p => `'${p}'`).join(' ')}`);
    await run(adb, ['-s', 'emulator-5554', 'install', '-r', path.resolve('android/AndroidStudioProject/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
    await run(adb, ['-s', 'emulator-5554', 'logcat', '-c']);
    const child = spawn(adb, ['-s', 'emulator-5554', 'shell', 'am', 'instrument', '-w', '-e', 'quickPaging', 'true',
      'cn.edu.nb3.myclass.test/cn.edu.nb3.myclass.ImportFlowInstrumentation'], { windowsHide: true });
    let log = ''; const captures = [], failures = [];
    child.stdout.on('data', data => {
      const chunk = String(data); log += chunk; process.stdout.write(data);
      for (const phase of ['QUICK_PORTRAIT', 'QUICK_LANDSCAPE', 'QUICK_FINISHED']) if (chunk.includes(phase)) {
        captures.push((async () => {
          try {
            const evidence = await ps(`& '${helpers}/ui.ps1'; & '${helpers}/shot.ps1' -Out '${path.join(output, phase + '.png')}'`);
            // Nonfocusable popup keeps accessibility rooted at the Activity;
            // instrumentation separately asserts popup image, size and focus.
            assert.ok(evidence.includes('快速翻页'));
          } finally {
            await run(adb, ['-s', 'emulator-5554', 'shell', 'run-as', 'cn.edu.nb3.myclass', 'touch', `cache/quick-${phase}.continue`]);
          }
        })().catch(error => failures.push(error)));
      }
    });
    child.stderr.on('data', data => { log += data; process.stderr.write(data); });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(log))); });
    await Promise.all(captures);
    await fs.writeFile(path.join(output, 'instrumentation.txt'), log);
    const crashes = await run(adb, ['-s', 'emulator-5554', 'logcat', '-d', '-s', 'AndroidRuntime:E']);
    assert.deepEqual(failures, []);
    assert.ok(log.includes('PASS:'), log);
    assert.ok(!/FATAL EXCEPTION|ANR in/.test(crashes));
    console.log('PASS: no crashes; UI and screenshots captured:', output);
  } catch (error) {
    await ps(`& '${helpers}/shot.ps1' -Out '${path.join(output, 'failure.png')}'`);
    await run(adb, ['-s', 'emulator-5554', 'logcat', '-d', '-s', 'AndroidRuntime:E']);
    throw error;
  } finally {
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'size', size.match(/Override size: (\S+)/)?.[1] || 'reset']);
    await run(adb, ['-s', 'emulator-5554', 'shell', 'wm', 'density', density.match(/Override density: (\S+)/)?.[1] || 'reset']);
    await new Promise(resolve => proxy.close(resolve)); await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
