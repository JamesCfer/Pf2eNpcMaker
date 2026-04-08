/*
 * PF2E NPC Auto-Builder — UNIFIED VERSION (ApplicationV2)
 *
 * Features:
 * - Patreon OAuth authentication
 * - Tier-based rate limiting (monthly NPC limits)
 * - Spell ID mapping for proper spell linking
 * - Full error handling and validation
 * - Automatic retry on validation errors
 * - Sidebar buttons and header controls
 * - Bulk / concurrent NPC generation
 * - Local history panel (stored in localStorage)
 *
 * Authentication Flow:
 * - Click "Sign in with Patreon" → opens popup to n8n login endpoint
 * - n8n redirects to Patreon; on success the callback window postMessages:
 *     { type:'patreon-auth', ok:true, key:'<32+ char session key>' }
 * - We accept the message (from the popup window), store key, enable UI
 *
 * Generation Flow:
 * - When generating an NPC, we POST to n8n /webhook/npc-builder with:
 *     headers: { 'X-Builder-Key': <key>, 'X-Foundry-Origin': window.location.origin }
 *     body: { name, level, description, spellMapping (optional) }
 * - The server re-validates key + origin and runs the full generation pipeline
 * - Multiple NPCs can be generated concurrently; each gets its own history entry
 *
 * Rate Limiting:
 * - Free tier: 3 NPCs/month
 * - Local Adventurer: 15 NPCs/month
 * - Standard: 50 NPCs/month
 * - Champion: 80 NPCs/month
 *
 * File layout:
 * - scripts/npc-builder.js          ← this file (app shell, auth, generation, UI)
 * - scripts/systems/pf2e.js         ← PF2e actor sanitization
 * - scripts/systems/dnd5e.js        ← D&D 5e actor sanitization
 * - scripts/systems/hero6e.js       ← Hero System 6e actor sanitization
 */

import { sanitizeActorDataPf2e, tryFixValidationError, enrichSpellsFromCompendium } from './systems/pf2e.js';
import { sanitizeActorDataDnd5e }                       from './systems/dnd5e.js';
import { sanitizeActorDataHero6e }                      from './systems/hero6e.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * The actual folder name this module is installed under, derived from the
 * script's own URL.  This is the only reliable source — it works regardless
 * of module id, legacy install paths, or which system variant is loaded.
 */
const _MODULE_FOLDER = (() => {
  const match = (import.meta?.url ?? '').match(/\/modules\/([^/]+)\//);
  if (match) return match[1];
  const ids = ['Pf2eNpcMaker', 'Hero6eNpcMaker', 'DnD5eNpcMaker', 'pf2e-npc-auto-builder'];
  return ids.find(id => game.modules?.get(id)) ?? 'pf2e-npc-auto-builder';
})();

class NPCBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** n8n endpoints */
  static N8N_AUTH_URL   = 'https://foundryrelay.dedicated2.com/webhook/oauth/patreon/login';
  static N8N_NPC_URL    = 'https://foundryrelay.dedicated2.com/webhook/npc-builder';
  static N8N_DND5E_URL  = 'https://foundryrelay.dedicated2.com/webhook/dnd5e-npc-builder';
  static N8N_HERO6E_URL    = 'https://foundryrelay.dedicated2.com/webhook/hero6e-npc-builder';
  static N8N_IMAGE_URL     = 'https://foundryrelay.dedicated2.com/webhook/npc-image';
  static N8N_LEVELUP_URL   = 'https://foundryrelay.dedicated2.com/webhook/npc-levelup';
  static N8N_FEEDBACK_URL  = 'https://foundryrelay.dedicated2.com/webhook/feedback';
  static PATREON_URL       = 'https://www.patreon.com/cw/CelestiaTools';

  /** Cost in uses for generating an NPC image */
  static IMAGE_COST = 4;

  /** localStorage slots */
  static STORAGE_KEYS = [`${_MODULE_FOLDER}.key`, `${_MODULE_FOLDER}:key`];

  /** localStorage slot for NPC history */
  static HISTORY_KEY = `${_MODULE_FOLDER}.history`;

  /** localStorage slot for selected game system */
  static SYSTEM_KEY = `${_MODULE_FOLDER}.system`;

  /** localStorage slot for last-seen module version (used to force sign-out on updates) */
  static VERSION_KEY = `${_MODULE_FOLDER}.module-version`;

  /** localStorage slot for custom art style */
  static ART_STYLE_KEY = `${_MODULE_FOLDER}.art-style`;

  /** Max history entries to retain */
  static MAX_HISTORY = 50;

  /** Returns true when dev-mode is enabled (routes to -dev webhook endpoints). */
  static _devMode() {
    try { return game.settings?.get(_MODULE_FOLDER, 'devMode') ?? false; } catch (_) { return false; }
  }

  /** Returns the URL with a '-dev' suffix appended when dev-mode is active. */
  static _url(base) {
    return NPCBuilderApp._devMode() ? base + '-dev' : base;
  }

  /** Supported game systems */
  static SYSTEMS = ['pf2e', 'dnd5e', 'hero6e'];

  /**
   * Valid Hero System 6e point tiers.
   * Used to snap the input value to the nearest recognised budget.
   */
  static HERO6E_POINT_TIERS = [25, 50, 75, 100, 150, 175, 200, 250, 300, 350, 400, 500, 600];

  /**
   * Valid Hero System 6e genre values accepted by the n8n workflow.
   */
  static HERO6E_GENRES = ['standard', 'superhero', 'pulp', 'dark_champions', 'fantasy', 'sci-fi'];

  /**
   * Valid Hero System 6e universe / campaign setting values.
   * Controls stat caps, power structure rules, and complication suggestions.
   */
  static HERO6E_UNIVERSES = ['standard', 'mha', 'dc', 'marvel'];

  static DEFAULT_OPTIONS = {
    id: `${_MODULE_FOLDER}-app`,
    classes: ['npc-builder'],
    window: {
      title: 'NPC Builder',
      resizable: true,
    },
    position: {
      width: 800,
    },
    actions: {
      signin:        function(event) { this._signIn(event); },
      signout:       function(event) { this._signOut(event); },
      generate:      function(event) { this._generateNPC(event); },
      export:        function(event) { this._exportJSON(event); },
      patreon:       function()      { window.open(this.constructor.PATREON_URL, '_blank'); },
      sendfeedback:  function(event) { this._sendFeedback(event); },
      selectsystem:  function(event) { this._selectSystem(event); },
      generateimage: function(event) { this._generateImage(event); },
    },
  };

  static get PARTS() {
    return {
      form: { template: `modules/${_MODULE_FOLDER}/templates/builder.html` },
    };
  }

  /* ── Key storage helpers ─────────────────────────────────── */

  static getStoredKey() {
    for (const k of NPCBuilderApp.STORAGE_KEYS) {
      try {
        const v = localStorage.getItem(k);
        if (v) return v;
      } catch (_) {}
    }
    return '';
  }

  static setStoredKey(value) {
    try {
      if (value) {
        for (const k of NPCBuilderApp.STORAGE_KEYS) localStorage.setItem(k, value);
      } else {
        for (const k of NPCBuilderApp.STORAGE_KEYS) localStorage.removeItem(k);
      }
    } catch (_) {}
  }

  /* ── System storage helpers ──────────────────────────────── */

  static getStoredSystem() {
    try {
      const v = localStorage.getItem(NPCBuilderApp.SYSTEM_KEY);
      if (v && NPCBuilderApp.SYSTEMS.includes(v)) return v;
    } catch (_) {}
    // Default to whatever system is active in Foundry
    try {
      const gameSystem = game?.system?.id;
      if (gameSystem && NPCBuilderApp.SYSTEMS.includes(gameSystem)) return gameSystem;
    } catch (_) {}
    return 'pf2e';
  }

  static setStoredSystem(system) {
    try { localStorage.setItem(NPCBuilderApp.SYSTEM_KEY, system); } catch (_) {}
  }

  /* ── Module version storage helpers ─────────────────────── */

  static getStoredVersion() {
    try { return localStorage.getItem(NPCBuilderApp.VERSION_KEY) || ''; } catch (_) { return ''; }
  }

  static setStoredVersion(version) {
    try { localStorage.setItem(NPCBuilderApp.VERSION_KEY, version); } catch (_) {}
  }

  /* ── Art style storage helpers ──────────────────────────── */

  static getStoredArtStyle() {
    try { return localStorage.getItem(NPCBuilderApp.ART_STYLE_KEY) || ''; } catch (_) { return ''; }
  }

  static setStoredArtStyle(style) {
    try { localStorage.setItem(NPCBuilderApp.ART_STYLE_KEY, style); } catch (_) {}
  }

  /* ── History storage helpers ─────────────────────────────── */

  static loadHistory() {
    try {
      const raw = localStorage.getItem(NPCBuilderApp.HISTORY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  }

  static saveHistory(history) {
    try {
      const trimmed = history.slice(-NPCBuilderApp.MAX_HISTORY);
      localStorage.setItem(NPCBuilderApp.HISTORY_KEY, JSON.stringify(trimmed));
    } catch (_) {}
  }

  /* ── Constructor ─────────────────────────────────────────── */

  constructor(options = {}) {
    super(options);
    this.accessKey         = NPCBuilderApp.getStoredKey() || '';
    this.authenticated     = !!this.accessKey;
    this.lastGeneratedNPC  = null;
    this.selectedHistoryId = null;
    this.selectedSystem    = NPCBuilderApp.getStoredSystem();
    this.patreonTier       = null;

    // Load history; clean up any entries stuck in "generating" from a prior session
    this.npcHistory = NPCBuilderApp.loadHistory();
    let hadStale = false;
    for (const entry of this.npcHistory) {
      if (entry.status === 'generating') {
        entry.status = 'error';
        entry.error  = 'Session was interrupted';
        hadStale = true;
      }
    }
    if (hadStale) NPCBuilderApp.saveHistory(this.npcHistory);
  }

  /* ── Template data ───────────────────────────────────────── */

  async _prepareContext(options) {
    return {
      authenticated: this.authenticated,
      patreonUrl:    NPCBuilderApp.PATREON_URL,
    };
  }

  /* ── Render hook ─────────────────────────────────────────── */

  _onRender(context, options) {
    // Bind tab clicks directly — bypasses ApplicationV2 action delegation
    // which can be intercepted by system-level CSS/JS (e.g. PF2e overrides).
    this.element.querySelectorAll('.system-tab[data-system]').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        this._selectSystem(ev);
      });
    });

    this._applySystemUI();  // also calls _applyAuthStateUI
    this._renderHistory();

    // Bind art style input — persist on change
    const artStyleInput = this.element.querySelector('#npc-art-style');
    if (artStyleInput) {
      artStyleInput.value = NPCBuilderApp.getStoredArtStyle();
      artStyleInput.addEventListener('input', () => {
        NPCBuilderApp.setStoredArtStyle(artStyleInput.value.trim());
      });
    }
  }

  /* ── Auth state UI ───────────────────────────────────────── */

  _applyAuthStateUI() {
    const root = this.element;
    if (!root) return;

    root.classList.toggle('is-authenticated', !!this.authenticated);

    const anyGenerating = this.npcHistory.some(e => e.status === 'generating');
    root.classList.toggle('is-generating', anyGenerating);

    const genBtn = root.querySelector('button[data-action="generate"]');
    if (genBtn) {
      genBtn.disabled = !this.authenticated;
      const label = genBtn.querySelector('.btn-label');
      if (label) label.textContent = 'Generate NPC';
    }

    const expBtn = root.querySelector('button[data-action="export"]');
    if (expBtn) expBtn.disabled = !this.authenticated;

    const imgBtn = root.querySelector('button[data-action="generateimage"]');
    if (imgBtn) imgBtn.disabled = !this.authenticated;
  }

  /* ── System selection ────────────────────────────────────── */

  _selectSystem(event) {
    const btn    = event.currentTarget || event.target;
    const system = btn?.dataset?.system;
    if (!system) return;

    if (system === 'home') {
      this.selectedSystem = 'home';
      // Don't persist 'home' — remember the last real system for next open
    } else if (NPCBuilderApp.SYSTEMS.includes(system)) {
      this.selectedSystem = system;
      NPCBuilderApp.setStoredSystem(system);
    } else {
      return;
    }
    this._applySystemUI();
  }

  _applySystemUI() {
    const root = this.element;
    if (!root) return;

    const system = this.selectedSystem || 'pf2e';

    // Update system tab active state (includes 'home')
    root.querySelectorAll('.system-tab').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.system === system);
    });

    // Toggle home panel vs builder inner
    const homePanel    = root.querySelector('.home-panel');
    const builderInner = root.querySelector('.npc-builder-inner');
    const isHome       = system === 'home';
    if (homePanel)    homePanel.style.display    = isHome ? 'flex'  : 'none';
    if (builderInner) builderInner.style.display = isHome ? 'none'  : 'flex';

    if (isHome) {
      // Clear all system classes, hide warnings, update auth buttons and return
      NPCBuilderApp.SYSTEMS.forEach(s => root.classList.remove(`system-${s}`));
      root.querySelectorAll('.system-warning').forEach(el => { el.style.display = 'none'; });
      this._applyAuthStateUI();
      return;
    }

    // Apply system class to root for CSS-driven theming
    NPCBuilderApp.SYSTEMS.forEach(s => root.classList.remove(`system-${s}`));
    root.classList.add(`system-${system}`);

    // Show/hide system-specific elements via data-system-only attribute
    root.querySelectorAll('[data-system-only]').forEach(el => {
      el.style.display = el.dataset.systemOnly === system ? '' : 'none';
    });

    // Show/hide warning banners
    root.querySelectorAll('.system-warning').forEach(el => { el.style.display = 'none'; });
    const warning = root.querySelector(`.system-warning--${system}`);
    if (warning) warning.style.display = 'flex';

    // Update field labels and input constraints per system
    const configs = {
      pf2e: {
        levelLabel:      'Level',
        levelMin:        '0',
        levelMax:        '25',
        levelStep:       '1',
        levelDefault:    '1',
        namePlaceholder: 'e.g. Goblin Warchief',
        descPlaceholder: 'Describe this NPC: their role, fighting style, special abilities, equipment, personality traits…',
        historyLabel:    'Created NPCs',
      },
      dnd5e: {
        levelLabel:      'Challenge Rating',
        levelMin:        '0',
        levelMax:        '30',
        levelStep:       '0.125',
        levelDefault:    '1',
        namePlaceholder: 'e.g. Bandit Captain',
        descPlaceholder: 'Describe this creature: their role, attacks, special abilities, legendary actions, lore…',
        historyLabel:    'Created Creatures',
      },
      hero6e: {
        levelLabel:      'Point Value',
        levelMin:        '25',
        levelMax:        '600',
        levelStep:       '25',
        levelDefault:    '150',
        namePlaceholder: 'e.g. Ironclad',
        descPlaceholder: [
          'Describe this character: their powers, combat style, skills, limitations, background…',
          '',
          'Optional tags (add anywhere in description):',
          '  genre: superhero / standard / pulp / dark_champions / fantasy / sci-fi',
          '  universe: mha / dc / marvel / standard',
        ].join('\n'),
        historyLabel:    'Created Characters',
      },
    };

    const cfg = configs[system] || configs.pf2e;

    const levelLabel = root.querySelector('label[for="npc-level"]');
    if (levelLabel) levelLabel.textContent = cfg.levelLabel;

    const levelInput = root.querySelector('#npc-level');
    if (levelInput) {
      levelInput.min  = cfg.levelMin;
      levelInput.max  = cfg.levelMax;
      levelInput.step = cfg.levelStep;
      // Snap current value to a valid Hero tier if switching to hero6e
      if (system === 'hero6e') {
        const raw = parseInt(levelInput.value) || 150;
        levelInput.value = NPCBuilderApp._snapToHero6eTier(raw);
      }
    }

    const nameInput = root.querySelector('#npc-name');
    if (nameInput) nameInput.placeholder = cfg.namePlaceholder;

    const descTextarea = root.querySelector('#npc-desc');
    if (descTextarea) descTextarea.placeholder = cfg.descPlaceholder;

    const historyLabel = root.querySelector('.history-header-label');
    if (historyLabel) historyLabel.textContent = cfg.historyLabel;

    // Sync auth UI
    this._applyAuthStateUI();
  }

  /**
   * Snap a raw point value to the nearest valid Hero System 6e tier.
   */
  static _snapToHero6eTier(raw) {
    const tiers = NPCBuilderApp.HERO6E_POINT_TIERS;
    return tiers.reduce((prev, curr) =>
      Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev
    );
  }

  /* ── History rendering ───────────────────────────────────── */

  _renderHistory() {
    const list = this.element?.querySelector('.history-list');
    if (!list) return;

    list.innerHTML = '';

    if (this.npcHistory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No NPCs created yet.\nGenerate one to see it here.';
      list.appendChild(empty);
      return;
    }

    // Newest first
    for (const entry of [...this.npcHistory].reverse()) {
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

    const escapedName  = this._escapeHtml(entry.name);
    const escapedError = entry.error ? this._escapeHtml(entry.error) : '';

    // Build the secondary meta label
    let metaLabel;
    if (entry.system === 'dnd5e') {
      metaLabel = `CR&nbsp;${entry.level}`;
    } else if (entry.system === 'hero6e') {
      // Include universe tag when non-standard so history is self-explanatory
      const universePart = (entry.universe && entry.universe !== 'standard')
        ? `&nbsp;<span class="history-entry-universe">[${entry.universe.toUpperCase()}]</span>`
        : '';
      metaLabel = `${entry.level}&nbsp;pts${universePart}`;
    } else {
      metaLabel = `Lv.&nbsp;${entry.level}`;
    }

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

  /* ── Select a history entry → populate form ──────────────── */

  _selectHistoryEntry(entry) {
    this.selectedHistoryId = entry.id;

    // Switch to the system the entry was generated with (if specified)
    if (entry.system && entry.system !== this.selectedSystem && NPCBuilderApp.SYSTEMS.includes(entry.system)) {
      this.selectedSystem = entry.system;
      NPCBuilderApp.setStoredSystem(entry.system);
      this._applySystemUI();
    }

    // Populate the form with the saved prompt values
    const form = this.element?.querySelector('.npc-form');
    if (form) {
      const nameInput        = form.querySelector('[name="name"]');
      const levelInput       = form.querySelector('[name="level"]');
      const descTextarea     = form.querySelector('[name="description"]');
      const spellsCheckbox   = form.querySelector('[name="includeSpells"]');
      const casterTypeSelect = form.querySelector('[name="casterType"]');
      // Hero 6e-specific fields
      const universeSelect   = form.querySelector('[name="hero6eUniverse"]');
      const genreSelect      = form.querySelector('[name="hero6eGenre"]');
      const gearSelect       = form.querySelector('[name="hero6eCreateGear"]');

      if (nameInput)        nameInput.value         = entry.name;
      if (levelInput)       levelInput.value        = entry.level;
      if (descTextarea)     descTextarea.value      = entry.description;
      if (spellsCheckbox)   spellsCheckbox.checked  = !!entry.includeSpells;
      if (casterTypeSelect) casterTypeSelect.value  = entry.casterType || 'none';
      // Restore Hero 6e settings from history
      if (universeSelect)   universeSelect.value    = entry.universe || 'standard';
      if (genreSelect)      genreSelect.value       = entry.genre    || 'standard';
      if (gearSelect)       gearSelect.checked       = !!entry.createGear;
    }

    // Show the "editing from history" banner
    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) {
      banner.style.display = 'flex';
      const strong = banner.querySelector('strong');
      if (strong) strong.textContent = entry.name;
    }

    // Update highlighted entry
    this.element?.querySelectorAll('.history-entry').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.entryId === entry.id);
    });
  }

  /* ── Update a single history entry (in memory + DOM) ─────── */

  _updateHistoryEntry(id, changes) {
    const entry = this.npcHistory.find(e => e.id === id);
    if (!entry) return;

    Object.assign(entry, changes);
    NPCBuilderApp.saveHistory(this.npcHistory);

    // Patch the DOM element in-place
    const el = this.element?.querySelector(`.history-entry[data-entry-id="${id}"]`);
    if (el) {
      const newEl = this._createHistoryEntryElement(entry);
      el.parentNode.replaceChild(newEl, el);
    }

    // Sync is-generating class on root
    const anyGenerating = this.npcHistory.some(e => e.status === 'generating');
    this.element?.classList.toggle('is-generating', anyGenerating);
  }

  /* ── HTML escape helper ──────────────────────────────────── */

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /* ── Sign-in (Patreon OAuth — popup + poll fallback) ─────── */

  async _signIn(event) {
    event?.preventDefault?.();

    const N8N_ORIGIN  = new URL(NPCBuilderApp._url(NPCBuilderApp.N8N_AUTH_URL)).origin;
    const POLL_URL    = N8N_ORIGIN + NPCBuilderApp._url('/webhook/oauth/patreon/poll');
    const POLL_MS     = 2500;   // poll every 2.5 s
    const TIMEOUT_MS  = 5 * 60 * 1000; // give up after 5 min

    console.log('[NPC Builder] starting Patreon sign-in, poll URL:', POLL_URL);

    try {
      // Generate a nonce here in the module and pass it to n8n via the login URL.
      // n8n will embed it in the OAuth state and store it with the session on callback.
      // This lets us poll /oauth/patreon/poll?nonce=<nonce> from any environment
      // (browser popup OR Electron external browser) without relying on postMessage.
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)))
        .map(b => b.toString(16).padStart(2,'0')).join('');

      const authUrl = NPCBuilderApp._url(NPCBuilderApp.N8N_AUTH_URL)
        + '?origin=' + encodeURIComponent(window.location.origin)
        + '&nonce='  + encodeURIComponent(nonce);

      const w = 520, h = 720;
      const Y = (window.top?.outerHeight || window.outerHeight);
      const X = (window.top?.outerWidth  || window.outerWidth);
      const y = (Y / 2) + (window.top?.screenY || window.screenY) - (h / 2);
      const x = (X / 2) + (window.top?.screenX || window.screenX) - (w / 2);

      console.log('[NPC Builder] generated poll nonce:', nonce);

      // Open the auth window for the user to log in
      const win = window.open(
        authUrl,
        'patreon-login',
        `toolbar=0,location=1,status=0,menubar=0,scrollbars=1,resizable=1,width=${w},height=${h},left=${x},top=${y}`
      );

      let resolved = false;

      const onSuccess = (key) => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        window.removeEventListener('message', msgHandler);
        try { win?.close?.(); } catch {}
        this.accessKey     = String(key);
        NPCBuilderApp.setStoredKey(this.accessKey);
        this.authenticated = true;
        this._applyAuthStateUI();
        ui.notifications?.info?.('Patreon sign-in complete.');
      };

      const onFailure = (errMsg) => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        window.removeEventListener('message', msgHandler);
        ui.notifications?.error?.(errMsg || 'Patreon membership required to use the NPC Builder.', { permanent: true });
        setTimeout(() => window.open(NPCBuilderApp.PATREON_URL, '_blank'), 800);
      };

      // Method A: postMessage (works in browser popup flow)
      const msgHandler = (ev) => {
        // Log every message so we can diagnose whether postMessage arrives at all
        console.log('[NPC Builder] window message received — origin:', ev.origin, 'data:', ev.data);
        const okOrigins = new Set([N8N_ORIGIN, window.location.origin, 'null', '*']);
        if (!okOrigins.has(ev.origin) && ev.origin !== '') {
          console.log('[NPC Builder] postMessage ignored (origin not in allowlist):', ev.origin);
          return;
        }
        let data = ev.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { return; }
        }
        if (!data || data.type !== 'patreon-auth') return;
        console.log('[NPC Builder] postMessage auth received:', data);
        if (data.ok && data.key && String(data.key).length >= 32) {
          console.log('[NPC Builder] postMessage success — key length:', data.key.length);
          onSuccess(data.key);
        } else {
          console.warn('[NPC Builder] postMessage auth failed:', data);
          onFailure(data?.error);
        }
      };
      window.addEventListener('message', msgHandler);

      // Method B: polling (works in Electron / external browser where opener is null)
      let pollTimer = null;
      let consecutiveErrors = 0;
      const MAX_ERRORS = 10; // ~25 s of consecutive failures before giving up
      const deadline = Date.now() + TIMEOUT_MS;
      pollTimer = setInterval(async () => {
          if (resolved) { clearInterval(pollTimer); return; }
          if (Date.now() > deadline) {
            clearInterval(pollTimer);
            if (!resolved) onFailure('Sign-in timed out. Please try again.');
            return;
          }
          try {
            const resp = await fetch(POLL_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nonce }),
            });
            console.log('[NPC Builder] poll status:', resp.status);
            if (resp.status === 500) {
              consecutiveErrors++;
              if (consecutiveErrors === 3) {
                console.error(
                  '[NPC Builder] Poll endpoint returning 500 errors.',
                  'The patreon_sessions table may be missing the "nonce" column.',
                  'Add it in n8n under Data → patreon_sessions → Add column → nonce (string).'
                );
              }
              if (consecutiveErrors >= MAX_ERRORS) {
                clearInterval(pollTimer);
                onFailure('Sign-in server error — please contact support or check n8n logs.');
              }
              return;
            }
            consecutiveErrors = 0;
            if (!resp.ok) {
              console.log('[NPC Builder] poll not ready yet (status', resp.status, ')');
              return; // 404 / other = not ready yet, keep polling
            }
            const data = await resp.json();
            console.log('[NPC Builder] poll response data:', data);
            if (data.ok && data.key && String(data.key).length >= 32) {
              console.log('[NPC Builder] poll success — key length:', data.key.length);
              onSuccess(data.key);
            } else if (data.error && data.error !== 'not_found') {
              console.warn('[NPC Builder] poll auth failed:', data.error);
              onFailure(data.error);
            }
            // data.pending === true means still waiting — keep polling
          } catch (err) {
            consecutiveErrors++;
            console.warn(
              `[NPC Builder] poll fetch error (${consecutiveErrors}/${MAX_ERRORS}):`, err.message,
              '— likely CORS headers missing from n8n poll endpoint error responses'
            );
            if (consecutiveErrors >= MAX_ERRORS) {
              clearInterval(pollTimer);
              onFailure('Sign-in server error — CORS or network issue on the poll endpoint.');
            }
          }
        }, POLL_MS);

      ui.notifications?.info?.('Opening Patreon sign-in…');

    } catch (err) {
      console.error('[NPC Builder] sign-in error', err);
      ui.notifications?.error?.('Failed to start Patreon sign-in.');
    }
  }

  /* ── Sign-out ────────────────────────────────────────────── */

  async _signOut(event) {
    event?.preventDefault?.();
    NPCBuilderApp.setStoredKey('');
    this.accessKey     = '';
    this.authenticated = false;
    this._applyAuthStateUI();
    ui.notifications?.info?.('Signed out.');
  }

  /* ── Build spell mapping from Foundry compendium ─────────── */

  async _buildSpellMapping() {
    console.log('[NPC Builder] Building spell mapping...');

    const spellMapping = [];
    const spellPacks   = game.packs.filter(pack =>
      pack.documentName === 'Item' &&
      pack.metadata.type === 'Item' &&
      (pack.metadata.id?.includes('spell') || pack.metadata.label?.toLowerCase().includes('spell'))
    );

    console.log(`[NPC Builder] Found ${spellPacks.length} spell packs`);

    for (const pack of spellPacks) {
      const index = await pack.getIndex({ fields: ['name', 'system.level.value', 'type'] });
      for (const entry of index) {
        if (entry.type === 'spell') {
          spellMapping.push({
            name:   entry.name,
            id:     entry._id,
            packId: pack.collection,
            level:  entry.system?.level?.value ?? 0,
          });
        }
      }
    }

    console.log(`[NPC Builder] Mapped ${spellMapping.length} spells`);
    return spellMapping;
  }

  /* ── Generate NPC (concurrent — each request gets its own history entry) ── */

  async _generateNPC(event) {
    event?.preventDefault?.();

    if (!this.authenticated) {
      ui.notifications.warn('Please sign in with Patreon before generating an NPC.');
      return;
    }

    if (this.selectedSystem === 'home') return;

    const form = this.element?.querySelector?.('.npc-form');
    if (!form) {
      ui.notifications.error('Builder form not found.');
      return;
    }

    const fd            = new FormData(form);
    const name          = (fd.get('name')?.toString()?.trim()) || 'Generated NPC';
    const level         = Number(fd.get('level')) || 1;
    const description   = (fd.get('description')?.toString()?.trim()) || '';
    const includeSpells = fd.get('includeSpells') === 'on';
    const casterType    = fd.get('casterType') || 'none';

    // ── Hero 6e-specific fields ───────────────────────────────
    // Primary source: dedicated form controls (select + checkbox).
    // Fallback: parse inline tags from description for backwards compatibility
    // and convenience (e.g. "universe: mha" anywhere in the text).
    const universeEl = form.querySelector('[name="hero6eUniverse"]');
    let hero6eUniverse = (fd.get('hero6eUniverse') || universeEl?.value || '').toLowerCase().trim();
    if (!NPCBuilderApp.HERO6E_UNIVERSES.includes(hero6eUniverse)) {
      // Fallback: extract "universe: mha" tag from description
      const uMatch = description.match(/\buniverse\s*:\s*([\w-]+)/i);
      if (uMatch) {
        const extracted = uMatch[1].toLowerCase();
        if (NPCBuilderApp.HERO6E_UNIVERSES.includes(extracted)) hero6eUniverse = extracted;
      }
    }
    if (!NPCBuilderApp.HERO6E_UNIVERSES.includes(hero6eUniverse)) hero6eUniverse = 'standard';

    // genre: dedicated select wins; fallback to "genre: <value>" in description
    const genreEl = form.querySelector('[name="hero6eGenre"]');
    let hero6eGenre = (fd.get('hero6eGenre') || genreEl?.value || '').toLowerCase().trim();
    if (!NPCBuilderApp.HERO6E_GENRES.includes(hero6eGenre)) {
      const genreMatch = description.match(/\bgenre\s*:\s*([\w_-]+)/i);
      if (genreMatch) {
        const extracted = genreMatch[1].toLowerCase();
        if (NPCBuilderApp.HERO6E_GENRES.includes(extracted)) hero6eGenre = extracted;
      }
    }
    if (!NPCBuilderApp.HERO6E_GENRES.includes(hero6eGenre)) hero6eGenre = 'standard';

    // createGear: checkbox — .checked is authoritative; 'on' is the FormData value when checked
    const gearEl = form.querySelector('[name="hero6eCreateGear"]');
    let hero6eCreateGear = gearEl?.checked === true || fd.get('hero6eCreateGear') === 'on';
    if (!hero6eCreateGear) {
      hero6eCreateGear = /\bgear\s*:\s*(yes|true|1)\b/i.test(description);
    }

    if (!description) {
      ui.notifications.warn('Please provide a description for the NPC.');
      return;
    }

    const key = this.accessKey || NPCBuilderApp.getStoredKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    // ── Create history entry ──────────────────────────────────
    const historyEntry = {
      id:            foundry.utils.randomID(16),
      name,
      level,
      description,
      includeSpells,
      casterType,
      system:        this.selectedSystem,
      // Hero 6e extras — persisted for history recall
      universe:      this.selectedSystem === 'hero6e' ? hero6eUniverse   : undefined,
      genre:         this.selectedSystem === 'hero6e' ? hero6eGenre      : undefined,
      createGear:    this.selectedSystem === 'hero6e' ? hero6eCreateGear : undefined,
      status:        'generating',
      createdAt:     Date.now(),
      error:         null,
    };

    this.npcHistory.push(historyEntry);
    NPCBuilderApp.saveHistory(this.npcHistory);

    // Insert at the top of the history list (newest first)
    const list = this.element?.querySelector('.history-list');
    if (list) {
      const emptyEl = list.querySelector('.history-empty');
      if (emptyEl) emptyEl.remove();
      list.insertBefore(this._createHistoryEntryElement(historyEntry), list.firstChild);
    }

    // Set is-generating on root
    this.element?.classList.add('is-generating');

    // ── Clear the selected-entry banner since we're starting fresh ──
    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) banner.style.display = 'none';
    this.selectedHistoryId = null;
    this.element?.querySelectorAll('.history-entry.is-selected').forEach(el => el.classList.remove('is-selected'));

    // ── Run generation (no await on outer scope — truly concurrent) ──
    this._runGeneration(
      historyEntry, key, name, level, description,
      includeSpells, casterType, this.selectedSystem,
      hero6eUniverse, hero6eCreateGear, hero6eGenre
    );
  }

  /**
   * Internal async worker for a single NPC generation.
   *
   * @param {object} historyEntry
   * @param {string} key           Patreon session key
   * @param {string} name
   * @param {number} level         Level / CR / point value
   * @param {string} description
   * @param {boolean} includeSpells  PF2e only
   * @param {string} casterType      D&D 5e only
   * @param {string} system          pf2e | dnd5e | hero6e
   * @param {string} hero6eUniverse  standard | mha | dc | marvel
   * @param {boolean} hero6eCreateGear  Whether to generate gear items
   * @param {string} hero6eGenre  standard | superhero | pulp | dark_champions | fantasy | sci-fi
   */
  async _runGeneration(
    historyEntry, key, name, level, description,
    includeSpells, casterType = 'none', system = 'pf2e',
    hero6eUniverse = 'standard', hero6eCreateGear = false, hero6eGenre = 'standard'
  ) {
    try {
      let endpoint, payload;

      if (system === 'dnd5e') {
        // ── D&D 5e ───────────────────────────────────────────────────────────
        endpoint = NPCBuilderApp._url(NPCBuilderApp.N8N_DND5E_URL);
        payload  = { name, cr: level, description, casterType };
        console.log('[NPC Builder] D&D 5e generation request:', { name, cr: level, casterType });

        if (casterType !== 'none') {
          ui.notifications.info('Building spell mapping… (this may take 5–10 seconds)');
          payload.spellMapping = await this._buildSpellMapping();
          console.log(`[NPC Builder] Added ${payload.spellMapping.length} D&D 5e spells to payload`);
        }

      } else if (system === 'hero6e') {
        // ── Hero System 6e ───────────────────────────────────────────────────
        endpoint = NPCBuilderApp._url(NPCBuilderApp.N8N_HERO6E_URL);

        // Snap points to nearest valid tier
        const points = NPCBuilderApp._snapToHero6eTier(level);

        payload = {
          name,
          points,
          genre: hero6eGenre,
          description,
          universe:    hero6eUniverse,
          createGear:  hero6eCreateGear,
        };

        console.log('[NPC Builder] Hero System 6e generation request:', {
          name, points, genre: hero6eGenre,
          universe: hero6eUniverse,
          createGear: hero6eCreateGear,
        });

      } else {
        // ── Pathfinder 2e (default) ───────────────────────────────────────────
        endpoint = NPCBuilderApp._url(NPCBuilderApp.N8N_NPC_URL);
        payload  = { name, level, description };

        if (includeSpells) {
          ui.notifications.info('Building spell mapping… (this may take 5–10 seconds)');
          payload.spellMapping = await this._buildSpellMapping();
          console.log(`[NPC Builder] Added ${payload.spellMapping.length} spells to payload`);
        }

        console.log('[NPC Builder] PF2e generation request:', {
          name,
          level,
          hasSpellMapping: !!payload.spellMapping,
          spellCount:      payload.spellMapping?.length || 0,
        });
      }

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
      console.log('[NPC Builder] Raw response length:', responseText.length, 'bytes');

      let data;
      try {
        data = JSON.parse(responseText);
        console.log('[NPC Builder] Response from n8n:', { status: response.status, data });
      } catch (err) {
        console.error('[NPC Builder] Failed to parse JSON response:', err);
        console.error('[NPC Builder] Response text preview (first 500):', responseText.substring(0, 500));
        console.error('[NPC Builder] Response text preview (last 500):', responseText.substring(Math.max(0, responseText.length - 500)));

        const foundryNpcMatch = responseText.match(/"foundryNpc"\s*:\s*({[\s\S]*)/);
        if (foundryNpcMatch) {
          try {
            let depth = 0, inString = false, escape = false;
            const npcJson = foundryNpcMatch[1];
            for (let i = 0; i < npcJson.length; i++) {
              const char = npcJson[i];
              if (escape)        { escape = false; continue; }
              if (char === '\\') { escape = true;  continue; }
              if (char === '"')  { inString = !inString; continue; }
              if (!inString) {
                if (char === '{') depth++;
                if (char === '}') {
                  depth--;
                  if (depth === 0) {
                    data = { ok: true, foundryNpc: JSON.parse(npcJson.substring(0, i + 1)) };
                    break;
                  }
                }
              }
            }
          } catch (extractErr) {
            console.error('[NPC Builder] Failed to extract foundryNpc:', extractErr);
          }
        }

        if (!data) throw new Error(`Invalid JSON response (${responseText.length} bytes): ${err.message}`);
      }

      if (response.status === 401 || response.status === 403) {
        NPCBuilderApp.setStoredKey('');
        this.accessKey     = '';
        this.authenticated = false;
        this._applyAuthStateUI();
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: 'Authentication failed' });

        const message = data?.message || 'Unauthorized. Please sign in with Patreon.';
        ui.notifications.error(message, { permanent: true });
        setTimeout(() => window.open(NPCBuilderApp.PATREON_URL, '_blank'), 800);

      } else if (response.status === 429 || data?.error === 'RATE_LIMIT_EXCEEDED') {
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: 'Rate limit exceeded' });
        const message      = data?.message || 'Monthly NPC limit reached.';
        const currentUsage = data?.currentUsage || 0;
        const limit        = data?.limit || 0;
        // Infer and cache the tier for feedback submissions
        const tierMap = { 3: 'Free', 15: 'Local Adventurer', 50: 'Standard', 80: 'Champion' };
        if (limit && tierMap[limit]) this.patreonTier = tierMap[limit];
        ui.notifications.error(message, { permanent: true });
        ui.notifications.warn(
          `You've used ${currentUsage}/${limit} NPCs this month. Opening Patreon to upgrade…`,
          { permanent: true }
        );
        setTimeout(() => window.open(NPCBuilderApp.PATREON_URL, '_blank'), 1200);

      } else if (response.ok) {
        if (data?.ok === false) throw new Error(data?.message || data?.error || 'Server rejected the request');

        const actorData    = data.foundryNpc || data.npcDesign || data.actor || data;
        const chosenSpells = Array.isArray(data.chosenSpells) ? data.chosenSpells : [];

        if (!actorData || typeof actorData !== 'object') throw new Error('No valid actor data returned from server');
        if (!actorData.name || !actorData.type) throw new Error(`Invalid actor data: missing ${!actorData.name ? 'name' : 'type'}`);

        console.log('[NPC Builder] Creating actor in Foundry...', actorData);

        // PF2e: enrich spell skeletons with full compendium data before validation
        if (system === 'pf2e') {
          await enrichSpellsFromCompendium(actorData);
        }

        if (system === 'dnd5e') {
          this._sanitizeActorDataDnd5e(actorData);
        } else if (system === 'hero6e') {
          this._sanitizeActorDataHero6e(actorData);
        } else {
          this._sanitizeActorData(actorData);
        }

        // prototypeToken was deleted by _sanitizeActorDataDnd5e. Save name/img to
        // restore on the live document after Actor.create() completes.
        const _dnd5eTokenName = actorData.name;
        const _dnd5eTokenImg  = actorData.img || 'icons/svg/mystery-man.svg';

        // ── dnd5e 5.x / Foundry v14: merge system data against the blank NPC schema ──
        if (system === 'dnd5e') {
          try {
            const blankSchema = foundry.utils.deepClone(
              game.system.model?.Actor?.npc ?? {}
            );
            actorData.system = foundry.utils.mergeObject(
              blankSchema,
              actorData.system ?? {},
              { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
            );
            console.log('[NPC Builder] D&D 5e: system merged against blank NPC schema');
            if (!actorData.system.token || typeof actorData.system.token !== 'object') {
              actorData.system.token = {};
            }
          } catch (mergeErr) {
            console.warn('[NPC Builder] D&D 5e: schema merge failed (non-fatal):', mergeErr);
          }
        }

        let actor, attempts = 0;
        const maxAttempts = 10;

        while (!actor && attempts < maxAttempts) {
          attempts++;
          try {
            actor = await Actor.create(actorData);
          } catch (error) {
            const errorText = error.toString ? error.toString() : String(error.message || error);
            if (system !== 'dnd5e' && system !== 'hero6e' && this._tryFixValidationError(actorData, errorText)) {
              console.warn(`[NPC Builder] Fixed validation error, retrying (attempt ${attempts})...`);
              continue;
            }
            throw error;
          }
        }

        if (actor) {
          if (system === 'dnd5e') {
            // Patch token name + img now that the DataModel is fully initialized
            await actor.update({
              'prototypeToken.name': _dnd5eTokenName,
              'prototypeToken.texture.src': _dnd5eTokenImg,
            });

            // Embed chosen spells from compendium
            if (chosenSpells.length > 0) {
              ui.notifications.info(`Adding ${chosenSpells.length} spells…`);
              const spellItems = [];
              for (const spell of chosenSpells) {
                try {
                  const pack = game.packs.get(spell.packId);
                  if (!pack) { console.warn('[NPC Builder] Pack not found:', spell.packId); continue; }
                  const doc = await pack.getDocument(spell.id);
                  if (doc) spellItems.push(doc.toObject());
                } catch (e) {
                  console.warn('[NPC Builder] Failed to load spell:', spell.name, e.message);
                }
              }
              if (spellItems.length > 0) {
                await actor.createEmbeddedDocuments('Item', spellItems);
                console.log(`[NPC Builder] Embedded ${spellItems.length} spells on actor`);
              }
            }
          }

          // For Hero 6e: _preCreate resets characteristics max/value to base (0).
          // fullHealth() reads system[KEY].LEVELS (correctly set by n8n) and
          // propagates base + LEVELS into characteristics[key].max and .value.
          if (system === 'hero6e') {
            await actor.fullHealth();
          }

          this.lastGeneratedNPC = actorData;
          this._updateHistoryEntry(historyEntry.id, { status: 'success' });
          ui.notifications.success(`NPC "${actor.name}" created successfully!`);
          actor.sheet.render(true);
        } else {
          throw new Error('Failed to create actor after maximum retry attempts');
        }

      } else {
        throw new Error(data?.message || `Server returned status ${response.status}`);
      }

    } catch (err) {
      console.error('[NPC Builder] NPC generation error', err);
      this._updateHistoryEntry(historyEntry.id, { status: 'error', error: err.message });
      ui.notifications.error(`Failed to generate "${name}": ${err.message}`);
    }
  }

  /* ── System-specific sanitization (delegates to system modules) ── */

  _sanitizeActorData(actorData) {
    sanitizeActorDataPf2e(actorData);
  }

  _sanitizeActorDataDnd5e(actorData) {
    sanitizeActorDataDnd5e(actorData);
  }

  _sanitizeActorDataHero6e(actorData) {
    sanitizeActorDataHero6e(actorData);
  }

  _tryFixValidationError(actorData, errorMessage) {
    return tryFixValidationError(actorData, errorMessage);
  }

  /* ── Generate NPC Image (costs 4 uses) ───────────────────── */

  /**
   * Prompt the user to confirm image generation (costs 4 uses), then send
   * the NPC data + system + art style to the n8n image workflow.
   *
   * Can be called from the builder form (uses lastGeneratedNPC) or from
   * a sheet injection (receives actorData directly).
   *
   * @param {Event|null} event       DOM event (may be null for sheet calls)
   * @param {object}     [actorData] Actor data to generate an image for (optional — falls back to lastGeneratedNPC)
   * @param {string}     [system]    System override (optional — falls back to selectedSystem)
   */
  async _generateImage(event, actorData, system) {
    event?.preventDefault?.();

    if (!this.authenticated) {
      ui.notifications.warn('Please sign in with Patreon before generating an image.');
      return;
    }

    const npcData = actorData || this.lastGeneratedNPC;
    if (!npcData) {
      ui.notifications.warn('No NPC available. Generate or open an NPC first.');
      return;
    }

    const targetSystem = system || this.selectedSystem || 'pf2e';
    const artStyle     = NPCBuilderApp.getStoredArtStyle();
    const cost         = NPCBuilderApp.IMAGE_COST;

    // Confirmation dialog
    const confirmed = await new Promise(resolve => {
      const DialogV2 = foundry.applications?.api?.DialogV2;
      const content  = `
        <div style="display:flex;flex-direction:column;gap:0.6em;padding:0.25em 0;">
          <p style="margin:0;">
            Generate an image for <strong>${this._escapeHtml(npcData.name || 'this NPC')}</strong>?
          </p>
          <p style="margin:0;padding:0.5em 0.7em;background:rgba(46,125,50,0.1);border:1px solid rgba(46,125,50,0.3);border-radius:4px;font-size:0.92em;">
            <i class="fa-solid fa-coins" style="color:#2e7d32;"></i>
            This will use <strong>${cost} NPC uses</strong> from your monthly allowance.
          </p>
          ${artStyle ? `<p style="margin:0;font-size:0.88em;color:#555;"><i class="fa-solid fa-palette"></i> Art style: <em>${this._escapeHtml(artStyle)}</em></p>` : ''}
        </div>`;

      if (DialogV2) {
        DialogV2.confirm({
          window:  { title: 'Generate NPC Image' },
          content,
          yes: { label: 'Generate Image', icon: 'fa-solid fa-image' },
          no:  { label: 'Cancel' },
          rejectClose: false,
        }).then(result => resolve(result === true)).catch(() => resolve(false));
      } else {
        new Dialog({
          title:   'Generate NPC Image',
          content,
          buttons: {
            yes:     { label: '<i class="fa-solid fa-image"></i> Generate Image', callback: () => resolve(true) },
            cancel:  { label: 'Cancel', callback: () => resolve(false) },
          },
          default: 'cancel',
          close:   () => resolve(false),
        }).render(true);
      }
    });

    if (!confirmed) return;

    const key = this.accessKey || NPCBuilderApp.getStoredKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    ui.notifications.info('Generating NPC image… this may take a moment.');

    try {
      const payload = {
        npcData: JSON.parse(JSON.stringify(npcData)),
        system:  targetSystem,
        artStyle: artStyle || '',
      };

      const response = await fetch(NPCBuilderApp._url(NPCBuilderApp.N8N_IMAGE_URL), {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Builder-Key':    key,
          'X-Foundry-Origin': window.location.origin,
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 401 || response.status === 403) {
        NPCBuilderApp.setStoredKey('');
        this.accessKey     = '';
        this.authenticated = false;
        this._applyAuthStateUI();
        ui.notifications.error('Authentication failed. Please sign in again.', { permanent: true });
        return;
      }

      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        const currentUsage = data?.currentUsage || 0;
        const limit        = data?.limit || 0;
        ui.notifications.error(data?.message || 'Monthly limit reached.', { permanent: true });
        if (limit) ui.notifications.warn(`You've used ${currentUsage}/${limit} uses this month.`, { permanent: true });
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || `Server returned status ${response.status}`);
      }

      const data = await response.json();

      if (data?.imageUrl) {
        // Fetch the image from n8n and save it into Foundry's user data via FilePicker.upload
        const actorId = npcData._id;
        const actor   = actorId ? game.actors?.get(actorId) : null;

        let savedPath = null;
        try {
          // Download the image bytes
          const imgResp = await fetch(data.imageUrl);
          if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
          const blob = await imgResp.blob();

          // Build a safe filename: slug of NPC name + short random id
          const slug = (npcData.name || 'npc')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 48);
          const uid  = foundry.utils.randomID(8);
          const ext  = blob.type === 'image/webp' ? 'webp' : (blob.type === 'image/png' ? 'png' : 'webp');
          const filename = `${slug}-${uid}.${ext}`;

          // Ensure the target folder exists, then upload
          const folder = 'npc-images';
          try {
            await FilePicker.createDirectory('data', folder, {});
          } catch (_) {
            // Directory likely already exists — that's fine
          }

          const file   = new File([blob], filename, { type: blob.type });
          const result = await FilePicker.upload('data', folder, file, {});
          savedPath    = result?.path ?? `${folder}/${filename}`;
          console.log('[NPC Builder] Image saved to Foundry:', savedPath);
        } catch (uploadErr) {
          console.error('[NPC Builder] Failed to save image to Foundry, falling back to URL:', uploadErr);
          savedPath = data.imageUrl;
        }

        if (actor) {
          await actor.update({
            'img': savedPath,
            'prototypeToken.texture.src': savedPath,
          });
          ui.notifications.success(`Image set for "${actor.name}"!`);
        } else {
          ui.notifications.success('NPC image saved: ' + savedPath);
        }
      } else {
        ui.notifications.success('Image generation request sent successfully.');
      }

    } catch (err) {
      console.error('[NPC Builder] Image generation error:', err);
      ui.notifications.error(`Image generation failed: ${err.message}`);
    }
  }

  /* ── Level Up NPC (PF2e only) ───────────────────────────── */

  /**
   * Opens a dialog to select a new level, then sends the NPC's JSON
   * + target level to the n8n level-up workflow for PF2e.
   *
   * @param {Actor} actor  The Foundry Actor to level up
   */
  async _levelUpNpc(actor) {
    if (!this.authenticated) {
      ui.notifications.warn('Please sign in with Patreon to use Level Up.');
      return;
    }

    const currentLevel = actor.system?.details?.level?.value ?? actor.system?.details?.level ?? 0;

    // Prompt for target level + level-up instructions
    const result = await new Promise(resolve => {
      const DialogV2 = foundry.applications?.api?.DialogV2;
      const content  = `
        <div style="display:flex;flex-direction:column;gap:0.7em;padding:0.25em 0;">
          <p style="margin:0;">
            Level up (or down) <strong>${this._escapeHtml(actor.name)}</strong>
            (currently level <strong>${currentLevel}</strong>).
          </p>
          <div style="display:flex;flex-direction:column;gap:0.25em;">
            <label for="npc-levelup-target" style="font-weight:600;font-size:0.88em;">Target Level</label>
            <input type="number" id="npc-levelup-target" value="${currentLevel + 1}" min="0" max="25" step="1"
              style="width:80px;text-align:center;padding:0.35em;border:1px solid #999;border-radius:4px;" />
          </div>
          <div style="display:flex;flex-direction:column;gap:0.25em;">
            <label for="npc-levelup-instructions" style="font-weight:600;font-size:0.88em;">Level-Up Instructions</label>
            <textarea id="npc-levelup-instructions" rows="4"
              placeholder="Describe what the NPC gains at this level: new abilities, improved spells, stronger attacks, additional resistances…"
              style="width:100%;padding:0.4em 0.5em;border:1px solid #999;border-radius:4px;font-family:inherit;font-size:0.92em;resize:vertical;box-sizing:border-box;"></textarea>
            <span style="font-size:0.78em;color:#777;font-style:italic;">
              Describe how this NPC should change. The more detail, the better the result.
            </span>
          </div>
          <p style="margin:0;font-size:0.85em;color:#666;">
            The NPC will be re-processed through the builder at the selected level.
            This costs <strong>1 NPC use</strong>.
          </p>
        </div>`;

      const _extractValues = (container) => {
        const root = container instanceof HTMLElement ? container : container?.[0] ?? document;
        const levelInput = root.querySelector?.('#npc-levelup-target') ?? document.getElementById('npc-levelup-target');
        const instrInput = root.querySelector?.('#npc-levelup-instructions') ?? document.getElementById('npc-levelup-instructions');
        const level = levelInput ? parseInt(levelInput.value) : null;
        const instructions = instrInput ? instrInput.value.trim() : '';
        return (level !== null && !isNaN(level)) ? { level, instructions } : null;
      };

      if (DialogV2) {
        DialogV2.prompt({
          window:  { title: 'Level Up NPC' },
          content,
          ok: { label: 'Level Up', icon: 'fa-solid fa-arrow-up' },
          rejectClose: false,
        }).then(() => {
          resolve(_extractValues(document));
        }).catch(() => resolve(null));
      } else {
        new Dialog({
          title:   'Level Up NPC',
          content,
          buttons: {
            confirm: {
              label:    '<i class="fa-solid fa-arrow-up"></i> Level Up',
              callback: (html) => resolve(_extractValues(html)),
            },
            cancel: { label: 'Cancel', callback: () => resolve(null) },
          },
          default: 'cancel',
          close:   () => resolve(null),
        }).render(true);
      }
    });

    if (!result) return;
    const { level: targetLevel, instructions: levelUpInstructions } = result;
    if (targetLevel === currentLevel) {
      ui.notifications.info('Target level is the same as current level.');
      return;
    }

    const key = this.accessKey || NPCBuilderApp.getStoredKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    ui.notifications.info(`Processing level change for "${actor.name}" to level ${targetLevel}…`);

    try {
      const actorJson = actor.toObject();

      const payload = {
        npcData:      actorJson,
        targetLevel:  targetLevel,
        instructions: levelUpInstructions || '',
        system:       'pf2e',
      };

      const response = await fetch(NPCBuilderApp._url(NPCBuilderApp.N8N_LEVELUP_URL), {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Builder-Key':    key,
          'X-Foundry-Origin': window.location.origin,
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 401 || response.status === 403) {
        NPCBuilderApp.setStoredKey('');
        this.accessKey     = '';
        this.authenticated = false;
        this._applyAuthStateUI();
        ui.notifications.error('Authentication failed. Please sign in again.', { permanent: true });
        return;
      }

      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        ui.notifications.error(data?.message || 'Monthly limit reached.', { permanent: true });
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || `Server returned status ${response.status}`);
      }

      const data = await response.json();
      const newActorData = data.foundryNpc || data.npcDesign || data.actor || data;

      if (!newActorData || typeof newActorData !== 'object') {
        throw new Error('No valid actor data returned from server');
      }

      // Enrich spells from compendium
      await enrichSpellsFromCompendium(newActorData);

      // Sanitize
      sanitizeActorDataPf2e(newActorData);

      // Create the leveled NPC as a new actor
      let newActor, attempts = 0;
      const maxAttempts = 10;
      while (!newActor && attempts < maxAttempts) {
        attempts++;
        try {
          newActor = await Actor.create(newActorData);
        } catch (error) {
          const errorText = error.toString ? error.toString() : String(error.message || error);
          if (tryFixValidationError(newActorData, errorText)) {
            console.warn(`[NPC Builder] Fixed validation error on level-up, retrying (attempt ${attempts})...`);
            continue;
          }
          throw error;
        }
      }

      if (newActor) {
        ui.notifications.success(`"${newActor.name}" leveled to ${targetLevel}!`);
        newActor.sheet.render(true);
      } else {
        throw new Error('Failed to create leveled actor after maximum retry attempts');
      }

    } catch (err) {
      console.error('[NPC Builder] Level-up error:', err);
      ui.notifications.error(`Level-up failed: ${err.message}`);
    }
  }

  /* ── Export last generated NPC as JSON ───────────────────── */

  async _exportJSON(event) {
    event?.preventDefault?.();

    if (!this.lastGeneratedNPC) {
      ui.notifications.warn('No NPC has been generated yet.');
      return;
    }

    const json = JSON.stringify(this.lastGeneratedNPC, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${this.lastGeneratedNPC.name || 'npc'}.json`;
    a.click();
    URL.revokeObjectURL(url);

    ui.notifications.info('NPC exported to JSON file.');
  }

  /* ── Send feedback ───────────────────────────────────────── */

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
      const tabLabels = { home: 'Home', pf2e: 'Pathfinder 2e', dnd5e: 'D&D 5e', hero6e: 'HERO 6e' };
      const tab   = tabLabels[this.selectedSystem] || this.selectedSystem || 'Unknown';
      const email = game.user?.email || '';
      const tier  = this.patreonTier || (this.authenticated ? 'Supporter (tier unknown)' : 'Free');

      const response = await fetch(NPCBuilderApp._url(NPCBuilderApp.N8N_FEEDBACK_URL), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message,
          tab,
          email,
          tier,
          sessionKey: this.accessKey || '',
        }),
      });

      if (!response.ok) throw new Error(`Server returned ${response.status}`);

      if (textarea) textarea.value = '';
      if (status) {
        status.textContent = 'Feedback sent! Thank you.';
        status.className   = 'feedback-status feedback-status--success';
        status.style.display = '';
        setTimeout(() => { status.style.display = 'none'; }, 4000);
      }

    } catch (err) {
      console.error('[NPC Builder] feedback send error', err);
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

/* -----------------------------------------------------------------------------
   Singleton helper — reuses an existing window instead of spawning duplicates
----------------------------------------------------------------------------- */

let _npcBuilderApp = null;

function openNPCBuilder() {
  if (_npcBuilderApp?.rendered && _npcBuilderApp?.element?.isConnected) {
    _npcBuilderApp.bringToTop?.();
  } else {
    _npcBuilderApp = null;
    _npcBuilderApp = new NPCBuilderApp();
    _npcBuilderApp.render({ force: true }).catch(err => {
      console.error('[NPC Builder] Failed to open:', err);
      ui.notifications?.error?.('NPC Builder failed to open. Check the console (F12) for details.');
      _npcBuilderApp = null;
    });
  }

  // Non-blocking update check — runs every time the builder is opened
  _checkForModuleUpdate().catch(() => {});
}

/* -----------------------------------------------------------------------------
   Update checker — fetches the manifest and shows a popup when outdated
----------------------------------------------------------------------------- */

/** Returns true if `a` is strictly newer than `b` (simple semver). */
function _isNewerVersion(a, b) {
  const parse = v => (v || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

async function _checkForModuleUpdate() {
  try {
    const modId          = _MODULE_FOLDER;
    const mod            = game.modules?.get(modId);
    const manifestUrl    = mod?.manifest;
    const currentVersion = mod?.version || '';

    if (!manifestUrl || !currentVersion) return;

    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!response.ok) return;

    const data          = await response.json();
    const latestVersion = data?.version || '';

    if (!latestVersion || !_isNewerVersion(latestVersion, currentVersion)) return;

    // Build the popup content
    const content = `
      <div style="display:flex;flex-direction:column;gap:0.6em;padding:0.25em 0;">
        <p style="margin:0;">
          <strong>NPC Builder v${latestVersion}</strong> is available.
          You are running <strong>v${currentVersion}</strong>.
        </p>
        <p style="margin:0;color:#555;font-size:0.92em;">
          Update via the Foundry <em>Add-on Modules</em> manager or from GitHub to get the
          latest features and bug fixes.
        </p>
      </div>`;

    // Prefer DialogV2 (Foundry v13+), fall back to classic Dialog
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2) {
      DialogV2.prompt({
        window:  { title: 'NPC Builder — Update Available' },
        content,
        ok: {
          label:    'View on GitHub',
          icon:     'fa-brands fa-github',
          callback: () => window.open('https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest', '_blank'),
        },
        rejectClose: false,
      }).catch(() => {});
    } else {
      new Dialog({
        title:   'NPC Builder — Update Available',
        content,
        buttons: {
          github: {
            label:    '<i class="fa-brands fa-github"></i> View on GitHub',
            callback: () => window.open('https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest', '_blank'),
          },
          dismiss: { label: 'Dismiss' },
        },
        default: 'dismiss',
      }).render(true);
    }
  } catch (err) {
    // Network errors are expected offline — log quietly and move on
    console.debug('[NPC Builder] Update check failed (offline?):', err);
  }
}

/* -----------------------------------------------------------------------------
   Header controls + sidebar injection
----------------------------------------------------------------------------- */

function registerNPCBuilderControl(app, controls) {
  if (!game.user?.isGM) return;
  const exists = controls.some(c => c.action === `${_MODULE_FOLDER}-control`);
  if (exists) return;
  controls.push({
    action:  `${_MODULE_FOLDER}-control`,
    icon:    'fa-solid fa-star',
    label:   'NPC Builder',
    onClick: () => openNPCBuilder(),
    onclick: () => openNPCBuilder(),
    visible: true,
  });
}

function injectSidebarButton(app, html) {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  if (root.querySelector('.npc-builder-button')) return;

  const button = document.createElement('button');
  button.type  = 'button';
  button.classList.add('npc-builder-button');
  button.style.marginLeft = '4px';
  button.innerHTML = '★ NPC Builder ★';
  button.addEventListener('click', () => openNPCBuilder());

  const header = root.querySelector('header') || root.querySelector('.directory-header');
  if (header) header.appendChild(button); else root.prepend(button);
}

// Support common hook names across versions
Hooks.on('getHeaderControlsActorDirectory',          registerNPCBuilderControl);
Hooks.on('getHeaderControlsCompendiumDirectory',      registerNPCBuilderControl);
Hooks.on('getHeaderControlsActorDirectoryPF2e',       registerNPCBuilderControl);
Hooks.on('getHeaderControlsCompendiumDirectoryPF2e',  registerNPCBuilderControl);
Hooks.on('getHeaderControlsApplicationV2', (app, controls) => {
  try {
    const name = app?.constructor?.name;
    if (
      name === 'ActorDirectory' || name === 'CompendiumDirectory' ||
      name === 'ActorDirectoryPF2e' || name === 'CompendiumDirectoryPF2e'
    ) registerNPCBuilderControl(app, controls);
  } catch (err) {
    console.warn('PF2E NPC Builder: generic header control hook failed', err);
  }
});

Hooks.on('renderActorDirectory',             injectSidebarButton);
Hooks.on('renderCompendiumDirectory',        injectSidebarButton);
Hooks.on('renderActorDirectoryPF2e',         injectSidebarButton);
Hooks.on('renderCompendiumDirectoryPF2e',    injectSidebarButton);

/* -----------------------------------------------------------------------------
   PF2e NPC sheet injection — Level Up + Generate Image buttons
----------------------------------------------------------------------------- */

function _ensureBuilderApp() {
  if (!_npcBuilderApp?.rendered || !_npcBuilderApp?.element?.isConnected) {
    _npcBuilderApp = new NPCBuilderApp();
    // Don't render the window — we just need the instance for auth + methods
  }
  // Ensure auth state is current
  _npcBuilderApp.accessKey     = NPCBuilderApp.getStoredKey() || '';
  _npcBuilderApp.authenticated = !!_npcBuilderApp.accessKey;
  return _npcBuilderApp;
}

/**
 * Injects "Level Up" and "Generate Image" buttons into PF2e NPC sheets.
 * - Level Up: inserted to the left of Elite/Weak buttons in the header area
 * - Generate Image: inserted above the AC section
 */
function injectPf2eSheetButtons(app, html) {
  if (!game.user?.isGM) return;

  const actor = app.actor || app.document;
  if (!actor || actor.type !== 'npc') return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // Avoid double-injection
  if (root.querySelector('.npc-builder-levelup-btn')) return;

  // ── Level Up button — look for the elite/weak adjustment area ──
  // PF2e sheets use various selectors depending on version
  const eliteWeakArea =
    root.querySelector('.adjustment') ||          // PF2e v6+
    root.querySelector('.elite-weak') ||          // older PF2e
    root.querySelector('[data-action="elite"]')?.parentElement ||
    root.querySelector('.npc-header')?.querySelector('.tags') ||
    root.querySelector('.sheet-header .tags');

  if (eliteWeakArea) {
    const levelUpBtn = document.createElement('button');
    levelUpBtn.type = 'button';
    levelUpBtn.className = 'npc-builder-levelup-btn';
    levelUpBtn.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Level Up';
    levelUpBtn.title = 'Change this NPC\'s level via the NPC Builder';
    levelUpBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const builderApp = _ensureBuilderApp();
      builderApp._levelUpNpc(actor);
    });

    // Insert as a sibling before the elite/weak container (to its left)
    eliteWeakArea.parentNode.insertBefore(levelUpBtn, eliteWeakArea);
  }

  // ── Generate Image button — look for AC / armor class area ──
  const acSection =
    root.querySelector('.armor-class') ||         // PF2e v6+
    root.querySelector('.ac') ||                  // alternate
    root.querySelector('[data-slug="ac"]') ||
    root.querySelector('.side-bar-section');       // fallback

  if (acSection) {
    const imageBtn = document.createElement('button');
    imageBtn.type = 'button';
    imageBtn.className = 'npc-builder-sheet-image-btn';
    imageBtn.innerHTML = '<i class="fa-solid fa-image"></i> Generate Image <span class="btn-cost-badge">4 uses</span>';
    imageBtn.title = 'Generate an AI image for this NPC (costs 4 NPC uses)';
    imageBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const builderApp = _ensureBuilderApp();
      builderApp._generateImage(null, actor.toObject(), 'pf2e');
    });

    // Insert just before the AC section
    acSection.parentNode.insertBefore(imageBtn, acSection);
  }
}

// Hook into PF2e NPC sheet rendering
Hooks.on('renderNPCSheetPF2e',   injectPf2eSheetButtons);
Hooks.on('renderActorSheetPF2e', (app, html) => {
  if (app.actor?.type === 'npc') injectPf2eSheetButtons(app, html);
});
// Generic fallback for various Foundry/PF2e versions
Hooks.on('renderActorSheet', (app, html) => {
  if (game.system?.id !== 'pf2e') return;
  if (app.actor?.type === 'npc') injectPf2eSheetButtons(app, html);
});

Hooks.once('init', () => {
  game.settings.register(_MODULE_FOLDER, 'devMode', {
    name: 'Developer Mode',
    hint: 'When enabled, all webhook URLs are routed to the -dev endpoints. Disable before going live.',
    scope:  'world',
    config: true,
    type:   Boolean,
    default: false,
  });
});

Hooks.once('ready', () => {
  const modId         = _MODULE_FOLDER;
  const currentVersion = game.modules?.get(modId)?.version || '';
  const storedVersion  = NPCBuilderApp.getStoredVersion();

  // Sign users out when the module updates so stale sessions don't persist
  if (currentVersion && storedVersion && currentVersion !== storedVersion) {
    NPCBuilderApp.setStoredKey('');
    console.log(`[NPC Builder] Module updated ${storedVersion} → ${currentVersion}. Session cleared.`);
    ui.notifications?.info?.('NPC Builder was updated — please sign in again.', { permanent: false });
  }

  if (currentVersion) NPCBuilderApp.setStoredVersion(currentVersion);

  (foundry.applications.handlebars?.loadTemplates ?? loadTemplates)([`modules/${modId}/templates/builder.html`]);
  console.log(`PF2E NPC Auto-Builder ready (module folder: ${modId}, version: ${currentVersion}).`);
});
