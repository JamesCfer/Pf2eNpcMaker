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
 */

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

class NPCBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** n8n endpoints */
  static N8N_AUTH_URL   = 'https://foundryrelay.dedicated2.com/webhook/oauth/patreon/login';
  static N8N_NPC_URL    = 'https://foundryrelay.dedicated2.com/webhook/npc-builder';
  static N8N_DND5E_URL  = 'https://foundryrelay.dedicated2.com/webhook/dnd5e-npc-builder';
  static PATREON_URL    = 'https://www.patreon.com/cw/CelestiaTools';

  /** localStorage slots */
  static STORAGE_KEYS = ['pf2e-npc-builder.key', 'pf2e-npc-builder:key'];

  /** localStorage slot for NPC history */
  static HISTORY_KEY = 'pf2e-npc-builder.history';

  /** localStorage slot for selected game system */
  static SYSTEM_KEY = 'pf2e-npc-builder.system';

  /** localStorage slot for last-seen module version (used to force sign-out on updates) */
  static VERSION_KEY = 'pf2e-npc-builder.module-version';

  /** Max history entries to retain */
  static MAX_HISTORY = 50;

  /** Supported game systems */
  static SYSTEMS = ['pf2e', 'dnd5e', 'hero6e'];

  static DEFAULT_OPTIONS = {
    id: 'pf2e-npc-builder',
    classes: ['pf2e', 'npc-builder'],
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
      selectsystem:  function(event) { this._selectSystem(event); },
    },
  };

  static get PARTS() {
    const modId = game.modules?.get('Pf2eNpcMaker') ? 'Pf2eNpcMaker' : 'pf2e-npc-auto-builder';
    return {
      form: { template: `modules/${modId}/templates/builder.html` },
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
  }

  /* ── Auth state UI ───────────────────────────────────────── */

  _applyAuthStateUI() {
    const root = this.element;
    if (!root) return;

    root.classList.toggle('is-authenticated', !!this.authenticated);

    const anyGenerating = this.npcHistory.some(e => e.status === 'generating');
    root.classList.toggle('is-generating', anyGenerating);

    const isUnusableSystem = this.selectedSystem === 'hero6e';

    const genBtn = root.querySelector('button[data-action="generate"]');
    if (genBtn) {
      genBtn.disabled = !this.authenticated || isUnusableSystem;
      const label = genBtn.querySelector('.btn-label');
      if (label) label.textContent = isUnusableSystem ? 'Not Available' : 'Generate NPC';
    }

    const expBtn = root.querySelector('button[data-action="export"]');
    if (expBtn) expBtn.disabled = !this.authenticated;
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
        levelLabel:      'Power Level',
        levelMin:        '1',
        levelMax:        '12',
        levelStep:       '1',
        levelDefault:    '1',
        namePlaceholder: 'e.g. Ironclad',
        descPlaceholder: 'Describe this character: their powers, combat style, skills, limitations, background…',
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
    }

    const nameInput = root.querySelector('#npc-name');
    if (nameInput) nameInput.placeholder = cfg.namePlaceholder;

    const descTextarea = root.querySelector('#npc-desc');
    if (descTextarea) descTextarea.placeholder = cfg.descPlaceholder;

    const historyLabel = root.querySelector('.history-header-label');
    if (historyLabel) historyLabel.textContent = cfg.historyLabel;

    // Sync auth UI (handles button disabled state with system awareness)
    this._applyAuthStateUI();
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
    const metaLabel    = entry.system === 'dnd5e' ? `CR&nbsp;${entry.level}` : `Lv.&nbsp;${entry.level}`;

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

      if (nameInput)        nameInput.value         = entry.name;
      if (levelInput)       levelInput.value        = entry.level;
      if (descTextarea)     descTextarea.value      = entry.description;
      if (spellsCheckbox)   spellsCheckbox.checked  = !!entry.includeSpells;
      if (casterTypeSelect) casterTypeSelect.value  = entry.casterType || 'none';
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

    const N8N_ORIGIN  = new URL(NPCBuilderApp.N8N_AUTH_URL).origin;
    const POLL_URL    = N8N_ORIGIN + '/webhook/oauth/patreon/poll';
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

      const authUrl = NPCBuilderApp.N8N_AUTH_URL
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
      // Both real 500s and CORS/network failures (which also manifest as "Failed to fetch"
      // when n8n's error responses lack CORS headers) count toward the give-up limit.
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
            // fetch() throws (instead of resolving with status 500) when the server's
            // error response is missing CORS headers — count these the same as server errors.
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

    if (this.selectedSystem === 'hero6e' || this.selectedSystem === 'home') {
      if (this.selectedSystem === 'hero6e')
        ui.notifications.warn('HERO 6e support is not yet available.');
      return;
    }

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
    this._runGeneration(historyEntry, key, name, level, description, includeSpells, casterType, this.selectedSystem);
  }

  /** Internal async worker for a single NPC generation. */
  async _runGeneration(historyEntry, key, name, level, description, includeSpells, casterType = 'none', system = 'pf2e') {
    try {
      let endpoint, payload;

      if (system === 'dnd5e') {
        endpoint = NPCBuilderApp.N8N_DND5E_URL;
        payload  = { name, cr: level, description, casterType };
        console.log('[NPC Builder] D&D 5e generation request:', { name, cr: level, casterType });
      } else {
        endpoint = NPCBuilderApp.N8N_NPC_URL;
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
        ui.notifications.error(message, { permanent: true });
        ui.notifications.warn(
          `You've used ${currentUsage}/${limit} NPCs this month. Opening Patreon to upgrade…`,
          { permanent: true }
        );
        setTimeout(() => window.open(NPCBuilderApp.PATREON_URL, '_blank'), 1200);

      } else if (response.ok) {
        if (data?.ok === false) throw new Error(data?.message || data?.error || 'Server rejected the request');

        const actorData = data.foundryNpc || data.npcDesign || data.actor || data;

        if (!actorData || typeof actorData !== 'object') throw new Error('No valid actor data returned from server');
        if (!actorData.name || !actorData.type) throw new Error(`Invalid actor data: missing ${!actorData.name ? 'name' : 'type'}`);

        console.log('[NPC Builder] Creating actor in Foundry...', actorData);
        if (system === 'dnd5e') {
          this._sanitizeActorDataDnd5e(actorData);
        } else {
          this._sanitizeActorData(actorData);
        }

        // For dnd5e, remove prototypeToken before Actor.create().
        // Foundry's Actor5e._preCreate constructs a proper PrototypeToken DataModel
        // instance internally. Passing any plain object — even a fully-formed one —
        // causes _preCreate to crash at actor.mjs:661 because it expects to operate
        // on an already-initialized document, not raw JSON. Omitting it lets Foundry
        // build it correctly from defaults, then we patch the name/img after creation.
        const dnd5eTokenName = actorData.name;
        const dnd5eTokenImg = actorData.img;
        if (system === 'dnd5e') {
          delete actorData.prototypeToken;
        }

        let actor, attempts = 0;
        const maxAttempts = 10;

        while (!actor && attempts < maxAttempts) {
          attempts++;
          try {
            actor = await Actor.create(actorData);
          } catch (error) {
            const errorText = error.toString ? error.toString() : String(error.message || error);
            if (system !== 'dnd5e' && this._tryFixValidationError(actorData, errorText)) {
              console.warn(`[NPC Builder] Fixed validation error, retrying (attempt ${attempts})...`);
              continue;
            }
            throw error;
          }
        }

        if (actor) {
          // Restore prototypeToken name and img now that the document exists properly
          if (system === 'dnd5e') {
            await actor.update({
              'prototypeToken.name': dnd5eTokenName,
              'prototypeToken.texture.src': dnd5eTokenImg || 'icons/svg/mystery-man.svg'
            });
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

  /* ── Sanitize actor data to fix common validation issues ──── */

  _sanitizeActorData(actorData) {
    const generateId = () => foundry.utils.randomID(16);

    if (!actorData._id || actorData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(actorData._id)) {
      console.warn('[NPC Builder] Fixing invalid actor _id:', actorData._id);
      actorData._id = generateId();
    }

    if (actorData._stats?.exportSource?.uuid) {
      actorData._stats.exportSource.uuid = `Actor.${actorData._id}`;
    }

    const invalidWeaponTraits = [
      'melee', 'ranged', 'skirmisher', 'concealed', 'stabbing', 'light',
      'piercing', 'slashing', 'bludgeoning', 'defense', 'mobility', 'curved', 'special',
    ];
    const invalidItemTypes = new Set(['loot', 'ranged']);

    if (Array.isArray(actorData.items)) {
      actorData.items = actorData.items.filter(item => {
        if (invalidItemTypes.has(item.type)) {
          console.warn(`[NPC Builder] Removing invalid item type "${item.type}":`, item.name);
          return false;
        }
        return true;
      });

      actorData.items = actorData.items.map(item => {
        if (item.type === 'feat') {
          console.warn('[NPC Builder] Converting feat to action:', item.name);
          const description   = item.system?.description?.value || '';
          const hasActionCost = item.system?.actions?.value !== null && item.system?.actions?.value !== undefined;
          const actionType    = hasActionCost ? 'action'    : 'passive';
          const category      = hasActionCost ? 'offensive' : 'defensive';

          const action = {
            ...item,
            type: 'action',
            system: {
              ...item.system,
              description: { value: description },
              category,
              actionType: { value: actionType },
              actions:    item.system?.actions || { value: null },
            },
          };

          if (action.system.prerequisites) delete action.system.prerequisites;
          if (action.system.level && typeof action.system.level === 'object') delete action.system.level;
          if (action.system.selfEffect) {
            console.warn('[NPC Builder] Removing selfEffect from converted feat:', item.name);
            delete action.system.selfEffect;
          }
          return action;
        }

        if (item.type === 'ranged') {
          console.warn('[NPC Builder] Converting invalid "ranged" to "weapon":', item.name);
          return { ...item, type: 'weapon' };
        }

        return item;
      });

      actorData.items.forEach(item => {
        if (!item._id || item._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(item._id)) {
          console.warn('[NPC Builder] Fixing invalid item _id:', item._id, 'for', item.name);
          item._id = generateId();
        }

        if ((item.type === 'melee' || item.type === 'weapon') && item.system?.traits?.value) {
          const orig = item.system.traits.value;
          item.system.traits.value = orig.filter(t => !invalidWeaponTraits.includes(t.toLowerCase()));
          if (item.system.traits.value.length !== orig.length)
            console.warn('[NPC Builder] Removed invalid traits from', item.name);
        }

        if (item.system?.traits?.value && Array.isArray(item.system.traits.value)) {
          const orig = item.system.traits.value;
          item.system.traits.value = orig.filter(t => t.toLowerCase() !== 'special');
          if (item.system.traits.value.length !== orig.length)
            console.warn('[NPC Builder] Removed "special" trait from', item.name);
        }
      });
    }

    console.log('[NPC Builder] Actor data sanitized successfully');
  }

  /* ── Sanitize D&D 5e actor data ──────────────────────────── */

  _sanitizeActorDataDnd5e(actorData) {
    const generateId = () => foundry.utils.randomID(16);

    if (!actorData._id || actorData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(actorData._id)) {
      console.warn('[NPC Builder] D&D 5e: Fixing invalid actor _id:', actorData._id);
      actorData._id = generateId();
    }

    // Ensure type is 'npc' for D&D 5e monsters/NPCs
    if (actorData.type !== 'npc') {
      console.warn('[NPC Builder] D&D 5e: Correcting actor type to "npc" (was:', actorData.type, ')');
      actorData.type = 'npc';
    }

    if (Array.isArray(actorData.items)) {
      actorData.items.forEach(item => {
        if (!item._id || item._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(item._id)) {
          console.warn('[NPC Builder] D&D 5e: Fixing invalid item _id:', item._id, 'for', item.name);
          item._id = generateId();
        }

        // Ensure description object exists
        if (!item.system) item.system = {};
        if (!item.system.description) item.system.description = { value: '', chat: '', unidentified: '' };
      });
    }

    if (!actorData.flags) actorData.flags = {};
    if (!actorData.img) actorData.img = 'icons/svg/mystery-man.svg';

    if (!actorData.prototypeToken) {
      actorData.prototypeToken = {
        name: actorData.name,
        actorLink: false,
        texture: { src: actorData.img || 'icons/svg/mystery-man.svg' },
        width: 1,
        height: 1,
        disposition: -1,
        displayBars: 40,
        bar1: { attribute: 'attributes.hp' },
        bar2: { attribute: null },
        sight: { enabled: false },
        detectionModes: []
      };
    }

    console.log('[NPC Builder] D&D 5e actor data sanitized:', actorData.name, '| items:', actorData.items?.length || 0);
  }

  /**
   * Try to fix a validation error by parsing the error message and modifying actorData.
   * Returns true if the error was fixed and a retry should be attempted.
   */
  _tryFixValidationError(actorData, errorMessage) {
    console.log('[NPC Builder] Attempting to fix validation error:', errorMessage);

    const invalidTraitMatch = errorMessage.match(/(\w+) is not a valid choice/);
    if (invalidTraitMatch) {
      const badTrait = invalidTraitMatch[1];
      let removed    = false;
      if (Array.isArray(actorData.items)) {
        actorData.items.forEach(item => {
          if (item.system?.traits?.value && Array.isArray(item.system.traits.value)) {
            const before = item.system.traits.value.length;
            item.system.traits.value = item.system.traits.value.filter(
              t => t.toLowerCase() !== badTrait.toLowerCase()
            );
            if (item.system.traits.value.length < before) removed = true;
          }
        });
      }
      return removed;
    }

    const invalidDocIdMatch = errorMessage.match(/Invalid document ID "([^"]+)"/);
    if (invalidDocIdMatch) {
      const invalidId = invalidDocIdMatch[1];
      let removed     = false;
      if (Array.isArray(actorData.items)) {
        actorData.items.forEach(item => {
          if (item.system?.selfEffect?.uuid?.includes(invalidId)) {
            delete item.system.selfEffect;
            removed = true;
          }
        });
      }
      return removed;
    }

    const invalidTypeMatch = errorMessage.match(/"(\w+)" is not a valid type/);
    if (invalidTypeMatch) {
      const invalidType = invalidTypeMatch[1];
      let fixed         = false;
      if (Array.isArray(actorData.items)) {
        if (invalidType === 'loot') {
          const before = actorData.items.length;
          actorData.items = actorData.items.filter(i => i.type !== 'loot');
          fixed = actorData.items.length < before;
        } else {
          actorData.items.forEach(item => {
            if (item.type === invalidType) { item.type = 'weapon'; fixed = true; }
          });
        }
      }
      return fixed;
    }

    return false;
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
    const modId          = game.modules?.get('Pf2eNpcMaker') ? 'Pf2eNpcMaker' : 'pf2e-npc-auto-builder';
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
  const exists = controls.some(c => c.action === 'pf2e-npc-builder');
  if (exists) return;
  controls.push({
    action:  'pf2e-npc-builder',
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

Hooks.once('ready', () => {
  const modId         = game.modules?.get('Pf2eNpcMaker') ? 'Pf2eNpcMaker' : 'pf2e-npc-auto-builder';
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
