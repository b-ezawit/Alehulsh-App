/** Shared with native and portable KDFs; no runtime-specific imports. */
export function normalizeKeyword(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}
export const SHIPPED_DEFAULT_KEYWORD = 'milo';
export function isShippedDefault(raw: string): boolean {
  return normalizeKeyword(raw) === SHIPPED_DEFAULT_KEYWORD;
}
