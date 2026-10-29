// Deterministic .pptx package with speaker notes, used by the notes tests.
// The deck order deliberately differs from the file order so extraction has to
// follow presentation.xml relationships rather than slide file names.
const { zip } = require('./pptxVideoFixture');

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const ns = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${REL.slice(0, -1)}"`;

function slide() {
  return `<p:sld ${ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>`;
}

function notes(body, extra = '') {
  return `<p:notes ${ns}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="幻灯片图像占位符"/><p:cNvPicPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
    body +
    extra +
    '</p:spTree></p:cSld></p:notes>';
}

function bodyShape(paragraphs) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="3" name="备注占位符"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function textBox(text) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="5" name="文本框 6"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

// Notes page furniture that must never leak into the extracted note.
const furniture = '<p:sp><p:nvSpPr><p:cNvPr id="4" name="页码"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter"/></p:nvPr></p:nvSpPr><p:spPr/>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B4B3C0D5-0000-0000-0000-000000000000}" type="slidenum"><a:t>9</a:t></a:fld></a:p></p:txBody></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="6" name="页脚"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr><p:spPr/>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>页脚文字</a:t></a:r></a:p></p:txBody></p:sp>';

function slideRels(notesSlide) {
  return '<Relationships>' +
    `<Relationship Id="rId1" Target="../slideLayouts/slideLayout1.xml" Type="${REL}slideLayout"/>` +
    `<Relationship Id="rId2" Target="../notesSlides/${notesSlide}" Type="${REL}notesSlide"/>` +
    '</Relationships>';
}

const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  ['slide1', 'slide2', 'slide3'].map(name => `<Override PartName="/ppt/slides/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
  ['notesSlide1', 'notesSlide2', 'notesSlide3'].map(name => `<Override PartName="/ppt/notesSlides/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('') +
  '</Types>';

function files() {
  const paragraph = text => `<a:p><a:r><a:rPr lang="zh-CN"/><a:t>${text}</a:t></a:r></a:p>`;
  return {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="ppt" Type="${REL}officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    // Deck order: slide2.xml, slide1.xml, slide3.xml.
    'ppt/presentation.xml': `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="first"/><p:sldId id="257" r:id="second"/><p:sldId id="258" r:id="third"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships>' +
      `<Relationship Id="first" Target="slides/slide2.xml" Type="${REL}slide"/>` +
      `<Relationship Id="second" Target="slides/slide1.xml" Type="${REL}slide"/>` +
      `<Relationship Id="third" Target="slides/slide3.xml" Type="${REL}slide"/>` +
      '</Relationships>',
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/slide2.xml': slide(),
    'ppt/slides/slide3.xml': slide(),
    // Deck slide 1 (slide2.xml): two paragraphs + a plain text box.
    'ppt/slides/_rels/slide2.xml.rels': slideRels('notesSlide1.xml'),
    'ppt/notesSlides/notesSlide1.xml': notes(bodyShape(paragraph('第一段备注') + paragraph('第二段备注') + '<a:p><a:endParaRPr lang="zh-CN"/></a:p>'), `${textBox('补充说明')}${furniture}`),
    // Deck slide 2 (slide1.xml): only page furniture, so no note.
    'ppt/slides/_rels/slide1.xml.rels': slideRels('notesSlide2.xml'),
    'ppt/notesSlides/notesSlide2.xml': notes('', furniture),
    // Deck slide 3 (slide3.xml): xml:space="preserve" must keep the text (trimmed).
    'ppt/slides/_rels/slide3.xml.rels': slideRels('notesSlide3.xml'),
    'ppt/notesSlides/notesSlide3.xml': notes(bodyShape(`<a:p><a:r><a:t xml:space="preserve">  结尾备注  </a:t></a:r></a:p>`)),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${ns}/>`
  };
}

function notesPptx(options = {}) {
  return zip(files(options));
}

module.exports = { notesPptx, files, zip };
