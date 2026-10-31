/** Fixed rotary index for My EE. Page identity is the carousel, not a route stack. */
export const EE_PAGE_COUNT = 5;

export function clampEePage(value) {
  const page = Number(value);
  if (!Number.isInteger(page) || page < 0 || page >= EE_PAGE_COUNT) return 0;
  return page;
}

export function stepEePage(page, direction) {
  const delta = direction < 0 ? -1 : 1;
  return (clampEePage(page) + delta + EE_PAGE_COUNT) % EE_PAGE_COUNT;
}

/** Null when the query does not mention a page. Invalid numbers settle on 0. */
export function pageFromSearch(search) {
  const raw = String(search || '');
  const params = new URLSearchParams(raw.charAt(0) === '?' ? raw.slice(1) : raw);
  if (!params.has('page')) return null;
  return clampEePage(params.get('page'));
}
