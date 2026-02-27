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
  static N8N_AUTH_URL = 'https://foundryrelay.dedicated2.com/webhook/oauth/patreon/login';
  static N8N_NPC_URL  = 'https://foundryrelay.dedicated2.com/webhook/npc-builder';
  static PATREON_URL  = 'https://www.patreon.com/cw/CelestiaTools';

  /** localStorage slots */
  static STORAGE_KEYS = ['pf2e-npc-builder.key', 'pf2e-npc-builder:key'];

  /** localStorage slot for NPC history */
  static HISTORY_KEY = 'pf2e-npc-builder.history';

  /** Max history entries to retain */
  static MAX_HISTORY = 50;

  static DEFAULT_OPTIONS = {
    id: 'pf2e-npc-builder',
    classes: ['pf2e', 'npc-builder'],
    window: {
      title: 'PF2E NPC Builder',
      resizable: true,
    },
    position: {
      width: 800,
    },
    actions: {
      signin:   function(event) { this._signIn(event); },
      signout:  function(event) { this._signOut(event); },
      generate: function(event) { this._generateNPC(event); },
      export:   function(event) { this._exportJSON(event); },
      patreon:  function()      { window.open(this.constructor.PATREON_URL, '_blank'); },
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
    this._applyAuthStateUI();
    this._renderHistory();
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

    el.innerHTML = `
      <div class="history-entry-main">
        <div class="history-entry-info">
          <span class="history-entry-name">${escapedName}</span>
          <span class="history-entry-meta">Lv.&nbsp;${entry.level}</span>
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

    // Populate the form with the saved prompt values
    const form = this.element?.querySelector('.npc-form');
    if (form) {
      const nameInput      = form.querySelector('[name="name"]');
      const levelInput     = form.querySelector('[name="level"]');
      const descTextarea   = form.querySelector('[name="description"]');
      const spellsCheckbox = form.querySelector('[name="includeSpells"]');

      if (nameInput)      nameInput.value          = entry.name;
      if (levelInput)     levelInput.value          = entry.level;
      if (descTextarea)   descTextarea.value        = entry.description;
      if (spellsCheckbox) spellsCheckbox.checked    = !!entry.includeSpells;
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

  /* ── Sign-in (Patreon OAuth popup) ───────────────────────── */

  async _signIn(event) {
    event?.preventDefault?.();

    const N8N_ORIGIN = new URL(NPCBuilderApp.N8N_AUTH_URL).origin;
    console.log('[NPC Builder] waiting for message from', N8N_ORIGIN);

    try {
      const authUrl = NPCBuilderApp.N8N_AUTH_URL + '?origin=' + encodeURIComponent(window.location.origin);

      const w = 520, h = 720;
      const Y = (window.top?.outerHeight || window.outerHeight);
      const X = (window.top?.outerWidth  || window.outerWidth);
      const y = (Y / 2) + (window.top?.screenY || window.screenY) - (h / 2);
      const x = (X / 2) + (window.top?.screenX || window.screenX) - (w / 2);

      const win = window.open(
        authUrl,
        'patreon-login',
        `toolbar=0,location=1,status=0,menubar=0,scrollbars=1,resizable=1,width=${w},height=${h},left=${x},top=${y}`
      );

      const handler = (ev) => {
        console.log('[NPC Builder] postMessage received:', {
          origin:     ev.origin,
          data:       ev.data,
          sameSource: ev.source === win,
        });

        const okOrigins = new Set([N8N_ORIGIN, window.location.origin, 'null']);
        const fromPopup = ev.source === win;
        if (!fromPopup && !okOrigins.has(ev.origin)) return;

        let data = ev.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { /* ignore parse error */ }
        }
        console.log('[NPC Builder] parsed patreon-auth message:', data);
        if (!data || data.type !== 'patreon-auth') return;

        window.removeEventListener('message', handler);
        try { win?.close?.(); } catch {}

        if (data.ok && data.key && String(data.key).length >= 32) {
          this.accessKey     = String(data.key);
          NPCBuilderApp.setStoredKey(this.accessKey);
          this.authenticated = true;
          this._applyAuthStateUI();
          ui.notifications?.info?.('Patreon sign-in complete.');
        } else {
          const errMsg = data?.error || 'Patreon membership required to use the NPC Builder.';
          ui.notifications?.error?.(errMsg, { permanent: true });
          setTimeout(() => window.open(NPCBuilderApp.PATREON_URL, '_blank'), 800);
        }
      };

      window.addEventListener('message', handler);
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
    this._runGeneration(historyEntry, key, name, level, description, includeSpells);
  }

  /** Internal async worker for a single NPC generation. */
  async _runGeneration(historyEntry, key, name, level, description, includeSpells) {
    try {
      const payload = { name, level, description };

      if (includeSpells) {
        ui.notifications.info('Building spell mapping… (this may take 5–10 seconds)');
        payload.spellMapping = await this._buildSpellMapping();
        console.log(`[NPC Builder] Added ${payload.spellMapping.length} spells to payload`);
      }

      console.log('[NPC Builder] Sending generation request to n8n...', {
        name,
        level,
        hasSpellMapping: !!payload.spellMapping,
        spellCount:      payload.spellMapping?.length || 0,
      });

      const response = await fetch(NPCBuilderApp.N8N_NPC_URL, {
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
        this._sanitizeActorData(actorData);

        let actor, attempts = 0;
        const maxAttempts = 10;

        while (!actor && attempts < maxAttempts) {
          attempts++;
          try {
            actor = await Actor.create(actorData);
          } catch (error) {
            const errorText = error.toString ? error.toString() : String(error.message || error);
            if (this._tryFixValidationError(actorData, errorText)) {
              console.warn(`[NPC Builder] Fixed validation error, retrying (attempt ${attempts})...`);
              continue;
            }
            throw error;
          }
        }

        if (actor) {
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
    return;
  }
  _npcBuilderApp = null;
  _npcBuilderApp = new NPCBuilderApp();
  _npcBuilderApp.render({ force: true }).catch(err => {
    console.error('[NPC Builder] Failed to open:', err);
    ui.notifications?.error?.('NPC Builder failed to open. Check the console (F12) for details.');
    _npcBuilderApp = null;
  });
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
  const modId = game.modules?.get('Pf2eNpcMaker') ? 'Pf2eNpcMaker' : 'pf2e-npc-auto-builder';
  (foundry.applications.handlebars?.loadTemplates ?? loadTemplates)([`modules/${modId}/templates/builder.html`]);
  console.log(`PF2E NPC Auto-Builder ready (module folder: ${modId}).`);
});
