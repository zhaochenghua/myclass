const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const yauzl = require('yauzl');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: false });
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
function findVideoIds(node, ids = new Set()) {
  if (!node || typeof node !== 'object') return ids;
  for (const [key, value] of Object.entries(node)) {
    if (/(^|:)(videoFile|media)$/.test(key)) for (const element of array(value)) {
      const id = element?.['@r:embed'] || element?.['@r:link']; if (id) ids.add(id);
    }
    if (!key.startsWith('@')) for (const child of array(value)) findVideoIds(child, ids);
  }
  return ids;
}

async function extractPptxVideos(input, output) {
  const zip = await new Promise((resolve, reject) => yauzl.open(input, { lazyEntries: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = new Map();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        if (entries.size >= 20000 || entries.has(entry.fileName)) { reject(new Error('PPTX 文件条目过多或重复')); return; }
        entries.set(entry.fileName, entry); zip.readEntry();
      }); zip.readEntry();
    });
    const stream = entry => new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
    async function xml(name) {
      const entry = entries.get(name); if (!entry || entry.uncompressedSize > 8 * 1024 * 1024) throw new Error('PPTX 页面结构缺失或过大');
      const chunks = []; let size = 0;
      for await (const chunk of await stream(entry)) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('PPTX XML 过大'); chunks.push(chunk); }
      return Buffer.concat(chunks).toString('utf8');
    }
    const presentation = parse(await xml('ppt/presentation.xml'));
    const rels = relationships(await xml('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
    const slides = array(presentation?.['p:presentation']?.['p:sldIdLst']?.['p:sldId']);
    if (slides.length > 10000) throw new Error('PPTX 页数过多');
    const videos = [], files = new Map(); let totalBytes = 0;
    await fsp.mkdir(output, { recursive: true });
    for (let i = 0; i < slides.length; i++) {
      const slide = rels.get(slides[i]['@r:id'])?.path;
      if (!slide) throw new Error('PPTX 页码关系无效');
      const document = parse(await xml(slide));
      const relationFile = path.posix.join(path.posix.dirname(slide), '_rels', path.posix.basename(slide) + '.rels');
      if (!entries.has(relationFile)) continue;
      const refs = relationships(await xml(relationFile), slide);
      const seen = new Set();
      for (const id of findVideoIds(document)) {
        const ref = refs.get(id), media = ref?.path;
        if (!media || !/\/(video|media)$/.test(ref.type) || seen.has(media)) continue;
        const ext = path.posix.extname(media).toLowerCase();
        if (!['.mp4', '.m4v', '.mov', '.webm', '.wmv', '.avi', '.mpeg', '.mpg', '.3gp'].includes(ext)) continue;
        seen.add(media);
        const entry = entries.get(media); if (!entry) throw new Error('PPTX 内嵌视频文件缺失');
        if (videos.length >= 200) throw new Error('PPTX 内嵌视频数量过多');
        let file = files.get(media);
        if (!file) {
          totalBytes += entry.uncompressedSize;
          if (entry.uncompressedSize > 1024 ** 3 || totalBytes > 2 * 1024 ** 3) throw new Error('PPTX 内嵌视频过大');
          file = `video-${files.size + 1}${ext}`;
          let written = 0;
          const limit = new Transform({ transform(chunk, encoding, callback) {
            written += chunk.length;
            callback(written > entry.uncompressedSize ? new Error('视频解压大小不符') : null, chunk);
          } });
          await pipeline(await stream(entry), limit, fs.createWriteStream(path.join(output, file), { flags: 'wx' }));
          files.set(media, file);
        }
        videos.push({ slide: i + 1, file, title: `第 ${i + 1} 页视频 ${seen.size}` });
      }
    }
    await fsp.writeFile(path.join(output, 'videos.json'), JSON.stringify(videos));
    return videos;
  } finally { try { zip.close(); } catch {} }
}
module.exports = { extractPptxVideos };
