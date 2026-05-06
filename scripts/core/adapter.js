/**
 * SystemAdapter — the contract between the shared BuilderApp and a per-module
 * system implementation.
 *
 * A subclass MUST set:
 *   - moduleFolder         (string)  — folder name under /modules/, used for storage keys
 *   - module               (ModuleInfo) — { id, label, icon, githubUrl, historyLabel }
 *   - systemId             (string)  — Foundry game system id ('pf2e', 'dnd5e', 'hero6e')
 *   - formConfig           (FormConfig) — labels/placeholders for the shared shell template
 *
 * A subclass MUST implement:
 *   - gatherFormData(form)            → { name, level, description, ...module-specific }
 *   - historyEntryFromForm(formData)  → fields to merge into the history entry
 *   - historyMeta(entry)              → string (HTML-safe; e.g. 'Lv.&nbsp;1')
 *   - populateForm(form, entry)       → void  (recreate form values from history entry)
 *   - generate({formData,key,...})    → AdapterResult
 *
 * Optional:
 *   - supportsImageGeneration         (boolean, default false)
 *   - registerSheetHooks(getApp)      → registers Hooks for sheet button injection
 */

/* ── Shared type definitions ─────────────────────────────── */

/**
 * @typedef {object} ModuleInfo
 * @property {string} id            Foundry module id.
 * @property {string} label         Short display name.
 * @property {string} icon          FontAwesome class string.
 * @property {string} githubUrl     Repository URL.
 * @property {string} historyLabel  Panel heading for the history list.
 */

/**
 * @typedef {object} FormConfig
 * @property {string} documentNoun  Human-readable noun for the document type ('NPC', 'item', …).
 */

/**
 * @typedef {object} ExportData
 * @property {string} content   Serialised document (JSON, XML, …).
 * @property {string} filename  Suggested download filename including extension.
 * @property {string} mimeType  MIME type for the Blob.
 */

/**
 * @typedef {object} AdapterResult
 * @property {object}      document    Foundry Actor or Item instance.
 * @property {ExportData}  [exportData]
 * @property {string}      [message]   Success notification text.
 */

/**
 * @typedef {object} GenerateOptions
 * @property {object}  formData    Gathered form values (shape varies per adapter).
 * @property {string}  key         Patreon session key.
 * @property {boolean} devMode     Whether to hit the '-dev' n8n endpoints.
 * @property {object}  [builderApp] The calling BuilderApp instance.
 */

/**
 * @typedef {'generating'|'success'|'error'} EntryStatus
 */

/**
 * @typedef {object} HistoryEntry
 * @property {string}      id        Random 16-char Foundry ID.
 * @property {string}      name      Document name as entered in the form.
 * @property {EntryStatus} status
 * @property {number}      createdAt Unix timestamp (Date.now()).
 * @property {string|null} error     Error message when status is 'error'.
 */

/**
 * @typedef {object} N8nPostResult
 * @property {Response} response
 * @property {string}   responseText
 */

/* ── Custom error classes ────────────────────────────────── */

/** Thrown when Patreon authentication fails (HTTP 401/403). */
export class AuthError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message || 'Authentication failed.');
    this.name = 'AuthError';
  }
}

/** Thrown when the user's monthly generation limit is reached (HTTP 429). */
export class RateLimitError extends Error {
  /**
   * @param {string} [message]
   * @param {string} [tier]  Patreon tier label used for the upgrade prompt.
   */
  constructor(message, tier) {
    super(message || 'Monthly limit reached.');
    this.name = 'RateLimitError';
    /** @type {string|undefined} */
    this.tier = tier;
  }
}

/* ── SystemAdapter abstract base ─────────────────────────── */

export class SystemAdapter {
  constructor() {
    if (new.target === SystemAdapter) {
      throw new Error('SystemAdapter is abstract — subclass it per module.');
    }
  }

  /** @returns {string} */
  get moduleFolder() { throw new Error('moduleFolder not implemented'); }

  /** @returns {ModuleInfo} */
  get module() { throw new Error('module not implemented'); }

  /** @returns {string} Foundry game system id. */
  get systemId() { throw new Error('systemId not implemented'); }

  /** @returns {FormConfig} */
  get formConfig() { throw new Error('formConfig not implemented'); }

  /** @returns {boolean} */
  get supportsImageGeneration() { return false; }

  /* ── Methods to override ────────────────────────────────── */

  /**
   * @param {HTMLFormElement} _form
   * @returns {object} Gathered form values (shape is adapter-specific).
   */
  gatherFormData(_form) {
    throw new Error('gatherFormData not implemented');
  }

  /**
   * @param {object} _formData
   * @returns {Partial<HistoryEntry>} Fields to merge into the new history entry.
   */
  historyEntryFromForm(_formData) {
    throw new Error('historyEntryFromForm not implemented');
  }

  /**
   * @param {HistoryEntry} _entry
   * @returns {string} HTML-safe metadata string (e.g. 'Lv.&nbsp;1').
   */
  historyMeta(_entry) {
    return '';
  }

  /**
   * @param {HTMLFormElement} _form
   * @param {HistoryEntry}    _entry
   * @returns {void}
   */
  populateForm(_form, _entry) {
    /* no-op default */
  }

  /**
   * @param {GenerateOptions} _opts
   * @returns {Promise<AdapterResult>}
   */
  async generate(_opts) {
    throw new Error('generate not implemented');
  }

  /**
   * @param {() => object} _getApp  Returns the running BuilderApp instance.
   * @returns {void}
   */
  registerSheetHooks(_getApp) {
    /* no-op default */
  }
}

/* ── Shared network helper ───────────────────────────────── */

/**
 * POSTs to an n8n webhook with Patreon auth headers.
 * Maps 401/403 → AuthError and 429 → RateLimitError.
 *
 * @param {string} endpoint
 * @param {object} payload
 * @param {string} key
 * @returns {Promise<N8nPostResult>}
 */
export async function postToN8n(endpoint, payload, key) {
  const response = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Builder-Key':    key,
      'X-Foundry-Origin': window.location.origin,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  if (response.status === 401 || response.status === 403) {
    let data; try { data = JSON.parse(responseText); } catch { data = {}; }
    throw new AuthError(data?.message || 'Unauthorized. Please sign in with Patreon.');
  }

  if (response.status === 429) {
    let data; try { data = JSON.parse(responseText); } catch { data = {}; }
    const limit = data?.limit || 0;
    const tierMap = { 3: 'Free', 15: 'Local Adventurer', 50: 'Standard', 80: 'Champion' };
    const tier = limit && tierMap[limit] ? tierMap[limit] : null;
    throw new RateLimitError(data?.message || 'Monthly limit reached.', tier);
  }

  return { response, responseText };
}
