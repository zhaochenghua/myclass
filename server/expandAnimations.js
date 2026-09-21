const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const PROFILE = 'expand-animations-v2';
const VENDOR = path.join(__dirname, 'vendor', 'expand-animations');

function publicError(message, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message });
}

function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

// Application macros live only in this disposable profile. Uploaded documents
// are opened by the wrapper with NEVER_EXECUTE and NO_UPDATE.
async function prepareProfile(profile) {
  const basic = path.join(profile, 'user', 'basic');
  const library = path.join(basic, 'Standard');
  await fs.mkdir(library, { recursive: true });
  for (const name of ['ExpandAnimations', 'MyClass']) {
    const source = await fs.readFile(path.join(VENDOR, `${name}.bas`), 'utf8');
    await fs.writeFile(path.join(library, `${name}.xba`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="${name}" script:language="StarBasic">${xml(source)}</script:module>`);
  }
  await fs.writeFile(path.join(library, 'script.xlb'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
<library:element library:name="ExpandAnimations"/><library:element library:name="MyClass"/></library:library>`);
  await fs.writeFile(path.join(basic, 'script.xlc'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">
<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">
<library:library library:name="Standard" xlink:href="$(USER)/basic/Standard/script.xlb/" xlink:type="simple" library:link="false"/></library:libraries>`);
}

function runOffice(executable, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        // Only the process tree started for this job, never another Office session.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.once('error', error => { clearTimeout(timer); reject(error.code === 'ENOENT'
      ? publicError('未找到 LibreOffice，请安装 libreoffice-impress 或配置 LIBREOFFICE_PATH') : error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(publicError('PPT 动画展开超时，请减少课件内容或增加 PPT_ANIMATION_TIMEOUT_MS', 504));
      else if (code !== 0) reject(publicError(`LibreOffice 动画展开失败：${stderr.trim() || code}`));
      else resolve();
    });
  });
}

async function expandAnimations(input, ext, output, { executable,
  timeoutMs = 180000, maxStates = 500, tempRoot = os.tmpdir(), runner = runOffice } = {}) {
  if (!['.ppt', '.pptx'].includes(ext)) throw new Error('Animation expansion requires PPT/PPTX');
  if (!executable || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 10000) throw new Error('Invalid animation converter options');
  await fs.mkdir(tempRoot, { recursive: true });
  const job = await fs.mkdtemp(path.join(tempRoot, 'myclass-animation-'));
  try {
    const profile = path.join(job, 'profile');
    const source = path.join(job, `input${ext}`);
    const pdf = path.join(job, 'result.pdf');
    const result = path.join(job, 'result.txt');
    await fs.copyFile(input, source);
    const profileArg = `-env:UserInstallation=${pathToFileURL(profile).href}`;
    const started = Date.now();
    await runner(executable, [profileArg, '--headless', '--nologo', '--nofirststartwizard', '--terminate_after_init'], { timeoutMs, env: { ...process.env } });
    await prepareProfile(profile);
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw publicError('PPT 动画转换初始化超时', 504);
    await runner(executable, [profileArg, '--headless', '--nologo',
      '--nodefault', '--nofirststartwizard', '--norestore', 'macro:///Standard.MyClass.Convert'], {
      timeoutMs: remaining, env: { ...process.env, MYCLASS_ANIMATION_INPUT: source,
        MYCLASS_ANIMATION_OUTPUT: pdf, MYCLASS_ANIMATION_RESULT: result,
        MYCLASS_ANIMATION_ODP: path.join(job, 'expanded.odp'), MYCLASS_ANIMATION_MAX_STATES: String(maxStates) }
    });
    let report;
    try { report = (await fs.readFile(result, 'utf8')).trim().split(/\r?\n/); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw publicError('LibreOffice 未完成动画展开，请检查是否安装 Impress 与 Basic 脚本组件');
    }
    if (report[0] !== 'OK') throw publicError(`PPT 动画展开失败：${report.slice(1).join(' ').slice(0, 500)}`);
    const [slideCount, stateCount, unsupportedSlides] = report.slice(1).map(Number);
    const statePages = (report[4] || '').split(',').map(Number);
    if (!Number.isSafeInteger(slideCount) || slideCount < 1 || !Number.isSafeInteger(stateCount) ||
        stateCount < 1 || stateCount > maxStates || !Number.isSafeInteger(unsupportedSlides) || unsupportedSlides < 0 ||
        statePages.length !== stateCount || statePages.some((page, i) => !Number.isSafeInteger(page) ||
          page < 1 || page > slideCount || (i > 0 && page < statePages[i - 1]))) {
      throw publicError('PPT 动画展开结果无效');
    }
    const file = await fs.open(pdf, 'r');
    try {
      const signature = Buffer.alloc(5);
      await file.read(signature, 0, 5, 0);
      if (signature.toString() !== '%PDF-') throw publicError('PPT 动画展开未生成有效 PDF');
    } finally { await file.close(); }
    await fs.copyFile(pdf, output);
    return { mode: 'animation-states', profile: PROFILE, slideCount, stateCount, unsupportedSlides, statePages };
  } finally {
    await fs.rm(job, { recursive: true, force: true });
  }
}

module.exports = { expandAnimations, PROFILE, runOffice };
