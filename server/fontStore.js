const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { XMLParser } = require('fast-xml-parser');

const MAX_FONT_BYTES = 64 * 1024 * 1024;
const FORMAT = '<font><file>%{file|xmlescape}</file><family>%{family|xmlescape}</family><style>%{style|xmlescape}</style></font>';
const execute = promisify(execFile);
const parser = new XMLParser({ parseTagValue: false, processEntities: true });

function fontError(status, message) {
  return Object.assign(new Error(message), { status, publicMessage: message });
}

function parseFonts(output) {
  const fonts = parser.parse(`<fonts>${output}</fonts>`).fonts?.font || [];
  return (Array.isArray(fonts) ? fonts : [fonts]).filter(font => typeof font.family === 'string' && font.family.trim());
}

async function run(command, args) {
  try {
    return (await execute(command, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw fontError(503, '服务器缺少 fontconfig，暂不能安装字体');
    const message = command === 'fc-scan' ? '无法读取字体，请检查文件是否完整'
      : command === 'fc-list' ? '读取服务器字体列表失败，请稍后重试' : '字体缓存刷新失败，请稍后重试';
    throw fontError(500, message);
  }
}

function createFontStore({ root = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'fonts', 'myclass-uploaded'), runner = run,
  supported = process.platform === 'linux' } = {}) {
  root = path.resolve(root);
  let revision = '';
  let queue = Promise.resolve();
  let ready;

  async function initialize() {
    if (!ready) ready = (async () => {
      if (!supported) return;
      await fs.mkdir(root, { recursive: true });
      await updateRevision();
    })().catch(error => { ready = undefined; throw error; });
    return ready;
  }

  async function updateRevision() {
    const names = (await fs.readdir(root)).filter(name => /^[a-f0-9]{64}\.(ttf|otf|ttc)$/.test(name)).sort();
    revision = names.length ? crypto.createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 12) : '';
  }

  async function list() {
    await initialize();
    if (!supported) return { supported: false, maxBytes: MAX_FONT_BYTES, items: [], message: '当前服务器暂不支持字体安装，需要 Linux 和 fontconfig' };
    const fonts = parseFonts(await runner('fc-list', ['--format', FORMAT]));
    const grouped = new Map();
    for (const font of fonts) {
      const family = font.family.trim();
      const source = path.dirname(path.resolve(font.file || '')) === root ? 'uploaded' : 'system';
      const key = `${family}\0${source}`;
      if (!grouped.has(key)) grouped.set(key, { family, styles: new Set(), source });
      grouped.get(key).styles.add(font.style || 'Regular');
    }
    return { supported: true, maxBytes: MAX_FONT_BYTES,
      items: [...grouped.values()].map(item => ({ ...item, styles: [...item.styles].sort() })).sort((a, b) => a.family.localeCompare(b.family, 'zh-CN')) };
  }

  async function install(file, originalName) {
    await initialize();
    if (!supported) throw fontError(503, '当前服务器暂不支持字体安装，需要 Linux 和 fontconfig');
    const extension = path.extname(originalName || '').toLowerCase();
    if (!['.ttf', '.otf', '.ttc'].includes(extension)) throw fontError(400, '仅支持 TTF、OTF、TTC 字体文件');
    const data = await fs.readFile(file);
    if (data.length > MAX_FONT_BYTES) throw fontError(413, '单个字体不能超过 64MB');
    if (data.length < 12 || !['00010000', '4f54544f', '74746366', '74727565'].includes(data.subarray(0, 4).toString('hex'))) {
      throw fontError(400, '文件不是有效的 TTF、OTF、TTC 字体');
    }
    let faces;
    try { faces = parseFonts(await runner('fc-scan', ['--format', FORMAT, file])); }
    catch (error) { if (error.status === 503) throw error; throw fontError(400, '字体损坏或格式不受支持，请使用完整字体文件'); }
    if (!faces.length) throw fontError(400, '字体文件不含可安装的字形');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const operation = queue.catch(() => {}).then(async () => {
      const existing = (await fs.readdir(root)).find(name => name.startsWith(`${hash}.`));
      const destination = path.join(root, `${hash}${extension}`);
      const duplicate = !!existing;
      if (!duplicate) {
        const staging = path.join(root, `.pending-${crypto.randomUUID()}`);
        try {
          await fs.copyFile(file, staging, fs.constants.COPYFILE_EXCL);
          await fs.rename(staging, destination);
        } finally { await fs.rm(staging, { force: true }); }
      }
      try {
        await runner('fc-cache', ['-f', root]);
      } catch (error) {
        if (!duplicate) await fs.rm(destination, { force: true });
        throw error;
      }
      await updateRevision();
      return { duplicate, faces: faces.map(({ family, style }) => ({ family, style: style || 'Regular' })) };
    });
    queue = operation;
    return operation;
  }

  return { initialize, list, install, revision: () => revision };
}

module.exports = { createFontStore, MAX_FONT_BYTES };
