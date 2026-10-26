const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeMissingFonts, needsRegeneration, stillMissing } = require('./missingFonts');
const { normalizeFontFamily, fontFamilyAliases, familyLookupNames, isFamilyInstalled, isFontReference } = require('./fontNames');

const items = [
  { id: 'a', userId: 'alice', title: '语文课件', missingFonts: ['方正小标宋简体', 'Calibri'] },
  { id: 'b', userId: 'alice', title: '数学课件', missingFonts: ['方正小标宋简体'] },
  { id: 'c', userId: 'bob', title: '别人的课件', missingFonts: ['方正小标宋简体'] },
  { id: 'd', userId: 'admin', title: '共享课件', missingFonts: ['Source Han Serif'] },
  { id: 'e', userId: 'alice', title: '无缺失', missingFonts: [] },
  { id: 'f', userId: 'alice', title: '未扫描' }
];

test('font names normalize fontconfig aliases and vertical variants', () => {
  assert.equal(normalizeFontFamily('  Microsoft   YaHei '), 'microsoft yahei');
  assert.equal(normalizeFontFamily('@Noto Sans CJK SC'), 'noto sans cjk sc');
  assert.equal(normalizeFontFamily('Ａｒｉａｌ'), 'arial');
  assert.deepEqual(fontFamilyAliases('Microsoft YaHei, 微软雅黑 ,@微软雅黑'), ['Microsoft YaHei', '微软雅黑', '微软雅黑']);
  assert.equal(isFontReference('+mn-lt'), false);
  assert.equal(isFontReference('  '), false);
  assert.equal(isFontReference('微软雅黑'), true);
});

test('family matching ignores weight/style words encoded in the family name', () => {
  assert.deepEqual(familyLookupNames('Source Han Sans CN Bold Italic'),
    ['source han sans cn bold italic', 'source han sans cn bold', 'source han sans cn']);
  assert.equal(isFamilyInstalled('思源黑体 CN Bold', new Set([normalizeFontFamily('思源黑体 CN')])), true);
  assert.equal(isFamilyInstalled('思源黑体 CN Regular', new Set([normalizeFontFamily('思源黑体 CN')])), true);
  assert.equal(isFamilyInstalled('Montserrat Bold', new Set([normalizeFontFamily('思源黑体 CN')])), false);
  assert.equal(isFamilyInstalled('Montserrat', null), false);
  const known = new Set([normalizeFontFamily('思源黑体 CN')]);
  assert.deepEqual(stillMissing({ missingFonts: ['思源黑体 CN Bold', 'Montserrat'] }, known), ['Montserrat']);
  assert.equal(needsRegeneration({ missingFonts: ['思源黑体 CN Bold'] }, known), true);
});

test('missing fonts are grouped per teacher scope and drop installed families', () => {
  const known = new Set([normalizeFontFamily('Calibri')]);
  const alice = summarizeMissingFonts(items, known, { userId: 'alice' });
  assert.equal(alice.coursewareCount, 3);
  assert.deepEqual(alice.fonts.map(font => font.family).sort(), ['Source Han Serif', '方正小标宋简体'].sort());
  const fangzheng = alice.fonts.find(font => font.family === '方正小标宋简体');
  assert.equal(fangzheng.coursewareCount, 2);
  assert.deepEqual(fangzheng.titles, ['语文课件', '数学课件']);

  const bob = summarizeMissingFonts(items, known, { userId: 'bob' });
  assert.equal(bob.coursewareCount, 2);
  assert.deepEqual(bob.fonts.map(font => font.family).sort(), ['Source Han Serif', '方正小标宋简体'].sort());

  const admin = summarizeMissingFonts(items, known, { userId: 'root', isAdmin: true });
  assert.equal(admin.coursewareCount, 4);
  assert.equal(admin.fonts.find(font => font.family === '方正小标宋简体').coursewareCount, 3);
});

test('an item needs regeneration only when a recorded missing font is now installed', () => {
  const known = new Set([normalizeFontFamily('Calibri')]);
  assert.equal(needsRegeneration(items[0], known), true);
  assert.equal(needsRegeneration(items[1], known), false);
  assert.equal(needsRegeneration(items[5], known), false);
  assert.equal(needsRegeneration(items[0], null), false);
  assert.deepEqual(stillMissing(items[0], known), ['方正小标宋简体']);
  assert.deepEqual(stillMissing(items[0], new Set()), ['方正小标宋简体', 'Calibri']);
});
