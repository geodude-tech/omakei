/**
 * One page of a list, with the page index clamped into range.
 *
 * Split out of the components that page (the activity table, the unknown-merchant
 * list) so the clamp — an off-by-one magnet — can be tested directly.
 */
export interface Page<T> {
  items: T[];
  /** Requested page, clamped to `[0, pages - 1]`. */
  page: number;
  pages: number;
  total: number;
}

export function pageSlice<T>(items: T[], page: number, pageSize: number): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(Math.max(0, page), pages - 1);
  return {
    items: items.slice(safe * pageSize, (safe + 1) * pageSize),
    page: safe,
    pages,
    total: items.length,
  };
}
