// PDF page indices remain the wire/render/annotation identity. Only UI page numbers
// use this mapping. Hidden PPT slides retain their numbers but have no states.
//
// Keep this file under web/ios/js/: the iPhone/iPad web app registers sw.js with the
// default scope /myclass/ios/. A Service Worker can neither cache nor intercept URLs
// outside its scope, so a shared module kept at the web root (/myclass/*.mjs) makes
// the offline fallback fail while importing it, and the whole app never boots.
// The big screen (web/app.js) imports this same file through ./ios/js/.
export function pageMapping(conversion, pageCount) {
  const pages = conversion?.statePages;
  const total = conversion?.slideCount;
  if (!Number.isSafeInteger(total) || total < 1 || !Array.isArray(pages) ||
      pages.length !== pageCount || pages.length === 0 || pages.length > 10000 ||
      pages.some((p, i) => !Number.isSafeInteger(p) || p < 1 || p > total || (i && p < pages[i - 1]))) return null;
  return { slideCount: total, statePages: pages };
}
export function slidePage(cw) { return cw?.mapping?.statePages[cw.page - 1] || cw?.page || 1; }
export function slideCount(cw) { return cw?.mapping?.slideCount || cw?.pageCount || 1; }
export function firstState(cw, slide) {
  return cw?.mapping ? cw.mapping.statePages.indexOf(slide) + 1 : slide;
}
export async function loadPageMapping(url, count) {
  // AbortSignal.timeout() needs Chrome 103+ / Safari 16.4+. Older classroom browsers
  // and iPads would otherwise throw here, be swallowed by the catch below, and
  // silently fall back to showing physical animation-state numbers as page numbers.
  let timer = null;
  try {
    const endpoint = new URL(url, globalThis.location?.href);
    if (!endpoint.pathname.endsWith('.pdf')) return null;
    endpoint.pathname += '.metadata';
    const controller = typeof AbortSignal?.timeout === 'function' ? null : new AbortController();
    if (controller) timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(endpoint, {
      signal: controller ? controller.signal : AbortSignal.timeout(10000)
    });
    return response.ok ? pageMapping((await response.json()).conversion, count) : null;
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}
