const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { expandAnimations, PROFILE, runOffice } = require('./expandAnimations');

test('jobs isolate input/profile, require completion, and remove all temporary data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'animation-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'source with spaces.pptx');
  await fs.writeFile(input, 'original');
  const output = path.join(root, 'out.pdf');
  const profiles = [];
  const runner = async (exe, args, { env }) => {
    const profile = fileURLToPath(args[0].slice('-env:UserInstallation='.length));
    if (args.includes('--terminate_after_init')) { profiles.push(profile); return; }
    assert.equal(await fs.readFile(env.MYCLASS_ANIMATION_INPUT, 'utf8'), 'original');
    assert.notEqual(env.MYCLASS_ANIMATION_INPUT, input);
    assert((await fs.readFile(path.join(profile, 'user/basic/Standard/MyClass.xba'), 'utf8')).includes('NEVER_EXECUTE'));
    await fs.writeFile(env.MYCLASS_ANIMATION_OUTPUT, '%PDF-1.7\nfixture');
    await fs.writeFile(env.MYCLASS_ANIMATION_RESULT, 'OK\n2\n5\n0\n1,1,2,2,2\n');
  };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await expandAnimations(input, '.pptx', output, { executable: 'test', tempRoot: root, runner }),
      { mode: 'animation-states', profile: PROFILE, slideCount: 2, stateCount: 5, unsupportedSlides: 0, statePages: [1,1,2,2,2] });
  }
  assert.notEqual(profiles[0], profiles[1]);
  assert.equal(await fs.readFile(input, 'utf8'), 'original');
  for (const report of [null, 'ERROR\nconversion failed', 'OK\n1\n9999\n0', 'OK\n1\nNaN\n0', 'OK\n2\n2\n0\n2,1', 'OK\n2\n2\n0\n1,3', 'OK\n2\n2\n0\n1']) {
    await assert.rejects(expandAnimations(input, '.pptx', path.join(root, 'bad.pdf'), {
      executable: 'test', tempRoot: root, runner: async (exe, args, { env }) => {
        if (!env.MYCLASS_ANIMATION_RESULT) return;
        await fs.writeFile(env.MYCLASS_ANIMATION_OUTPUT, '%PDF-1.7\npartial');
        if (report) await fs.writeFile(env.MYCLASS_ANIMATION_RESULT, report);
      }
    }));
  }
  assert.deepEqual((await fs.readdir(root)).sort(), ['out.pdf', 'source with spaces.pptx']);
});

test('converter bounds hanging processes and reports missing executables', { timeout: 10000 }, async () => {
  await assert.rejects(runOffice(process.execPath, ['-e', 'setInterval(()=>{},10000)'], {
    timeoutMs: 200, env: process.env
  }), { statusCode: 504 });
  await assert.rejects(runOffice(path.join(os.tmpdir(), 'nonexistent-myclass-office'), [], {
    timeoutMs: 1000, env: process.env
  }), /未找到 LibreOffice/);
});
