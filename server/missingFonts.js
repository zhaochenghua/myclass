// Pure aggregation helpers for the admin "missing fonts" prompt. Courseware
// records store the families that were absent when their PDF was generated;
// the installed font set only grows, so the prompt is recomputed on every read
// and already-installed fonts disappear without waiting for a regeneration.
const { normalizeFontFamily, isFontReference, isFamilyInstalled } = require('./fontNames');

function visibleTo(item, userId, isAdmin) {
  if (isAdmin) return true;
  return !item.userId || item.userId === 'admin' || item.userId === 'legacy' || item.userId === userId;
}

function stillMissing(item, families) {
  if (!Array.isArray(item.missingFonts) || !families) return [];
  return item.missingFonts.filter(name => isFontReference(name) && !isFamilyInstalled(name, families));
}

// True when at least one font recorded as missing has since been installed, so
// converting the original again can improve the published PDF.
function needsRegeneration(item, families) {
  return Boolean(families) && Array.isArray(item.missingFonts) &&
    item.missingFonts.some(name => isFontReference(name) && isFamilyInstalled(name, families));
}

function summarizeMissingFonts(items, families, { userId, isAdmin = false, titleLimit = 5 } = {}) {
  const grouped = new Map();
  let coursewareCount = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || !visibleTo(item, userId, isAdmin)) continue;
    const missing = stillMissing(item, families);
    if (!missing.length) continue;
    coursewareCount++;
    for (const name of missing) {
      const key = normalizeFontFamily(name);
      if (!grouped.has(key)) grouped.set(key, { family: String(name).trim(), coursewareCount: 0, titles: [] });
      const entry = grouped.get(key);
      entry.coursewareCount++;
      if (entry.titles.length < titleLimit) entry.titles.push(item.title || item.fileName || item.id);
    }
  }
  return {
    coursewareCount,
    // Most widely missing fonts first: the admin should upload the ones that
    // fix the most courseware before the long tail.
    fonts: [...grouped.values()].sort((a, b) =>
      b.coursewareCount - a.coursewareCount || a.family.localeCompare(b.family, 'zh-CN'))
  };
}

module.exports = { summarizeMissingFonts, needsRegeneration, stillMissing, visibleTo };
