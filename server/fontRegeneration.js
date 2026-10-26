// Orchestrates the admin font workflow: report which fonts courseware needs but
// the server lacks, then re-convert the affected Office originals after a font
// is installed. Kept separate from server.js so the sequencing (limits, retries
// and serialization) can be tested without LibreOffice or fontconfig.
const { summarizeMissingFonts, needsRegeneration, ownedBy } = require('./missingFonts');

function integer(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.trunc(number)) : fallback;
}

function createFontRegeneration({ fontStore, coursewareStore, limit = 10, scanLimit = 10 }) {
  const batchLimit = integer(limit, 10, 1);
  const batchScan = integer(scanLimit, 10, 0);
  let queue = Promise.resolve();

  // Missing state and pending work are scoped to the requester's own
  // courseware (administrators also see the shared/legacy platform bucket).
  // Installing a font is still server-wide, but one teacher must not rewrite
  // another teacher's published PDFs.
  async function state(user) {
    const families = await fontStore.knownFamilies();
    if (!families) return { missingFonts: [], missingCourseware: 0, pendingRegeneration: 0, scanPending: 0 };
    let scanPending = 0;
    if (batchScan > 0) {
      const scan = await coursewareStore.scanMissingFonts(batchScan)
        .catch(error => {
          console.warn('课件字体检测跳过:', error.message);
          return { scanned: 0, pending: 0 };
        });
      scanPending = Number(scan?.pending) || 0;
    }
    const items = await coursewareStore.readIndex();
    const isAdmin = user?.role === 'admin';
    const summary = summarizeMissingFonts(items, families, { userId: user?.id, isAdmin });
    return {
      missingFonts: summary.fonts,
      missingCourseware: summary.coursewareCount,
      pendingRegeneration: items.filter(item => needsRegeneration(item, families) && ownedBy(item, user?.id, isAdmin)).length,
      scanPending
    };
  }

  async function run({ force = false, user } = {}) {
    const families = await fontStore.knownFamilies();
    if (!families) return { supported: false, regenerated: [], failed: [], remaining: 0 };
    const isAdmin = user?.role === 'admin';
    const owned = (await coursewareStore.readIndex())
      .filter(item => ownedBy(item, user?.id, isAdmin) && needsRegeneration(item, families));
    // A previous failure is retried only on explicit request, so the automatic
    // pass after an upload cannot hammer the same broken document.
    const targets = (force ? owned : owned.filter(item => !item.regenerateError)).slice(0, batchLimit);
    const regenerated = [];
    const failed = [];
    for (const item of targets) {
      try {
        const result = await coursewareStore.regenerate(item.id);
        if (!result) continue;
        if (result.ok) regenerated.push({ id: result.id, title: result.title, missingFonts: result.missingFonts });
        else failed.push({ id: result.id, title: result.title, error: result.error });
      } catch (error) {
        failed.push({ id: item.id, title: item.title || item.fileName || item.id, error: error.message || '重新生成失败' });
      }
    }
    const remaining = (await coursewareStore.readIndex())
      .filter(item => ownedBy(item, user?.id, isAdmin) && needsRegeneration(item, families)).length;
    return { supported: true, regenerated, failed, remaining };
  }

  // Font uploads from two devices must not convert the same courseware twice
  // concurrently; a new call waits for the previous batch to finish.
  function regenerate(options = {}) {
    const task = queue.catch(() => {}).then(() => run(options));
    queue = task;
    return task;
  }

  return { state, regenerate };
}

module.exports = { createFontRegeneration };
