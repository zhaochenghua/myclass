// Small, deterministic ODF source used to produce real PPT/PPTX test inputs.
// Each expected PDF page describes visible labels, independently of the exporter.
const frame = (id, text, y = 4) => `<draw:frame draw:style-name="box" xml:id="${id}" draw:id="${id}" svg:x="2cm" svg:y="${y}cm" svg:width="22cm" svg:height="2cm"><draw:text-box><text:p>${text}</text:p></draw:text-box></draw:frame>`;
const paragraphs = (id, labels) => `<draw:frame draw:style-name="box" svg:x="2cm" svg:y="4cm" svg:width="22cm" svg:height="6cm"><draw:text-box>${labels.map((label, i) => `<text:p xml:id="${id}${i}" text:id="${id}${i}">${label}</text:p>`).join('')}</draw:text-box></draw:frame>`;
const effect = (id, visible, paragraph = false, trigger = 'on-click') => `<anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="${trigger}" presentation:preset-class="${visible ? 'entrance' : 'exit'}" presentation:preset-id="ooo-${visible ? 'entrance-appear' : 'exit-disappear'}"><anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="${id}" ${paragraph ? 'anim:sub-item="text"' : ''} smil:attributeName="visibility" smil:to="${visible ? 'visible' : 'hidden'}"/></anim:par>`;
const click = (...effects) => `<anim:par smil:begin="next"><anim:par smil:begin="0s">${effects.join('')}</anim:par></anim:par>`;
const slide = (title, shapes, ...clicks) => `<draw:page draw:name="${title}" draw:master-page-name="Default">${frame(`title${title}`, title, 1)}${shapes}${clicks.length ? `<anim:par presentation:node-type="timing-root"><anim:seq presentation:node-type="main-sequence">${clicks.join('')}</anim:seq></anim:par>` : ''}</draw:page>`;
const picture = '<draw:frame draw:style-name="box" xml:id="picture" draw:id="picture" svg:x="2cm" svg:y="4cm" svg:width="4cm" svg:height="4cm"><draw:image><office:binary-data>iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAPElEQVR4nO3RQREAMAjEwKNqKqL+VSCmEsKHX1bAMROq78ums7oeDwz4A2QiZCJkImQiZCJkImQiZKKQD7cwAYDStM9DAAAAAElFTkSuQmCC</office:binary-data></draw:image></draw:frame>';

const expected = [
  ['STATIC', 'Always'],
  ['APPEAR'], ['APPEAR', 'Apple'],
  ['DISAPPEAR', 'Banana'], ['DISAPPEAR'],
  ['TOGETHER'], ['TOGETHER', 'Cherry', 'Date'],
  ['REPEAT'], ['REPEAT', 'Elderberry'], ['REPEAT'], ['REPEAT', 'Elderberry'],
  ['PARAGRAPHS'], ['PARAGRAPHS', 'First'], ['PARAGRAPHS', 'First', 'Second'],
  ['PARAGRAPHEXIT', 'Keep', 'Remove'], ['PARAGRAPHEXIT', 'Keep'],
  ['IMAGE'], ['IMAGE'], ['IMAGE'],
  ['GROUP'], ['GROUP', 'Grouped', 'Together'],
  ['CHAIN'], ['CHAIN', 'Grape', 'Honeydew']
];

function createFixture() {
  const slides = [
    slide('STATIC', frame('static', 'Always')),
    slide('APPEAR', frame('apple', 'Apple'), click(effect('apple', true))),
    slide('DISAPPEAR', frame('banana', 'Banana'), click(effect('banana', false))),
    slide('TOGETHER', frame('cherry', 'Cherry') + frame('date', 'Date', 7), click(effect('cherry', true), effect('date', true, false, 'with-previous'))),
    slide('REPEAT', frame('elder', 'Elderberry'), click(effect('elder', true)), click(effect('elder', false)), click(effect('elder', true))),
    slide('PARAGRAPHS', paragraphs('para', ['First', 'Second']), click(effect('para0', true, true)), click(effect('para1', true, true))),
    slide('PARAGRAPHEXIT', paragraphs('exit', ['Remove', 'Keep']), click(effect('exit0', false, true))),
    slide('IMAGE', picture, click(effect('picture', true)), click(effect('picture', false))),
    slide('GROUP', `<draw:g xml:id="group" draw:id="group">${frame('grouped', 'Grouped')}${frame('together', 'Together', 7)}</draw:g>`, click(effect('group', true))),
    slide('CHAIN', frame('grape', 'Grape') + frame('honeydew', 'Honeydew', 7), click(effect('grape', true), effect('honeydew', true, false, 'after-previous')))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="24pt" fo:color="#172b4d"/></style:default-style></office:styles>
<office:automatic-styles><style:page-layout style:name="page"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout><style:style style:name="box" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:auto-grow-height="true"/></style:style></office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="page"/></office:master-styles>
<office:body><office:presentation>${slides.join('')}</office:presentation></office:body></office:document>`;
}

module.exports = { createFixture, expected };
