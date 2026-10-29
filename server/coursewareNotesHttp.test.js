const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer } = require('./testSupport');
const { notesPptx } = require('./testFixtures/pptxNotesFixture');

function record(id, userId, fileName = 'lesson.pptx') {
  const base = `/myclass/public/courseware/${id}`;
  return {
    id, userId, title: id, fileName, size: 100, createdAt: new Date().toISOString(),
    url: `${base}.pdf`, originalUrl: `${base}.pptx`
  };
}

test('speaker notes are readable, editable per teacher and removed with the courseware', { timeout: 20000 }, async t => {
  const shared = 'sharednotes01';
  const privateLesson = 'privatenotes02';
  const pdfOnly = 'pdffile003';
  const server = await startTestServer({
    seed: async ({ coursewareRoot }) => {
      await fs.mkdir(coursewareRoot, { recursive: true });
      for (const id of [shared, privateLesson]) {
        await fs.writeFile(path.join(coursewareRoot, `${id}.pdf`), '%PDF-1.4\n%%EOF\n');
        await fs.writeFile(path.join(coursewareRoot, `${id}.pptx`), notesPptx());
      }
      await fs.writeFile(path.join(coursewareRoot, `${pdfOnly}.pdf`), '%PDF-1.4\n%%EOF\n');
      await fs.writeFile(path.join(coursewareRoot, 'index.json'), JSON.stringify([
        record(shared, 'admin'),
        record(privateLesson, 'alice'),
        { ...record(pdfOnly, 'alice'), fileName: 'plain.pdf', originalUrl: `/myclass/public/courseware/${pdfOnly}.pdf` }
      ]));
    }
  });
  t.after(() => server.close());

  const call = (user, id, method = 'GET', body) => fetch(`${server.base}/api/courseware/${id}/notes`, {
    method,
    headers: { Authorization: `Bearer ${user}-test-token`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const slidesOf = async (user, id) => (await (await call(user, id)).json()).slides;

  // 未登录与无权限
  assert.equal((await fetch(`${server.base}/api/courseware/${shared}/notes`)).status, 401);
  assert.equal((await call('bob', privateLesson)).status, 404);

  // 共享课件：两位老师各自看自己的备注
  const first = await call('alice', shared);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await first.json(), { supported: true, slides: [
    { slide: 1, text: '第一段备注\n第二段备注\n补充说明' },
    { slide: 3, text: '结尾备注' }
  ] });

  const save = await call('alice', shared, 'PUT', { slide: 2, text: '磨课修改后的备注\r\n第二行' });
  assert.equal(save.status, 200);
  assert.deepEqual(await save.json(), { ok: true, slide: 2, text: '磨课修改后的备注\n第二行' });
  assert.deepEqual((await slidesOf('alice', shared)).map(note => note.slide), [1, 2, 3]);
  // bob 修改的是自己那份，alice 的讲稿不受影响
  assert.equal((await call('bob', shared, 'PUT', { slide: 3, text: 'bob 的备注' })).status, 200);
  assert.deepEqual((await slidesOf('bob', shared)), [
    { slide: 1, text: '第一段备注\n第二段备注\n补充说明' },
    { slide: 3, text: 'bob 的备注' }
  ]);
  assert.equal((await slidesOf('alice', shared))[2].text, '结尾备注');
  // 清空 = 用空文本遮住 PPTX 自带的备注
  assert.equal((await call('alice', shared, 'PUT', { slide: 1, text: '   ' })).status, 200);
  assert.deepEqual((await slidesOf('alice', shared)).map(note => note.slide), [2, 3]);

  // 参数校验
  for (const body of [{ slide: 0, text: 'x' }, { slide: 1.5, text: 'x' }, { slide: '1', text: 'x' },
    { slide: 1 }, { slide: 1, text: 42 }, { slide: 1, text: 'x'.repeat(20001) }, { slide: 10001, text: 'x' }]) {
    assert.equal((await call('alice', shared, 'PUT', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }

  // 普通 PDF 没有备注，也不能写入
  assert.deepEqual(await (await call('alice', pdfOnly)).json(), { supported: false, slides: [] });
  assert.equal((await call('alice', pdfOnly, 'PUT', { slide: 1, text: 'x' })).status, 400);

  // 删除课件后，已保存的备注也一起删除
  const notesDirectory = path.join(server.directory, 'courseware', '.notes', privateLesson);
  assert.equal((await call('alice', privateLesson, 'PUT', { slide: 2, text: '私人备注' })).status, 200);
  assert.equal((await fs.readdir(notesDirectory)).length, 1);
  assert.equal((await fetch(`${server.base}/api/courseware/${privateLesson}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer alice-test-token' }
  })).status, 200);
  await assert.rejects(fs.access(notesDirectory), { code: 'ENOENT' });
});
