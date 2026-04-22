/**
 * Shared utility helpers used by every module.
 */

/** Compare two semver strings — returns true if `a` is strictly newer than `b`. */
export function isNewerVersion(a, b) {
  const parse = v => (v || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

/** Escape an arbitrary string for safe insertion into HTML. */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * The folder name this module is installed under, derived from the script's URL.
 * Independent of module id — works regardless of legacy install paths.
 */
export function detectModuleFolder(fallbackId) {
  const match = (import.meta?.url ?? '').match(/\/modules\/([^/]+)\//);
  if (match) return match[1];
  return fallbackId || 'unknown-module';
}
