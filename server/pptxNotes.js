// Extracts the speaker notes of a .pptx package without opening it in LibreOffice.
//
// Notes are slide-level, not page-level: after animation expansion one slide can
// become several PDF pages, and every one of those pages shares that slide's
// notes. Callers map a PDF page back to its original slide (conversion.statePages)
// before looking a note up, so this module only reports slide numbers.
//
// Only text the teacher actually typed as a note is returned. PowerPoint fills
// every notes page with a slide-image placeholder and often a slide-number /
// header / footer / date placeholder; those are page furniture, not notes.
const path = require('node:path');
const yauzl = require('yauzl');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_ENTRIES = 20000;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_SLIDES = 10000;
// A single note longer than this is almost certainly a mistake (pasted book).
const MAX_NOTE_CHARS = 20000;
// Bounded aggregate keeps the JSON response small even for pathological files.
const MAX_TOTAL_CHARS = 2 * 1024 * 1024;

const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false,
  // Keep note text exactly as written: trimming would drop intended spacing,
  // and numeric-looking text must stay a string.
  trimValues: false,
  parseTagValue: false
});

function parse(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('无效的 PPTX XML');
  return parser.parse(xml);
}

function target(base, value) {
  if (typeof value !== 'string' || /[\\?#]/.test(value)) return null;
  const resolved = path.posix.normalize(value.startsWith('/') ? value.slice(1) : path.posix.join(path.posix.dirname(base), value));
  return resolved.startsWith('ppt/') && !resolved.includes('../') ? resolved : null;
}

function relationships(xml, base) {
  return new Map(array(parse(xml)?.Relationships?.Relationship).filter(r => r['@TargetMode'] !== 'External')
    .map(r => [r['@Id'], { path: target(base, r['@Target']), type: String(r['@Type'] || '') }]));
}

function runText(run) {
  const value = run?.['a:t'];
  if (typeof value === 'string') return value;
  // With ignoreAttributes, <a:t xml:space="preserve">text</a:t> becomes an
  // object; dropping it would silently lose notes that keep leading spaces.
  if (value && typeof value === 'object' && typeof value['#text'] === 'string') return value['#text'];
  return '';
}

function paragraphText(paragraph) {
  if (!paragraph || typeof paragraph !== 'object') return '';
  // a:fld is a field (page number, date...); notes slides rarely use them in
  // the body, but they still belong to the paragraph's visible text.
  return array(paragraph['a:r']).map(runText).join('') + array(paragraph['a:fld']).map(runText).join('');
}

// Placeholders that carry page furniture rather than teacher-written content.
const FURNITURE = new Set(['sldnum', 'hdr', 'ftr', 'dt', 'sldimg']);

function noteText(document) {
  const tree = document?.['p:notes']?.['p:cSld']?.['p:spTree'];
  const lines = [];
  for (const shape of array(tree?.['p:sp'])) {
    const placeholder = shape?.['p:nvSpPr']?.['p:nvPr']?.['p:ph'];
    if (FURNITURE.has(String(placeholder?.['@type'] ?? '').toLowerCase())) continue;
    const body = shape?.['p:txBody'];
    if (!body) continue;
    for (const paragraph of array(body['a:p'])) {
      const text = paragraphText(paragraph).replace(/\u000b/g, '\n').replace(/[ \t]+$/gmu, '');
      if (text.trim()) lines.push(text);
    }
  }
  return lines.join('\n').trim();
}

async function openZip(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

/**
 * @param {string} input path to a .pptx file
 * @returns {Promise<Array<{slide:number,text:string}>>} slides with non-empty notes, in deck order
 */
async function extractPptxNotes(input) {
  const zip = await openZip(input);
  const entries = new Map();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        if (entries.size >= MAX_ENTRIES || entries.has(entry.fileName)) {
          reject(new Error('PPTX 文件条目过多或重复'));
          return;
        }
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });

    const stream = entry => new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
    async function xml(name) {
      const entry = entries.get(name);
      if (!entry || entry.uncompressedSize > MAX_PART_BYTES) throw new Error('PPTX 页面结构缺失或过大');
      const chunks = [];
      let size = 0;
      for await (const chunk of await stream(entry)) {
        size += chunk.length;
        if (size > MAX_PART_BYTES) throw new Error('PPTX XML 过大');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    }

    const presentation = parse(await xml('ppt/presentation.xml'));
    const rels = relationships(await xml('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
    const slides = array(presentation?.['p:presentation']?.['p:sldIdLst']?.['p:sldId']);
    if (slides.length > MAX_SLIDES) throw new Error('PPTX 页数过多');

    const notes = [];
    let totalChars = 0;
    for (let i = 0; i < slides.length; i++) {
      const slide = rels.get(slides[i]['@r:id'])?.path;
      if (!slide) throw new Error('PPTX 页码关系无效');
      const relationFile = path.posix.join(path.posix.dirname(slide), '_rels', path.posix.basename(slide) + '.rels');
      if (!entries.has(relationFile)) continue;
      const notesPath = [...relationships(await xml(relationFile), slide).values()]
        .find(ref => /\/notesSlide$/u.test(ref.type) && ref.path?.startsWith('ppt/notesSlides/'))?.path;
      if (!notesPath || !entries.has(notesPath)) continue;
      let text = noteText(parse(await xml(notesPath))).slice(0, MAX_NOTE_CHARS);
      if (!text) continue;
      totalChars += text.length;
      if (totalChars > MAX_TOTAL_CHARS) break;
      notes.push({ slide: i + 1, text });
    }
    return notes;
  } finally {
    try { zip.close(); } catch { /* already closed */ }
  }
}

module.exports = { extractPptxNotes, MAX_NOTE_CHARS, MAX_SLIDES };
