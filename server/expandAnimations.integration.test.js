const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { expandAnimations, runOffice } = require('./expandAnimations');
const { createFixture, expected } = require('./testFixtures/animationFixture');
const exec = promisify(execFile);

test('real LibreOffice: direct PDF versus click states for PPTX and PPT', {
  skip: process.env.RUN_LIBREOFFICE_TESTS !== '1', timeout: 180000
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-animation-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = process.env.LIBREOFFICE_PATH || 'libreoffice';
  const fixture = path.join(directory, 'fixture.fodp');
  await fs.writeFile(fixture, createFixture());
  const convert = async (input, format, outdir = directory) => {
    await fs.mkdir(outdir, { recursive: true });
    await runOffice(executable, [`-env:UserInstallation=${pathToFileURL(path.join(directory, 'fixture-profile')).href}`,
      '--headless', '--convert-to', format, '--outdir', outdir, input], { timeoutMs: 30000, env: process.env });
  };
  const pages = async pdf => {
    const { stdout } = await exec('pdftotext', ['-layout', pdf, '-']);
    return stdout.split('\f').filter(page => page.trim()).map(page => page.trim().split(/\s+/).sort());
  };
  for (const ext of ['pptx', 'ppt']) {
    await convert(fixture, ext);
    const input = path.join(directory, `fixture.${ext}`);
    const expanded = path.join(directory, `expanded-${ext}.pdf`);
    const report = await expandAnimations(input, `.${ext}`, expanded, { executable });
    assert.equal(report.slideCount, 10);
    assert.deepEqual(report.statePages, [1,2,2,3,3,4,4,5,5,5,5,6,6,6,7,7,8,8,8,9,9,10,10]);
    assert.equal(report.stateCount, expected.length);
    assert.deepEqual(await pages(expanded), expected.map(page => [...page].sort()), `${ext}: every state must match`);
    await convert(input, 'pdf', path.join(directory, `direct-${ext}`));
    const direct = await pages(path.join(directory, `direct-${ext}`, 'fixture.pdf'));
    assert.equal(direct.length, 10, 'ordinary PDF export does not expand animation clicks');
    assert(direct[1].includes('Apple'), 'ordinary PDF reveals an entrance object immediately');
    assert(direct[2].includes('Banana'), 'ordinary PDF never removes an exit object');
    // Images have no extractable text: check the rendered result independently.
    const prefix = path.join(directory, `image-${ext}`);
    await exec('pdftoppm', ['-f', '17', '-l', '19', '-scale-to', '280', expanded, prefix]);
    const [before, visible, after] = await Promise.all([17, 18, 19].map(page => fs.readFile(`${prefix}-${page}.ppm`)));
    assert.deepEqual(before, after, 'image disappears without leaving pixels behind');
    assert.notDeepEqual(before, visible, 'image is really rendered after its entrance');
    t.diagnostic(`${ext}: ${direct.length} static pages vs ${report.stateCount} verified animation states`);
  }
  // Use the real authenticated upload endpoint and storage cache, not just the converter.
  const { startTestServer } = require('./testSupport');
  const server = await startTestServer();
  try {
    const original = await fs.readFile(path.join(directory, 'fixture.pptx'));
    const upload = async () => {
      const body = new FormData();
      body.set('file', new Blob([original]), 'animation.pptx');
      const response = await fetch(`${server.base}/api/courseware`, {
        method: 'POST', headers: { Authorization: 'Bearer alice-test-token' }, body
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const first = await upload();
    const second = await upload();
    assert.equal(first.conversion.stateCount, expected.length);
    assert.deepEqual(second.conversion, first.conversion);
    assert.equal(second.storageKey, first.storageKey);
    const origin = new URL(server.base).origin;
    assert.deepEqual(await (await fetch(origin + first.url + '.metadata')).json(), { conversion: first.conversion });
    const download = await fetch(origin + first.url);
    assert.equal(download.status, 200);
    const uploadedPdf = path.join(directory, 'uploaded.pdf');
    await fs.writeFile(uploadedPdf, Buffer.from(await download.arrayBuffer()));
    assert.deepEqual(await pages(uploadedPdf), expected.map(page => [...page].sort()));
    assert.deepEqual(Buffer.from(await (await fetch(origin + first.originalUrl)).arrayBuffer()), original);
  } finally { await server.close(); }
  await assert.rejects(expandAnimations(path.join(directory, 'fixture.pptx'), '.pptx', path.join(directory, 'limited.pdf'), {
    executable, maxStates: 2
  }), /Too many animation states/);
  await fs.writeFile(path.join(directory, 'bad.pptx'), 'not a presentation');
  await assert.rejects(expandAnimations(path.join(directory, 'bad.pptx'), '.pptx', path.join(directory, 'bad.pdf'), {
    executable, timeoutMs: 15000
  }));
});
