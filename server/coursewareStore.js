const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AnnotationStore } = require('./annotationStore');
const { extractPptxVideos } = require('./pptxVideos');

const OFFICE = new Set(['.ppt', '.pptx', '.doc', '.docx']);
const VIDEO = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.3gp']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const EXTENSIONS = ['.pdf', '.zip', ...OFFICE, ...VIDEO, ...IMAGE];

function storageError(status, message) {
  return Object.assign(new Error(message), { status, publicMessage: message });
}

function normalizeLink(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''; }
  catch { return ''; }
}

// One store per server process. All index mutations (including file publication
// and removal) share this queue; readers see either the old or the new index.
function createCoursewareStore({ root, prefix, convertOfficeToPdf, listLimit = 0, officeProfile = () => '',
  detectMissingFonts = null }) {
  root = path.resolve(root);
  const indexPath = path.join(root, 'index.json');
  const objectsRoot = path.join(root, '.objects');
  fs.mkdirSync(objectsRoot, { recursive: true });
  const annotations = new AnnotationStore(path.join(root, '.annotations'));
  let writes = Promise.resolve();
  let initialization;
  const preparations = new Map();
  const embeddedJobs = new Map();

  // Only identical objects wait for each other. Conversion must never occupy
  // the global metadata transaction queue (and block unrelated tiny uploads).
  async function withObject(key, operation) {
    const previous = preparations.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    preparations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (preparations.get(key) === pending) {
        await mutate(async () => {
          if (preparations.get(key) !== pending) return;
          preparations.delete(key);
          const items = await readIndex();
          if (!items.some(item => item.storageKey === key)) {
            await fs.promises.rm(objectDirectory(key), { recursive: true, force: true });
          }
        });
      }
    }
  }

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
    if (!/^[a-f0-9]{64}\.(pdf|zip|pptx?|docx?|mp4|mov|avi|webm|mkv|3gp|jpe?g|png|gif|webp|bmp)(\.[a-z0-9-]{1,64})?$/.test(key)) {
      throw new Error('Invalid courseware storage key');
    }
    return path.join(objectsRoot, key.slice(0, 2), key);
  }

  async function hashFile(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
  }

  // Office records keep the original next to the generated PDF; derive its
  // location from the stored record so regeneration also works for legacy
  // entries that predate storage keys.
  function officeExtensionFor(item) {
    if (!item || item.linkUrl) return null;
    for (const value of [item.originalUrl, item.fileName, item.url]) {
      if (typeof value !== 'string' || !value) continue;
      let pathname;
      try { pathname = new URL(value, 'http://localhost').pathname; } catch { pathname = value; }
      const ext = path.extname(pathname).toLowerCase();
      if (OFFICE.has(ext)) return ext;
    }
    return null;
  }

  // The object bundle is authoritative, but an alias may outlive a manually
  // pruned object directory; try both before declaring the original missing.
  async function resolveOriginal(item, ext) {
    checkId(item.id);
    const candidates = [];
    if (item.storageKey) candidates.push(path.join(objectDirectory(item.storageKey), `original${ext}`));
    candidates.push(path.join(root, `${item.id}${ext}`));
    for (const candidate of candidates) {
      if (await fs.promises.access(candidate).then(() => true, () => false)) return candidate;
    }
    return null;
  }

  // Detection is advisory: a font we cannot read must never fail an upload.
  async function detectFontsFor(file, ext) {
    if (!detectMissingFonts || !OFFICE.has(ext)) return [];
    try {
      const missing = await detectMissingFonts(file, ext);
      return Array.isArray(missing) ? missing.filter(name => typeof name === 'string' && name.trim()) : [];
    } catch (error) {
      console.warn('课件字体检测失败:', error.message);
      return [];
    }
  }

  // Convert a source file into a content-addressed bundle. Conversion happens
  // in a staging directory so a crash never publishes a half-written object.
  async function buildBundle(sourceFile, ext, bundle) {
    const staging = await fs.promises.mkdtemp(path.join(objectsRoot, '.pending-'));
    try {
      const stagedOriginal = path.join(staging, `original${ext}`);
      await fs.promises.copyFile(sourceFile, stagedOriginal);
      if (OFFICE.has(ext)) {
        const conversion = await convertOfficeToPdf(stagedOriginal, ext, path.join(staging, 'preview.pdf'), crypto.randomUUID());
        if (conversion) await fs.promises.writeFile(path.join(staging, 'conversion.json'), JSON.stringify(conversion));
        if (ext === '.pptx') {
          try { await extractPptxVideos(stagedOriginal, path.join(staging, 'embedded')); }
          catch (error) {
            await fs.promises.rm(path.join(staging, 'embedded'), { recursive: true, force: true });
            console.warn('PPTX video extraction deferred:', error.message);
          }
        }
      }
      await fs.promises.mkdir(path.dirname(bundle), { recursive: true });
      await fs.promises.rename(staging, bundle);
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
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

  async function publish(file, originalName, userId, uploadRequestId = '') {
    if (uploadRequestId && !/^[a-zA-Z0-9-]{1,80}$/.test(uploadRequestId)) throw storageError(400, '无效上传编号');
    const ext = path.extname(originalName).toLowerCase();
    if (!EXTENSIONS.includes(ext)) {
      throw storageError(400, '仅支持 PDF、PPT、PPTX、DOC、DOCX、ZIP、图片、视频文件');
    }
    // Stream hashing keeps memory usage bounded even for multi-GB videos.
    const profile = OFFICE.has(ext) ? officeProfile(ext) : '';
    if (profile && !/^[a-z0-9-]{1,64}$/.test(profile)) throw new Error('Invalid Office conversion profile');
    const storageKey = `${await hashFile(file.path)}${ext}${profile ? `.${profile}` : ''}`;
    return withObject(storageKey, async () => {
      await readIndex();
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
          await buildBundle(file.path, ext, bundle);
          newBundle = true;
        }
        // Check the original already stored in the bundle, so a deduplicated
        // upload reports the same missing fonts as the first one.
        const missingFonts = await detectFontsFor(original, ext);
        return await mutate(async () => {
        const items = await readIndex();
        const existing = uploadRequestId && items.find(item => item.userId === userId && item.uploadRequestId === uploadRequestId);
        if (existing) {
          if (existing.storageKey !== storageKey) throw storageError(409, '上传编号已用于其他文件');
          return existing;
        }
        const originalStat = await fs.promises.stat(original);
        const previewStat = await fs.promises.stat(preview);
        const id = crypto.randomUUID();
        const outputExt = OFFICE.has(ext) ? '.pdf' : ext;
        const result = { id, userId: userId || 'legacy', title: path.basename(originalName, path.extname(originalName)),
          fileName: originalName, size: previewStat.size, createdAt: new Date().toISOString(),
          url: urlFor(id, outputExt), storageKey };
        if (uploadRequestId) result.uploadRequestId = uploadRequestId;
        if (OFFICE.has(ext)) {
          result.missingFonts = missingFonts;
          try { result.conversion = JSON.parse(await fs.promises.readFile(path.join(bundle, 'conversion.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
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
        });
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
      const { playbackByUser, ...publicItem } = item;
      visible.push({ ...publicItem, playbackProgress: playbackByUser?.[userId || item.userId] || null });
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
      const existing = item.uploadRequestId && items.find(entry => entry.userId === item.userId && entry.uploadRequestId === item.uploadRequestId);
      if (existing) {
        if (existing.linkUrl !== item.linkUrl) throw storageError(409, '上传编号已用于其他链接');
        return existing;
      }
      // Serialize URL deduplication with publication, including simultaneous phones.
      const link = normalizeLink(item.linkUrl);
      const savedLink = link && items.find(entry => entry.userId === item.userId && normalizeLink(entry.linkUrl) === link);
      if (savedLink) return savedLink;
      await saveIndex([item, ...items.filter(existing => existing.id !== item.id)]);
      return item;
    });
  }

  async function hasLink(userId, url) {
    const link = normalizeLink(url);
    if (!link) throw storageError(400, '仅支持有效的 http/https 链接');
    // Do not use list(): it may be capped by COURSEWARE_LIST_LIMIT.
    return (await readIndex()).some(item => item.userId === userId && normalizeLink(item.linkUrl) === link);
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
      await annotations.remove(id);
      // Wait for an in-progress lazy extraction before removing the last copy.
      await embeddedJobs.get(item.storageKey || item.id)?.catch(() => {});
      await fs.promises.rm(path.join(root, '.embedded', id), { recursive: true, force: true });
      if (!item.linkUrl) {
        for (const ext of EXTENSIONS) await fs.promises.rm(path.join(root, `${id}${ext}`), { force: true });
        if (item.storageKey && !preparations.has(item.storageKey) && !remaining.some(entry => entry.storageKey === item.storageKey)) {
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

  // Existing courseware was published before font detection existed. Inspect a
  // bounded batch of Office originals per call; the admin page refreshes the
  // font list, which lets the rest finish on later requests without blocking.
  async function scanMissingFonts(limit = 20) {
    if (!detectMissingFonts) return { scanned: 0, pending: 0 };
    const pendingItems = (await readIndex())
      .filter(item => item.missingFonts === undefined && officeExtensionFor(item));
    const updates = [];
    for (const item of pendingItems.slice(0, Math.max(0, Math.trunc(limit)))) {
      const ext = officeExtensionFor(item);
      try {
        const source = await resolveOriginal(item, ext);
        // A record whose original is gone cannot be checked or regenerated;
        // record an empty list so it does not consume the scan budget forever.
        const missing = source ? (await detectMissingFonts(source, ext)) || [] : [];
        updates.push({ id: item.id, missing });
      } catch (error) {
        // Keep missingFonts undefined so a later font-page refresh retries a
        // transient read failure instead of silently claiming "nothing missing".
        console.warn('课件字体检测失败:', error.message);
      }
    }
    if (updates.length) {
      await mutate(async () => {
        const items = await readIndex();
        const at = new Date().toISOString();
        for (const update of updates) {
          const current = items.find(entry => entry.id === update.id);
          if (!current || current.missingFonts !== undefined) continue;
          current.missingFonts = update.missing;
          current.fontsScannedAt = at;
        }
        await saveIndex(items);
      });
    }
    const pending = (await readIndex()).filter(item => item.missingFonts === undefined && officeExtensionFor(item)).length;
    return { scanned: updates.length, pending };
  }

  // Re-convert an Office original after its missing fonts were installed. The
  // public URL and record ID stay stable; only the cached PDF object changes.
  async function regenerate(id) {
    checkId(id);
    const snapshot = await readIndex();
    const item = snapshot.find(entry => entry.id === id);
    if (!item) return null;
    const title = item.title || item.fileName || item.id;
    const ext = officeExtensionFor(item);
    if (!ext) return null;

    const fail = async message => {
      await mutate(async () => {
        const items = await readIndex();
        const current = items.find(entry => entry.id === id);
        if (!current) return;
        current.regenerateError = message;
        current.regenerateErrorAt = new Date().toISOString();
        await saveIndex(items);
      }).catch(() => {});
      return { ok: false, id, title, error: message };
    };

    try {
      const previousKey = item.storageKey || '';
      const source = await resolveOriginal(item, ext);
      if (!source) return fail('原始课件文件不存在，无法重新生成');
      const profile = officeProfile(ext);
      const storageKey = `${await hashFile(source)}${ext}${profile ? `.${profile}` : ''}`;
      const result = await withObject(storageKey, async () => {
        const bundle = objectDirectory(storageKey);
        let newBundle = false;
        try {
          if (previousKey !== storageKey) {
            try {
              await fs.promises.access(bundle);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              await buildBundle(source, ext, bundle);
              newBundle = true;
            }
          }
          const missingFonts = await detectFontsFor(path.join(bundle, `original${ext}`), ext);
          const preview = path.join(bundle, 'preview.pdf');
          const previewStat = await fs.promises.stat(preview);
          let conversion;
          try { conversion = JSON.parse(await fs.promises.readFile(path.join(bundle, 'conversion.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          return await mutate(async () => {
            const items = await readIndex();
            const current = items.find(entry => entry.id === id);
            if (!current) throw storageError(404, '课件不存在');
            const alias = path.join(root, `${id}.pdf`);
            const temporary = path.join(root, `.${id}-${crypto.randomUUID()}.pdf`);
            const previousPreview = previousKey ? path.join(objectDirectory(previousKey), 'preview.pdf') : '';
            let replacedAlias = false;
            try {
              await linkFile(preview, temporary);
              await fs.promises.rename(temporary, alias);
              replacedAlias = true;
              current.storageKey = storageKey;
              current.size = previewStat.size;
              current.missingFonts = missingFonts;
              current.regeneratedAt = new Date().toISOString();
              if (conversion) current.conversion = conversion;
              else delete current.conversion;
              delete current.regenerateError;
              delete current.regenerateErrorAt;
              await saveIndex(items);
              return { ok: true, id, title: current.title || title, missingFonts, storageKey };
            } catch (error) {
              // The index still points at the old object; put its PDF back.
              if (replacedAlias && previousPreview) {
                const restore = path.join(root, `.${id}-${crypto.randomUUID()}.pdf`);
                try {
                  await linkFile(previousPreview, restore);
                  await fs.promises.rename(restore, alias);
                } catch { /* keep whatever preview is already published */ }
                finally { await fs.promises.rm(restore, { force: true }); }
              }
              throw error;
            } finally {
              await fs.promises.rm(temporary, { force: true });
            }
          });
        } catch (error) {
          if (newBundle) await fs.promises.rm(bundle, { recursive: true, force: true });
          throw error;
        }
      });
      // Only reclaim the superseded object once no record references it.
      if (previousKey && previousKey !== storageKey && !preparations.has(previousKey)) {
        await mutate(async () => {
          const items = await readIndex();
          if (!items.some(entry => entry.storageKey === previousKey)) {
            await fs.promises.rm(objectDirectory(previousKey), { recursive: true, force: true });
          }
        }).catch(error => console.warn('旧课件缓存清理失败:', error.message));
      }
      return result;
    } catch (error) {
      return fail(error.publicMessage || error.message || '重新生成课件失败');
    }
  }

  function savePlayback(userId, url, page, pageCount) {
    if (!userId || !Number.isInteger(page) || !Number.isInteger(pageCount) ||
        page < 1 || pageCount < page || pageCount > 100000) return Promise.resolve(false);
    return mutate(async () => {
      const items = await readIndex();
      const item = items.find(entry => entry.url === url);
      if (!item || (item.userId && !['admin', 'legacy', userId].includes(item.userId))) return false;
      const previous = item.playbackByUser?.[userId];
      if (previous?.page === page && previous.pageCount === pageCount) return true;
      item.playbackByUser = { ...item.playbackByUser,
        [userId]: { page, pageCount, updatedAt: new Date().toISOString() } };
      // Keep retries inside the mutation queue: an older retry must never
      // overwrite a more recent page or another teacher's progress.
      for (let attempt = 0; ; attempt++) {
        try { await saveIndex(items); break; }
        catch (error) {
          if (attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      return true;
    });
  }

  // File IDs, not titles or content hashes, own notes. Copies belonging to
  // different teachers therefore never inherit each other's handwriting.
  function fileNotes(userId, url, message, role) {
    return mutate(async () => {
      let pathname;
      try { pathname = new URL(url, 'http://local').pathname; } catch { return null; }
      const item = (await readIndex()).find(entry => entry.url === pathname);
      if (!userId || !item || item.linkUrl || !/\.(pdf|jpe?g|png|gif|webp|bmp)$/i.test(pathname) ||
          (item.userId && !['admin', 'legacy', userId].includes(item.userId))) return null;
      const notes = message ? await annotations.apply(item.id, message, role) : await annotations.load(item.id);
      return message ? true : JSON.parse(JSON.stringify({ strokes: notes.strokes, active: [...notes.active.values()],
        ...(Object.values(notes.cleared).some(history => history.length) ? { cleared: notes.cleared } : {}) }));
    });
  }

  async function embeddedVideos(item) {
    if (!item?.originalUrl?.endsWith('.pptx')) return { videos: [] };
    checkId(item.id);
    const directory = item.storageKey ? path.join(objectDirectory(item.storageKey), 'embedded') : path.join(root, '.embedded', item.id);
    const key = item.storageKey || item.id;
    let task = embeddedJobs.get(key);
    if (!task) {
      task = (async () => {
        try { return JSON.parse(await fs.promises.readFile(path.join(directory, 'videos.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.promises.mkdir(path.dirname(directory), { recursive: true });
        const staging = await fs.promises.mkdtemp(path.join(path.dirname(directory), '.videos-'));
        try {
          const videos = await extractPptxVideos(path.join(root, `${item.id}.pptx`), staging);
          await fs.promises.rename(staging, directory);
          return videos;
        } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
      })();
      embeddedJobs.set(key, task);
    }
    try {
      const videos = await task;
      return { directory, videos: videos.map((video, index) => ({ ...video, index,
        url: `${prefix}/public/courseware/${item.id}.video/${index}` })) };
    } finally { if (embeddedJobs.get(key) === task) embeddedJobs.delete(key); }
  }

  return { publish, list, remember, remove, rename, readIndex, savePlayback, hasLink, fileNotes,
    embeddedVideos, scanMissingFonts, regenerate };
}

module.exports = { createCoursewareStore };
