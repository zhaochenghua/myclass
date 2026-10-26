// Extracts the font families referenced by an OOXML courseware package without
// opening the document in LibreOffice. Only .pptx/.docx are ZIP/XML packages;
// legacy binary .ppt/.doc files carry font names in an OLE stream that is not
// parsed here, so they report "unsupported" and never claim fonts are missing.
const yauzl = require('yauzl');
const { isFontReference, normalizeFontFamily } = require('./fontNames');

const PREFIX = { '.pptx': 'ppt/', '.docx': 'word/' };
const MAX_ENTRIES = 10000;
const MAX_PART_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attributes(xml, pattern) {
  const values = [];
  for (const match of xml.matchAll(pattern)) values.push(match[1] ?? match[2] ?? '');
  return values;
}

function fontsInXml(xml, ext) {
  const names = attributes(xml, /\btypeface\s*=\s*(?:"([^"]*)"|'([^']*)')/gu);
  if (ext === '.docx') {
    // Word runs and styles point at fonts through w:rFonts; fontTable declares
    // every face the package references, including unused theme faces.
    for (const tag of xml.matchAll(/<w:rFonts\b[^>]*>/gu)) {
      names.push(...attributes(tag[0], /\bw:(?:ascii|hAnsi|eastAsia|cs)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu));
    }
    names.push(...attributes(xml, /<w:font\b[^>]*\bw:name\s*=\s*(?:"([^"]*)"|'([^']*)')/gu));
  }
  return names.map(decodeXmlEntities);
}

function openZip(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function nextEntry(zip) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      zip.removeListener('error', onError);
    }
    function onEntry(entry) { cleanup(); resolve(entry); }
    function onEnd() { cleanup(); resolve(null); }
    function onError(error) { cleanup(); reject(error); }
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function readXmlPart(zip, entry, limit) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    zip.openReadStream(entry, (error, stream) => {
      if (error) { settle(reject, error); return; }
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          stream.destroy();
          settle(reject, new Error('课件字体信息过大'));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', streamError => settle(reject, streamError));
      stream.once('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')));
    });
  });
}

async function extractDocumentFonts(filename, extension) {
  const ext = String(extension || '').toLowerCase();
  const prefix = PREFIX[ext];
  if (!prefix) return { supported: false, fonts: [] };
  const zip = await openZip(filename);
  // Late stream/central-directory errors must not become unhandled events after
  // a bounded read aborts; entry iteration surfaces its own errors.
  const ignoreLateError = () => {};
  zip.on('error', ignoreLateError);
  const found = new Map();
  let entries = 0;
  let declaredBytes = 0;
  let actualBytes = 0;
  try {
    for (;;) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      entries++;
      if (entries > MAX_ENTRIES) throw new Error('课件包含过多文件，无法检查字体');
      if (!entry.fileName.startsWith(prefix) || !/\.xml$/iu.test(entry.fileName)) continue;
      if (entry.uncompressedSize > MAX_PART_BYTES) continue;
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > MAX_TOTAL_BYTES) throw new Error('课件字体信息过大，无法检查字体');
      // ZIP headers can understate the actual decompressed size; bound the
      // stream itself as well so a crafted package cannot exhaust memory.
      const xml = await readXmlPart(zip, entry, Math.min(MAX_PART_BYTES, MAX_TOTAL_BYTES - actualBytes));
      actualBytes += Buffer.byteLength(xml);
      for (const name of fontsInXml(xml, ext)) {
        if (!isFontReference(name)) continue;
        const key = normalizeFontFamily(name);
        if (!found.has(key)) found.set(key, String(name).trim());
      }
    }
  } finally {
    // The listener stays attached for the object's lifetime: an error emitted
    // after close (e.g. while a destroyed stream unwinds) must not crash.
    try { zip.close(); } catch { /* already closed by autoClose */ }
  }
  return { supported: true, fonts: [...found.values()].sort((a, b) => a.localeCompare(b, 'zh-CN')) };
}

module.exports = { extractDocumentFonts };
