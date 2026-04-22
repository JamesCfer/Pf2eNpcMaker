/**
 * localStorage helpers, namespaced per module folder.
 * Keys are pure data — no JSON nesting per slot.
 */

export class Storage {
  constructor(moduleFolder) {
    this.folder      = moduleFolder;
    this.keyPrimary  = `${moduleFolder}.key`;
    this.keyLegacy   = `${moduleFolder}:key`;
    this.historyKey  = `${moduleFolder}.history`;
    this.versionKey  = `${moduleFolder}.module-version`;
    this.artStyleKey = `${moduleFolder}.art-style`;
  }

  /* ── Patreon session key ────────────────────────────────── */

  getKey() {
    for (const k of [this.keyPrimary, this.keyLegacy]) {
      try { const v = localStorage.getItem(k); if (v) return v; } catch (_) {}
    }
    return '';
  }

  setKey(value) {
    try {
      if (value) {
        localStorage.setItem(this.keyPrimary, value);
        localStorage.setItem(this.keyLegacy, value);
      } else {
        localStorage.removeItem(this.keyPrimary);
        localStorage.removeItem(this.keyLegacy);
      }
    } catch (_) {}
  }

  /* ── History ────────────────────────────────────────────── */

  loadHistory(maxEntries = 50) {
    try {
      const raw = localStorage.getItem(this.historyKey);
      if (raw) return JSON.parse(raw).slice(-maxEntries);
    } catch (_) {}
    return [];
  }

  saveHistory(history, maxEntries = 50) {
    try {
      localStorage.setItem(this.historyKey, JSON.stringify(history.slice(-maxEntries)));
    } catch (_) {}
  }

  /* ── Module version (used to invalidate sessions on update) ── */

  getVersion() {
    try { return localStorage.getItem(this.versionKey) || ''; } catch (_) { return ''; }
  }

  setVersion(version) {
    try { localStorage.setItem(this.versionKey, version); } catch (_) {}
  }

  /* ── Custom art style ───────────────────────────────────── */

  getArtStyle() {
    try { return localStorage.getItem(this.artStyleKey) || ''; } catch (_) { return ''; }
  }

  setArtStyle(style) {
    try { localStorage.setItem(this.artStyleKey, style); } catch (_) {}
  }
}
