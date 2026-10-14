const { test } = require('node:test');
const assert = require('node:assert/strict');
test('clipboard links extract shared title and reject non-web text', async () => {
 const {parseClipboardLink:parse}=await import('./ios/js/clipboardLink.mjs');
 assert.deepEqual(parse('【课前备课-哔哩哔哩】 https://example.com/lesson。'),{url:'https://example.com/lesson',title:'课前备课'});
 assert.deepEqual(parse('https://example.com'),{url:'https://example.com/',title:''});
 assert.equal(parse('普通文本'),null); assert.equal(parse('file:///etc/hosts'),null);
 assert.equal(parse('https://'),null);
 assert.equal(parse('课件名称\nhttps://example.com/1').title,'课件名称');
});
