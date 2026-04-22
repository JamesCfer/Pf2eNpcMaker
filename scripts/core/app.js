/**
 * BuilderApp — the shared ApplicationV2 shell used by every builder module.
 *
 * Responsibilities:
 *   - Patreon authentication (sign-in, sign-out, key storage)
 *   - History panel (in-memory + localStorage persistence)
 *   - Feedback panel
 *   - Image generation (delegated to image-gen.js)
 *   - Form rendering (the system-specific fields are inlined in the template)
 *   - Generation flow: hands form data to the SystemAdapter and wires the result
 *     back into Foundry
 *
 * What this file does NOT know:
 *   - How to build a payload for a specific n8n endpoint
 *   - How to sanitize a system-specific actor/item document
 *   - How to inject sheet buttons for a specific system
 *
 * Those live in each module's adapter (modules/<Name>/scripts/adapter.js).
 */

import { Storage }                from './storage.js';
import { startPatreonSignIn,
         PATREON_URL }            from './auth.js';
import { sendFeedback }           from './feedback.js';
import { generateImage,
         IMAGE_COST }             from './image-gen.js';
import { isDevMode }              from './n8n.js';
import { ALL_MODULES,
         getModuleMeta }          from './home-data.js';
import { escapeHtml,
         detectModuleFolder }     from './utils.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export const MAX_HISTORY = 50;

export class BuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {SystemAdapter} adapter  The per-module system adapter.
   * @param {object}        options  ApplicationV2 options (merged with adapter defaults).
   */
  constructor(adapter, options = {}) {
    super(options);
    this.adapter        = adapter;
    this.moduleFolder   = adapter.moduleFolder;
    this.storage        = new Storage(this.moduleFolder);
    this.accessKey      = this.storage.getKey() || '';
    this.authenticated  = !!this.accessKey;
    this.lastDocument   = null;
    this.lastExportData = null;     // adapter-defined: { content, filename, mimeType }
    this.activeTab      = 'home';   // 'home' or 'builder'
    this.selectedHistoryId = null;
    this.patreonTier    = null;

    this.history = this.storage.loadHistory(MAX_HISTORY);
    let hadStale = false;
    for (const entry of this.history) {
      if (entry.status === 'generating') {
        entry.status = 'error';
        entry.error  = 'Session was interrupted';
        hadStale = true;
      }
    }
    if (hadStale) this.storage.saveHistory(this.history, MAX_HISTORY);
  }

  /* ── ApplicationV2 wiring ──────────────────────────────── */

  async _prepareContext() {
    const currentId = this.adapter.module.id;
    return {
      authenticated: this.authenticated,
      module:        this.adapter.module,
      patreonUrl:    PATREON_URL,
      homeModules:   ALL_MODULES.map(m => ({ ...m, isCurrent: m.id === currentId })),
    };
  }

  _onRender(context, options) {
    // Bind tab clicks (Home + Builder) — bypasses ApplicationV2 action delegation
    // which can be intercepted by system-level CSS/JS overrides.
    this.element.querySelectorAll('.builder-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const tab = btn.dataset.tab;
        if (tab === 'home' || tab === 'builder') {
          this.activeTab = tab;
          this._applyTabUI();
        }
      });
    });

    this._applyTabUI();
    this._renderHistory();

    const artStyleInput = this.element.querySelector('#npc-art-style');
    if (artStyleInput) {
      artStyleInput.value = this.storage.getArtStyle();
      artStyleInput.addEventListener('input', () => {
        this.storage.setArtStyle(artStyleInput.value.trim());
      });
    }
  }

  /* ── Tab UI (Home vs Builder) ──────────────────────────── */

  _applyTabUI() {
    const root = this.element;
    if (!root) return;

    root.querySelectorAll('.builder-tab').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.tab === this.activeTab);
    });

    const homePanel    = root.querySelector('.home-panel');
    const builderInner = root.querySelector('.builder-inner');
    const isHome = this.activeTab === 'home';
    if (homePanel)    homePanel.style.display    = isHome ? 'flex' : 'none';
    if (builderInner) builderInner.style.display = isHome ? 'none' : 'flex';

    this._applyAuthStateUI();
  }

  /* ── Auth state UI ──────────────────────────────────────── */

  _applyAuthStateUI() {
    const root = this.element;
    if (!root) return;

    root.classList.toggle('is-authenticated', !!this.authenticated);

    const anyGenerating = this.history.some(e => e.status === 'generating');
    root.classList.toggle('is-generating', anyGenerating);

    for (const action of ['generate', 'export', 'generateimage']) {
      const btn = root.querySelector(`button[data-action="${action}"]`);
      if (btn) btn.disabled = !this.authenticated;
    }
  }

  /* ── Action wiring ──────────────────────────────────────── */

  static DEFAULT_OPTIONS_BASE = {
    classes: ['npc-builder'],
    window:  { resizable: true },
    position: { width: 800 },
    actions: {
      signin:        function(event) { this._signIn(event); },
      signout:       function(event) { this._signOut(event); },
      generate:      function(event) { this._generate(event); },
      export:        function(event) { this._export(event); },
      patreon:       function()      { window.open(PATREON_URL, '_blank'); },
      sendfeedback:  function(event) { this._sendFeedback(event); },
      generateimage: function(event) { this._generateImage(event); },
    },
  };

  /* ── Auth actions ───────────────────────────────────────── */

  async _signIn(event) {
    event?.preventDefault?.();
    ui.notifications?.info?.('Opening Patreon sign-in…');
    try {
      const key = await startPatreonSignIn({ devMode: isDevMode(this.moduleFolder) });
      this.accessKey = key;
      this.storage.setKey(key);
      this.authenticated = true;
      this._applyAuthStateUI();
      ui.notifications?.info?.('Patreon sign-in complete.');
    } catch (err) {
      console.error('[NPC Builder] sign-in failed:', err);
      ui.notifications?.error?.(err.message || 'Sign-in failed.', { permanent: true });
      setTimeout(() => window.open(PATREON_URL, '_blank'), 800);
    }
  }

  async _signOut(event) {
    event?.preventDefault?.();
    this.storage.setKey('');
    this.accessKey = '';
    this.authenticated = false;
    this._applyAuthStateUI();
    ui.notifications?.info?.('Signed out.');
  }

  /* ── History rendering ──────────────────────────────────── */

  _renderHistory() {
    const list = this.element?.querySelector('.history-list');
    if (!list) return;
    list.innerHTML = '';

    if (this.history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = `No ${this.adapter.formConfig.documentNoun || 'documents'} created yet.\nGenerate one to see it here.`;
      list.appendChild(empty);
      return;
    }

    for (const entry of [...this.history].reverse()) {
      list.appendChild(this._createHistoryEntryElement(entry));
    }
  }

  _createHistoryEntryElement(entry) {
    const el = document.createElement('div');
    el.className = `history-entry history-entry--${entry.status}`;
    el.dataset.entryId = entry.id;
    if (this.selectedHistoryId === entry.id) el.classList.add('is-selected');

    const statusIcon = {
      generating: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
      success:    '<i class="fa-solid fa-circle-check"></i>',
      error:      '<i class="fa-solid fa-circle-xmark"></i>',
    }[entry.status] ?? '<i class="fa-solid fa-circle"></i>';

    const escapedName  = escapeHtml(entry.name);
    const escapedError = entry.error ? escapeHtml(entry.error) : '';
    const metaLabel    = this.adapter.historyMeta(entry);

    el.innerHTML = `
      <div class="history-entry-main">
        <div class="history-entry-info">
          <span class="history-entry-name">${escapedName}</span>
          <span class="history-entry-meta">${metaLabel}</span>
        </div>
        <div class="history-entry-icon">${statusIcon}</div>
      </div>
      ${entry.status === 'generating'
        ? '<div class="history-progress"><div class="history-progress-bar"></div></div>'
        : ''}
      ${entry.status === 'error' && escapedError
        ? `<div class="history-entry-error">${escapedError}</div>`
        : ''}
    `;

    el.addEventListener('click', () => this._selectHistoryEntry(entry));
    return el;
  }

  _selectHistoryEntry(entry) {
    this.selectedHistoryId = entry.id;

    const form = this.element?.querySelector('.npc-form');
    if (form) this.adapter.populateForm(form, entry);

    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) {
      banner.style.display = 'flex';
      const strong = banner.querySelector('strong');
      if (strong) strong.textContent = entry.name;
    }

    this.element?.querySelectorAll('.history-entry').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.entryId === entry.id);
    });
  }

  _updateHistoryEntry(id, changes) {
    const entry = this.history.find(e => e.id === id);
    if (!entry) return;

    Object.assign(entry, changes);
    this.storage.saveHistory(this.history, MAX_HISTORY);

    const el = this.element?.querySelector(`.history-entry[data-entry-id="${id}"]`);
    if (el) {
      const newEl = this._createHistoryEntryElement(entry);
      el.parentNode.replaceChild(newEl, el);
    }

    const anyGenerating = this.history.some(e => e.status === 'generating');
    this.element?.classList.toggle('is-generating', anyGenerating);
  }

  /* ── Generate (delegates to adapter) ────────────────────── */

  async _generate(event) {
    event?.preventDefault?.();

    if (!this.authenticated) {
      ui.notifications.warn('Please sign in with Patreon before generating.');
      return;
    }
    if (this.activeTab === 'home') return;

    const form = this.element?.querySelector?.('.npc-form');
    if (!form) {
      ui.notifications.error('Builder form not found.');
      return;
    }

    let formData;
    try {
      formData = this.adapter.gatherFormData(form);
    } catch (err) {
      ui.notifications.warn(err.message);
      return;
    }

    const key = this.accessKey || this.storage.getKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    const historyEntry = {
      id:        foundry.utils.randomID(16),
      ...this.adapter.historyEntryFromForm(formData),
      status:    'generating',
      createdAt: Date.now(),
      error:     null,
    };

    this.history.push(historyEntry);
    this.storage.saveHistory(this.history, MAX_HISTORY);

    const list = this.element?.querySelector('.history-list');
    if (list) {
      const emptyEl = list.querySelector('.history-empty');
      if (emptyEl) emptyEl.remove();
      list.insertBefore(this._createHistoryEntryElement(historyEntry), list.firstChild);
    }
    this.element?.classList.add('is-generating');

    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) banner.style.display = 'none';
    this.selectedHistoryId = null;
    this.element?.querySelectorAll('.history-entry.is-selected').forEach(el => el.classList.remove('is-selected'));

    this._runGeneration(historyEntry, key, formData);
  }

  async _runGeneration(historyEntry, key, formData) {
    try {
      const result = await this.adapter.generate({
        formData,
        key,
        devMode: isDevMode(this.moduleFolder),
        builderApp: this,
      });

      // result: { document, exportData?, message? }
      this.lastDocument   = result.document || null;
      this.lastExportData = result.exportData || null;

      this._updateHistoryEntry(historyEntry.id, { status: 'success' });

      const docName = result.document?.name || formData.name || 'document';
      ui.notifications.success(result.message || `"${docName}" created successfully!`);
      try { result.document?.sheet?.render(true); } catch (_) {}

    } catch (err) {
      console.error('[NPC Builder] generation error:', err);
      const isAuth      = err?.code === 'AUTH_FAILED'      || /Unauthorized/i.test(err?.message || '');
      const isRateLimit = err?.code === 'RATE_LIMIT'        || /rate limit/i.test(err?.message || '');

      if (isAuth) {
        this.storage.setKey('');
        this.accessKey     = '';
        this.authenticated = false;
        this._applyAuthStateUI();
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: 'Authentication failed' });
        ui.notifications.error(err.message || 'Authentication failed.', { permanent: true });
        setTimeout(() => window.open(PATREON_URL, '_blank'), 800);
      } else if (isRateLimit) {
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: 'Rate limit exceeded' });
        if (err?.tier) this.patreonTier = err.tier;
        ui.notifications.error(err.message || 'Monthly limit reached.', { permanent: true });
        setTimeout(() => window.open(PATREON_URL, '_blank'), 1200);
      } else {
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: err.message });
        ui.notifications.error(`Failed to generate "${formData.name || 'document'}": ${err.message}`);
      }
    }
  }

  /* ── Export ─────────────────────────────────────────────── */

  async _export(event) {
    event?.preventDefault?.();
    if (!this.lastExportData) {
      ui.notifications.warn(`No ${this.adapter.formConfig.documentNoun || 'document'} has been generated yet.`);
      return;
    }
    const { content, filename, mimeType } = this.lastExportData;
    const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename || 'export';
    a.click();
    URL.revokeObjectURL(url);
    ui.notifications.info(`Exported ${filename}.`);
  }

  /* ── Image generation ───────────────────────────────────── */

  async _generateImage(event, npcDataOverride, systemOverride) {
    event?.preventDefault?.();

    if (!this.authenticated) {
      ui.notifications.warn('Please sign in with Patreon before generating an image.');
      return;
    }

    const npcData = npcDataOverride || this.lastDocument?.toObject?.() || this.lastDocument;
    if (!npcData) {
      ui.notifications.warn('No NPC available. Generate or open an NPC first.');
      return;
    }

    if (!this.adapter.supportsImageGeneration) {
      ui.notifications.warn('Image generation is not supported in this module.');
      return;
    }

    const targetSystem = systemOverride || this.adapter.systemId;
    const artStyle     = this.storage.getArtStyle();

    const confirmed = await this._confirmImageGeneration(npcData.name || 'this NPC', artStyle);
    if (!confirmed) return;

    const key = this.accessKey || this.storage.getKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    ui.notifications.info('Generating NPC image… this may take a moment.');

    try {
      const { savedPath } = await generateImage({
        npcData,
        system:   targetSystem,
        artStyle,
        key,
        devMode:  isDevMode(this.moduleFolder),
        onAuthFailed: () => {
          this.storage.setKey('');
          this.accessKey     = '';
          this.authenticated = false;
          this._applyAuthStateUI();
        },
      });

      const actorId = npcData._id;
      const actor   = actorId ? game.actors?.get(actorId) : null;

      if (savedPath && actor) {
        await actor.update({
          'img': savedPath,
          'prototypeToken.texture.src': savedPath,
        });
        ui.notifications.success(`Image set for "${actor.name}"!`);
      } else if (savedPath) {
        ui.notifications.success('NPC image saved: ' + savedPath);
      } else {
        ui.notifications.success('Image generation request sent successfully.');
      }
    } catch (err) {
      console.error('[NPC Builder] image generation error:', err);
      ui.notifications.error(`Image generation failed: ${err.message}`);
    }
  }

  async _confirmImageGeneration(name, artStyle) {
    return new Promise(resolve => {
      const DialogV2 = foundry.applications?.api?.DialogV2;
      const content  = `
        <div style="display:flex;flex-direction:column;gap:0.6em;padding:0.25em 0;">
          <p style="margin:0;">Generate an image for <strong>${escapeHtml(name)}</strong>?</p>
          <p style="margin:0;padding:0.5em 0.7em;background:rgba(46,125,50,0.1);border:1px solid rgba(46,125,50,0.3);border-radius:4px;font-size:0.92em;">
            <i class="fa-solid fa-coins" style="color:#2e7d32;"></i>
            This will use <strong>${IMAGE_COST} NPC uses</strong> from your monthly allowance.
          </p>
          ${artStyle ? `<p style="margin:0;font-size:0.88em;color:#555;"><i class="fa-solid fa-palette"></i> Art style: <em>${escapeHtml(artStyle)}</em></p>` : ''}
        </div>`;

      if (DialogV2) {
        DialogV2.confirm({
          window:  { title: 'Generate NPC Image' },
          content,
          yes: { label: 'Generate Image', icon: 'fa-solid fa-image' },
          no:  { label: 'Cancel' },
          rejectClose: false,
        }).then(r => resolve(r === true)).catch(() => resolve(false));
      } else {
        new Dialog({
          title:   'Generate NPC Image',
          content,
          buttons: {
            yes:    { label: '<i class="fa-solid fa-image"></i> Generate Image', callback: () => resolve(true) },
            cancel: { label: 'Cancel', callback: () => resolve(false) },
          },
          default: 'cancel',
          close:   () => resolve(false),
        }).render(true);
      }
    });
  }

  /* ── Feedback ───────────────────────────────────────────── */

  async _sendFeedback(event) {
    event?.preventDefault?.();
    const root = this.element;
    if (!root) return;

    const textarea = root.querySelector('.feedback-textarea');
    const sendBtn  = root.querySelector('.feedback-send-btn');
    const status   = root.querySelector('.feedback-status');

    const message = textarea?.value?.trim() || '';
    if (!message) {
      ui.notifications?.warn?.('Please enter a feedback message before sending.');
      return;
    }

    if (sendBtn) sendBtn.disabled = true;

    try {
      const tier = this.patreonTier || (this.authenticated ? 'Supporter (tier unknown)' : 'Free');
      await sendFeedback({
        message,
        moduleLabel: this.adapter.module.label,
        email:       game.user?.email || '',
        tier,
        sessionKey:  this.accessKey || '',
        devMode:     isDevMode(this.moduleFolder),
      });

      if (textarea) textarea.value = '';
      if (status) {
        status.textContent   = 'Feedback sent! Thank you.';
        status.className     = 'feedback-status feedback-status--success';
        status.style.display = '';
        setTimeout(() => { status.style.display = 'none'; }, 4000);
      }
    } catch (err) {
      console.error('[NPC Builder] feedback send error:', err);
      if (status) {
        status.textContent   = 'Failed to send feedback. Please try again.';
        status.className     = 'feedback-status feedback-status--error';
        status.style.display = '';
        setTimeout(() => { status.style.display = 'none'; }, 5000);
      }
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }
}

/* ============================================================================
   Singleton helpers — one app instance per module folder.
   ============================================================================ */

const _appInstances = new Map();

export function openBuilder(adapter, AppClass = BuilderApp) {
  let app = _appInstances.get(adapter.moduleFolder);
  if (app?.rendered && app?.element?.isConnected) {
    app.bringToTop?.();
  } else {
    app = new AppClass(adapter);
    _appInstances.set(adapter.moduleFolder, app);
    app.render({ force: true }).catch(err => {
      console.error('[NPC Builder] Failed to open:', err);
      ui.notifications?.error?.('Builder failed to open. Check the console (F12) for details.');
      _appInstances.delete(adapter.moduleFolder);
    });
  }
  return app;
}

/** Returns an instance for sheet button callbacks (does not render the window). */
export function ensureBuilder(adapter, AppClass = BuilderApp) {
  let app = _appInstances.get(adapter.moduleFolder);
  if (!app?.rendered || !app?.element?.isConnected) {
    app = new AppClass(adapter);
    _appInstances.set(adapter.moduleFolder, app);
  }
  app.accessKey     = app.storage.getKey() || '';
  app.authenticated = !!app.accessKey;
  return app;
}

export { ALL_MODULES, getModuleMeta, detectModuleFolder, IMAGE_COST };
