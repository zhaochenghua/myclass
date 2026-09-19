const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OFFICE = new Set(['.ppt', '.pptx', '.doc', '.docx']);
const VIDEO = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.3gp']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const EXTENSIONS = ['.pdf', '.zip', ...OFFICE, ...VIDEO, ...IMAGE];

function storageError(status, message) {
  return Object.assign(new Error(message), { status, publicMessage: message });
}

// One store per server process. All index mutations (including file publication
// and removal) share this queue; readers see either the old or the new index.
function createCoursewareStore({ root, prefix, convertOfficeToPdf, listLimit = 0 }) {
  root = path.resolve(root);
  const indexPath = path.join(root, 'index.json');
  const objectsRoot = path.join(root, '.objects');
  fs.mkdirSync(objectsRoot, { recursive: true });
  let writes = Promise.resolve();
  let initialization;

  function mutate(operation) {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }

  function checkId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
      throw storageError(400, '无效课件编号');
    }
  }

  async function readIndex() {
    if (!initialization) {
      initialization = initializeIndex().catch(error => {
        initialization = undefined;
        throw error;
      });
    }
    await initialization;
    return loadIndex();
  }

  async function loadIndex() {
    const items = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || !item.id || !item.url)) {
      throw new SyntaxError('Invalid courseware index');
    }
    return items;
  }

  async function initializeIndex() {
    try {
      await loadIndex();
    } catch (error) {
      // A corrupt index must never be replaced with an empty one on upload.
      if (error.code !== 'ENOENT') throw error;
      // Compatibility for installations predating index.json. Once an index
      // exists, unindexed files are NOT reintroduced as publicly shared files.
      const items = [];
      for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue;
        const id = path.basename(entry.name, '.pdf');
        checkId(id);
        const stat = await fs.promises.stat(path.join(root, entry.name));
        items.push({ id, userId: 'legacy', title: id, fileName: entry.name,
          size: stat.size, createdAt: stat.birthtime.toISOString(), url: urlFor(id, '.pdf') });
      }
      // Persist before publishing any new aliases so concurrent readers cannot
      // mistake the first pending upload for a legacy/shared document.
      await saveIndex(items);
    }
  }

  async function saveIndex(items) {
    const temporary = path.join(root, `.index-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(items, null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(temporary, indexPath);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  function urlFor(id, ext) {
    return `${prefix}/public/courseware/${id}${ext}`;
  }

  function objectDirectory(key) {
    if (!/^[a-f0-9]{64}\.(pdf|zip|pptx?|docx?|mp4|mov|avi|webm|mkv|3gp|jpe?g|png|gif|webp|bmp)$/.test(key)) {
      throw new Error('Invalid courseware storage key');
    }
    return path.join(objectsRoot, key.slice(0, 2), key);
  }

  async function hashFile(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
  }

  async function linkFile(source, destination) {
    try {
      await fs.promises.link(source, destination);
    } catch (error) {
      // Some network filesystems do not support hard links. Preserve behavior,
      // but such volumes cannot provide the same disk-space savings.
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    }
  }

  async function publish(file, originalName, userId) {
    const ext = path.extname(originalName).toLowerCase();
    if (!EXTENSIONS.includes(ext)) {
      throw storageError(400, '仅支持 PDF、PPT、PPTX、DOC、DOCX、ZIP、图片、视频文件');
    }
    // Stream hashing keeps memory usage bounded even for multi-GB videos.
    const storageKey = `${await hashFile(file.path)}${ext}`;
    return mutate(async () => {
      const items = await readIndex();
      const bundle = objectDirectory(storageKey);
      const original = path.join(bundle, `original${ext}`);
      const preview = OFFICE.has(ext) ? path.join(bundle, 'preview.pdf') : original;
      let newBundle = false;
      const aliases = [];
      try {
        try {
          await fs.promises.access(bundle);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const staging = await fs.promises.mkdtemp(path.join(objectsRoot, '.pending-'));
          try {
            const stagedOriginal = path.join(staging, `original${ext}`);
            await fs.promises.copyFile(file.path, stagedOriginal);
            if (OFFICE.has(ext)) {
              await convertOfficeToPdf(stagedOriginal, ext, path.join(staging, 'preview.pdf'), crypto.randomUUID());
            }
            await fs.promises.mkdir(path.dirname(bundle), { recursive: true });
            await fs.promises.rename(staging, bundle);
            newBundle = true;
          } finally {
            await fs.promises.rm(staging, { recursive: true, force: true });
          }
        }
        const originalStat = await fs.promises.stat(original);
        const previewStat = await fs.promises.stat(preview);
        const id = crypto.randomUUID();
        const outputExt = OFFICE.has(ext) ? '.pdf' : ext;
        const result = { id, userId: userId || 'legacy', title: path.basename(originalName, path.extname(originalName)),
          fileName: originalName, size: previewStat.size, createdAt: new Date().toISOString(),
          url: urlFor(id, outputExt), storageKey };
        const output = path.join(root, `${id}${outputExt}`);
        // Record before copying, so a partial fallback copy is cleaned up too.
        aliases.push(output);
        await linkFile(preview, output);
        if (OFFICE.has(ext)) {
          const originalAlias = path.join(root, `${id}${ext}`);
          aliases.push(originalAlias);
          await linkFile(original, originalAlias);
          result.originalUrl = urlFor(id, ext);
          result.originalSize = originalStat.size;
        } else if (ext === '.pdf') {
          result.originalUrl = result.url;
          result.originalSize = originalStat.size;
        } else {
          result.downloadOnly = ext === '.zip';
          if (VIDEO.has(ext)) result.videoUrl = result.url;
          if (IMAGE.has(ext)) result.imageUrl = result.url;
        }
        await saveIndex([result, ...items]);
        return result;
      } catch (error) {
        for (const alias of aliases) await fs.promises.rm(alias, { force: true });
        if (newBundle) await fs.promises.rm(bundle, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function list(userId) {
    const items = (await readIndex())
      .filter(item => !userId || !item.userId || item.userId === 'admin' || item.userId === 'legacy' || item.userId === userId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const visible = [];
    for (const item of items) {
      if (!item.linkUrl) {
        checkId(item.id);
        const ext = path.extname(new URL(item.url, 'http://localhost').pathname).toLowerCase();
        if (!EXTENSIONS.includes(ext)) continue;
        try {
          await fs.promises.access(path.join(root, `${item.id}${ext}`));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
      }
      visible.push(item);
      if (listLimit > 0 && visible.length >= listLimit) break;
    }
    return visible;
  }

  function canEdit(item, userId) {
    return userId === null || !item.userId || item.userId === userId;
  }

  function remember(item) {
    return mutate(async () => {
      const items = await readIndex();
      await saveIndex([item, ...items.filter(existing => existing.id !== item.id)]);
    });
  }

  function remove(id, userId) {
    checkId(id);
    return mutate(async () => {
      const items = await readIndex();
      const item = items.find(entry => entry.id === id);
      if (!item || !canEdit(item, userId)) return false;
      const remaining = items.filter(entry => entry.id !== id);
      // Commit metadata first: a failed index write leaves all files intact.
      // If interrupted afterwards, leftover files stay unlisted, never shared.
      await saveIndex(remaining);
      if (!item.linkUrl) {
        for (const ext of EXTENSIONS) await fs.promises.rm(path.join(root, `${id}${ext}`), { force: true });
        if (item.storageKey && !remaining.some(entry => entry.storageKey === item.storageKey)) {
          await fs.promises.rm(objectDirectory(item.storageKey), { recursive: true, force: true });
        }
      }
      return true;
    });
  }

  function rename(id, title, userId) {
    checkId(id);
    return mutate(async () => {
      const items = await readIndex();
      const item = items.find(entry => entry.id === id);
      if (!item || !canEdit(item, userId)) return false;
      item.title = title;
      await saveIndex(items);
      return true;
    });
  }

  return { publish, list, remember, remove, rename, readIndex };
}

module.exports = { createCoursewareStore };
