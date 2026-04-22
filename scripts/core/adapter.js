/**
 * SystemAdapter — the contract between the shared BuilderApp and a per-module
 * system implementation.
 *
 * A subclass MUST set:
 *   - moduleFolder         (string)  — folder name under /modules/, used for storage keys
 *   - module               (object)  — { id, label, icon, githubUrl }
 *   - systemId             (string)  — Foundry game system id ('pf2e', 'dnd5e', 'hero6e')
 *   - formConfig           (object)  — labels/placeholders for the shared shell template
 *
 * A subclass MUST implement:
 *   - gatherFormData(form)            → { name, level, description, ...module-specific }
 *   - historyEntryFromForm(formData)  → fields to merge into the history entry
 *   - historyMeta(entry)              → string (HTML-safe; e.g. 'Lv.&nbsp;1')
 *   - populateForm(form, entry)       → void  (recreate form values from history entry)
 *   - generate({formData,key,...})    → { document, exportData?, message? }
 *
 * Optional:
 *   - supportsImageGeneration         (boolean, default false)
 *   - registerSheetHooks(getApp)      → registers Hooks for sheet button injection
 */

export class SystemAdapter {
  constructor() {
    if (new.target === SystemAdapter) {
      throw new Error('SystemAdapter is abstract — subclass it per module.');
    }
  }

  /** Override in subclass — folder under /modules/. */
  get moduleFolder() { throw new Error('moduleFolder not implemented'); }

  /** Override — { id, label, icon, githubUrl }. */
  get module() { throw new Error('module not implemented'); }

  /** Override — Foundry game system id. */
  get systemId() { throw new Error('systemId not implemented'); }

  /** Override — see formConfig structure in the shell template. */
  get formConfig() { throw new Error('formConfig not implemented'); }

  /** Default: image generation is opt-in per module. */
  get supportsImageGeneration() { return false; }

  /* ── Methods to override ────────────────────────────────── */

  gatherFormData(_form) {
    throw new Error('gatherFormData not implemented');
  }

  historyEntryFromForm(_formData) {
    throw new Error('historyEntryFromForm not implemented');
  }

  historyMeta(_entry) {
    return '';
  }

  populateForm(_form, _entry) {
    /* no-op default */
  }

  async generate(_opts) {
    throw new Error('generate not implemented');
  }

  registerSheetHooks(_getApp) {
    /* no-op default */
  }
}

/**
 * Throws an error tagged with code='AUTH_FAILED' so BuilderApp can present
 * the proper UX (clear key, open Patreon).
 */
export function authError(message) {
  const err = new Error(message || 'Authentication failed.');
  err.code = 'AUTH_FAILED';
  return err;
}

/**
 * Throws an error tagged with code='RATE_LIMIT' (with optional .tier) so
 * BuilderApp can open Patreon and remember the tier for feedback.
 */
export function rateLimitError(message, tier) {
  const err = new Error(message || 'Monthly limit reached.');
  err.code = 'RATE_LIMIT';
  if (tier) err.tier = tier;
  return err;
}

/**
 * Helper used by every adapter that POSTs to an n8n webhook.
 * Centralises the auth headers and the 401/403/429 → tagged-error mapping.
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
    throw authError(data?.message || 'Unauthorized. Please sign in with Patreon.');
  }

  if (response.status === 429) {
    let data; try { data = JSON.parse(responseText); } catch { data = {}; }
    const limit = data?.limit || 0;
    const tierMap = { 3: 'Free', 15: 'Local Adventurer', 50: 'Standard', 80: 'Champion' };
    const tier = limit && tierMap[limit] ? tierMap[limit] : null;
    throw rateLimitError(data?.message || 'Monthly limit reached.', tier);
  }

  return { response, responseText };
}
