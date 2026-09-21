// PDF page indices remain the wire/render/annotation identity. Only UI page numbers
// use this mapping. Hidden PPT slides retain their numbers but have no states.
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
  try {
    const endpoint = new URL(url, globalThis.location?.href);
    if (!endpoint.pathname.endsWith('.pdf')) return null;
    endpoint.pathname += '.metadata';
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    return response.ok ? pageMapping((await response.json()).conversion, count) : null;
  } catch { return null; }
}
