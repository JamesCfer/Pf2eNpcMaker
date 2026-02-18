/*
 * PF2E NPC Auto-Builder — UNIFIED VERSION
 *
 * Features:
 * - Patreon OAuth authentication
 * - Tier-based rate limiting (monthly NPC limits)
 * - Spell ID mapping for proper spell linking
 * - Full error handling and validation
 * - Automatic retry on validation errors
 * - Sidebar buttons and header controls
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
 *
 * Rate Limiting:
 * - Free tier: 3 NPCs/month
 * - Local Adventurer: 15 NPCs/month
 * - Standard: 50 NPCs/month
 * - Champion: 80 NPCs/month
 */

class NPCBuilderApp extends FormApplication {
  /** n8n endpoints */
  static N8N_AUTH_URL = 'https://foundryrelay.dedicated2.com/webhook/oauth/patreon/login';
  static N8N_NPC_URL  = 'https://foundryrelay.dedicated2.com/webhook/npc-builder';
  static PATREON_URL  = 'https://www.patreon.com/c/CelestiaTools/membership';

  /** localStorage slots */
  static STORAGE_KEYS = ['pf2e-npc-builder.key', 'pf2e-npc-builder:key'];

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

  constructor(...args) {
    super(...args);
    this.accessKey = NPCBuilderApp.getStoredKey() || '';
    this.authenticated = !!this.accessKey;
    this.generating = false;
  }

  /** FormApplication: defaults */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'pf2e-npc-builder',
      classes: ['pf2e', 'npc-builder'],
      template: 'modules/pf2e-npc-auto-builder/templates/builder.html',
      title: 'PF2E NPC Builder',
      width: 520,
      height: 'auto',
      resizable: true
    });
  }

  /** Template data */
  getData() {
    return {
      roles: ['brute', 'skirmisher', 'soldier', 'sneak/striker', 'caster', 'support'],
      alignments: ['LG','NG','CG','LN','N','CN','LE','NE','CE'],
      traditions: ['arcane','divine','occult','primal'],
      castingOptions: ['none','prepared','spontaneous','innate'],
      authenticated: this.authenticated,
      generating: this.generating
    };
  }

  /** Wire up UI */
  activateListeners(html) {
    super.activateListeners(html);
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    root.querySelector('button.signin')?.addEventListener('click', (e) => this._signIn(e));
    root.querySelector('button.signout')?.addEventListener('click', (e) => this._signOut(e));
    root.querySelector('button.generate')?.addEventListener('click', (e) => this._generateNPC(e));
    root.querySelector('button.export')?.addEventListener('click', (e) => this._exportJSON(e));

    // initial button state
    this._applyAuthStateUI();
  }

  /** Enable/disable buttons based on auth state */
  _applyAuthStateUI() {
    const root = this.element?.[0];
    if (!root) return;
    const enable = !!this.authenticated && !this.generating;

    const gen  = root.querySelector('button.generate');
    const exp  = root.querySelector('button.export');
    if (gen)  gen.disabled  = !enable;
    if (exp)  exp.disabled  = !enable;

    const signin = root.querySelector('button.signin');
    const signout = root.querySelector('button.signout');
    if (signin) {
      signin.disabled = this.authenticated;
      signin.textContent = this.authenticated ? 'Signed in (Patreon)' : 'Sign in with Patreon';
    }
    if (signout) {
      signout.disabled = !this.authenticated;
    }

    // Update generate button text
    if (gen) {
      gen.textContent = this.generating ? 'Generating...' : 'Generate NPC';
    }
  }

  /** Open popup to start OAuth; wait for postMessage({ type:'patreon-auth', ok, key }) */
  async _signIn(event) {
    event?.preventDefault?.();

    const N8N_ORIGIN = new URL(NPCBuilderApp.N8N_AUTH_URL).origin;
    console.log('[NPC Builder] waiting for message from', N8N_ORIGIN);

    try {
      const authUrl = NPCBuilderApp.N8N_AUTH_URL + '?origin=' + encodeURIComponent(window.location.origin);

      // open centered popup
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
        console.log('[NPC Builder] postMessage received: ', {
          origin: ev.origin,
          data: ev.data,
          sameSource: ev.source === win
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
          this.accessKey = String(data.key);
          NPCBuilderApp.setStoredKey(this.accessKey);
          this.authenticated = true;
          this._applyAuthStateUI();
          ui.notifications?.info?.('Patreon sign-in complete.');
        } else {
          ui.notifications?.error?.(data?.error || 'Patreon sign-in failed.');
        }
      };

      window.addEventListener('message', handler);
      ui.notifications?.info?.('Opening Patreon sign-in…');

    } catch (err) {
      console.error('[NPC Builder] sign-in error', err);
      ui.notifications?.error?.('Failed to start Patreon sign-in.');
    }
  }

  /** Local sign-out only (server still validates every request) */
  async _signOut(event) {
    event?.preventDefault?.();
    NPCBuilderApp.setStoredKey('');
    this.accessKey = '';
    this.authenticated = false;
    this._applyAuthStateUI();
    ui.notifications?.info?.('Signed out.');
  }

  /** ============================================
   *  BUILD SPELL MAPPING FROM FOUNDRY COMPENDIUM
   *  ============================================ */
  async _buildSpellMapping() {
    console.log("[NPC Builder] Building spell mapping...");
    
    const spellMapping = [];
    
    // Get all spell compendiums
    const spellPacks = game.packs.filter(pack => 
      pack.documentName === "Item" && 
      pack.metadata.type === "Item" &&
      (pack.metadata.id?.includes("spell") || pack.metadata.label?.toLowerCase().includes("spell"))
    );
    
    console.log(`[NPC Builder] Found ${spellPacks.length} spell packs`);
    
    for (const pack of spellPacks) {
      console.log(`[NPC Builder] Processing pack: ${pack.metadata.label}`);
      
      const index = await pack.getIndex({ fields: ["name", "system.level.value", "type"] });
      
      for (const entry of index) {
        if (entry.type === "spell") {
          spellMapping.push({
            name: entry.name,
            id: entry._id,
            packId: pack.collection,
            level: entry.system?.level?.value ?? 0
          });
        }
      }
    }
    
    console.log(`[NPC Builder] Mapped ${spellMapping.length} spells`);
    return spellMapping;
  }

  /** Collect builder values and ask n8n to create the NPC */
  async _generateNPC(event) {
    event?.preventDefault?.();
    if (!this.authenticated) {
      ui.notifications.warn('Please sign in with Patreon before generating an NPC.');
      return;
    }

    if (this.generating) {
      ui.notifications.warn('NPC generation already in progress...');
      return;
    }

    const form = this.element?.[0]?.querySelector?.('form');
    if (!form) {
      ui.notifications.error('Builder form not found.');
      return;
    }

    const fd = new FormData(form);
    const name = (fd.get('name')?.toString()?.trim()) || 'Generated NPC';
    const level = Number(fd.get('level')) || 1;
    const description = (fd.get('description')?.toString()?.trim()) || '';
    const includeSpells = fd.get('includeSpells') === 'on';

    if (!description) {
      ui.notifications.warn('Please provide a description for the NPC.');
      return;
    }

    // Set generating state
    this.generating = true;
    this._applyAuthStateUI();

    // Show progress notification
    const progressNotif = ui.notifications?.info?.(
      'Generating NPC... This may take 30-60 seconds.',
      { permanent: true }
    );

    const key = this.accessKey || NPCBuilderApp.getStoredKey() || '';
    if (!key) {
      this.generating = false;
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    try {
      // Build request payload
      const payload = {
        name,
        level,
        description
      };

      // ✅ BUILD SPELL MAPPING IF REQUESTED
      if (includeSpells) {
        ui.notifications.info('Building spell mapping... (this may take 5-10 seconds)');
        const spellMapping = await this._buildSpellMapping();
        payload.spellMapping = spellMapping;
        console.log(`[NPC Builder] Added ${spellMapping.length} spells to payload`);
      }

      console.log('[NPC Builder] Sending generation request to n8n...', { 
        name, 
        level, 
        hasSpellMapping: !!payload.spellMapping,
        spellCount: payload.spellMapping?.length || 0
      });

      const response = await fetch(NPCBuilderApp.N8N_NPC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Builder-Key': key,
          'X-Foundry-Origin': window.location.origin
        },
        body: JSON.stringify(payload)
      });

      // Clear progress notification
      if (progressNotif) progressNotif.remove();

      // Get the raw response text first for debugging
      const responseText = await response.text();
      console.log('[NPC Builder] Raw response length:', responseText.length, 'bytes');

      let data;
      try {
        data = JSON.parse(responseText);

        // n8n's "Respond to Webhook" node wraps output in an array by default.
        // Unwrap it so downstream code can access named keys like foundryNpc.
        if (Array.isArray(data)) {
          console.warn('[NPC Builder] Response was an array — unwrapping first element (n8n default wrapping)');
          data = data[0] ?? {};
        }

        console.log('[NPC Builder] Response from n8n:', { status: response.status, data });
      } catch (err) {
        console.error('[NPC Builder] Failed to parse JSON response:', err);
        console.error('[NPC Builder] Response text preview (first 500 chars):', responseText.substring(0, 500));
        console.error('[NPC Builder] Response text preview (last 500 chars):', responseText.substring(Math.max(0, responseText.length - 500)));

        // Try to extract the foundryNpc from the truncated response if possible
        const foundryNpcMatch = responseText.match(/"foundryNpc"\s*:\s*({[\s\S]*)/);
        if (foundryNpcMatch) {
          console.warn('[NPC Builder] Found foundryNpc in truncated response, attempting to extract...');
          try {
            // Try to find where the foundryNpc object ends by counting braces
            let depth = 0;
            let inString = false;
            let escape = false;
            const npcJson = foundryNpcMatch[1];

            for (let i = 0; i < npcJson.length; i++) {
              const char = npcJson[i];

              if (escape) {
                escape = false;
                continue;
              }

              if (char === '\\') {
                escape = true;
                continue;
              }

              if (char === '"') {
                inString = !inString;
                continue;
              }

              if (!inString) {
                if (char === '{') depth++;
                if (char === '}') {
                  depth--;
                  if (depth === 0) {
                    const extracted = npcJson.substring(0, i + 1);
                    console.log('[NPC Builder] Extracted foundryNpc (length:', extracted.length, ')');
                    data = { ok: true, foundryNpc: JSON.parse(extracted) };
                    break;
                  }
                }
              }
            }
          } catch (extractErr) {
            console.error('[NPC Builder] Failed to extract foundryNpc:', extractErr);
          }
        }

        if (!data) {
          throw new Error(`Invalid JSON response from server (response truncated at ${responseText.length} bytes): ${err.message}`);
        }
      }

      if (response.status === 401 || response.status === 403) {
        // Invalidate local key so UI prompts sign-in again
        NPCBuilderApp.setStoredKey('');
        this.accessKey = '';
        this.authenticated = false;
        this._applyAuthStateUI();
        
        const message = data?.message || 'Unauthorized. Please sign in with Patreon.';
        ui.notifications.error(message, { permanent: true });
        
        // Show Patreon link
        ui.notifications.info(
          `<a href="${NPCBuilderApp.PATREON_URL}" target="_blank" style="color: #ff424d; text-decoration: underline;">Join our Patreon</a> to access the NPC Builder.`,
          { permanent: true }
        );
      } else if (response.status === 429 || data?.error === 'RATE_LIMIT_EXCEEDED') {
        // Rate limit exceeded - don't invalidate session
        const message = data?.message || 'Monthly NPC limit reached.';
        const tier = data?.tier || 'free';
        const currentUsage = data?.currentUsage || 0;
        const limit = data?.limit || 0;
        
        console.log('[NPC Builder] Rate limit hit:', { tier, currentUsage, limit });
        
        ui.notifications.error(message, { permanent: true });
        
        // Show upgrade link with usage info
        ui.notifications.info(
          `You've created ${currentUsage}/${limit} NPCs this month. <a href="${NPCBuilderApp.PATREON_URL}" target="_blank" style="color: #ff424d; text-decoration: underline;">Upgrade your tier</a> for more NPCs.`,
          { permanent: true }
        );
      } else if (response.ok) {
        // Check if the response has the expected 'ok' flag
        if (data?.ok === false) {
          console.error('[NPC Builder] Server rejected request:', data);
          throw new Error(data?.message || data?.error || 'Server rejected the request');
        }

        // n8n returns the full foundryNpc actor data
        // Try multiple possible data structures
        const actorData = data.foundryNpc || data.npcDesign || data.actor || data;

        // Check if actorData looks like valid actor data (has required fields)
        if (!actorData || typeof actorData !== 'object') {
          console.error('[NPC Builder] Invalid actor data structure:', actorData);
          throw new Error('No valid actor data returned from server');
        }

        if (!actorData.name || !actorData.type) {
          console.error('[NPC Builder] Missing required fields in actor data:', {
            hasName: !!actorData.name,
            hasType: !!actorData.type,
            name: actorData.name,
            type: actorData.type
          });
          throw new Error(`Invalid actor data: missing ${!actorData.name ? 'name' : 'type'}`);
        }

        // Guard against a blank NPC: system must exist and have at least one key.
        // n8n returning {name, type, system: {}} would otherwise silently create an empty sheet.
        const systemKeys = actorData.system ? Object.keys(actorData.system) : [];
        if (systemKeys.length === 0) {
          console.error('[NPC Builder] foundryNpc.system is missing or empty — n8n returned a blank NPC skeleton:', actorData);
          throw new Error(
            'The server returned an NPC with no stat data (blank system object). ' +
            'This usually means the AI generation step failed or timed out inside the n8n workflow. ' +
            'Please try again; if the problem persists, check the n8n workflow logs.'
          );
        }

        console.log('[NPC Builder] Creating actor in Foundry...', {
          name: actorData.name,
          type: actorData.type,
          systemKeys,
          itemCount: actorData.items?.length ?? 0
        });

        // Sanitize the actor data before creating
        this._sanitizeActorData(actorData);

        // Create the actor in Foundry with automatic retry on validation errors
        let actor;
        let attempts = 0;
        const maxAttempts = 10; // Prevent infinite loops

        while (!actor && attempts < maxAttempts) {
          attempts++;
          try {
            actor = await Actor.create(actorData);
          } catch (error) {
            // Get full error text (validation errors are in toString())
            const errorText = error.toString ? error.toString() : String(error.message || error);

            // Check if it's a validation error about invalid traits or other fixable issues
            if (this._tryFixValidationError(actorData, errorText)) {
              console.warn(`[NPC Builder] Fixed validation error, retrying (attempt ${attempts})...`);
              continue; // Retry with fixed data
            }
            // Not a fixable validation error, rethrow
            throw error;
          }
        }

        if (actor) {
          this.lastGeneratedNPC = actorData; // Store for export
          ui.notifications.success(`NPC "${actor.name}" created successfully!`);
          actor.sheet.render(true);
        } else {
          throw new Error('Failed to create actor in Foundry after maximum retry attempts');
        }

      } else {
        console.error('[NPC Builder] Server error:', { status: response.status, data });
        throw new Error(data?.message || `Server returned status ${response.status}`);
      }

    } catch (err) {
      console.error('[NPC Builder] NPC generation error', err);
      ui.notifications.error(`Failed to generate NPC: ${err.message}`);
    } finally {
      this.generating = false;
      this._applyAuthStateUI();
    }
  }

  /** Sanitize actor data to fix common validation issues */
  _sanitizeActorData(actorData) {
    // Helper to generate valid 16-character Foundry IDs
    const generateId = () => foundry.utils.randomID(16);

    // Fix main actor ID if invalid
    if (!actorData._id || actorData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(actorData._id)) {
      console.warn('[NPC Builder] Fixing invalid actor _id:', actorData._id);
      actorData._id = generateId();
    }

    // Fix exportSource UUID if it references invalid ID
    if (actorData._stats?.exportSource?.uuid) {
      actorData._stats.exportSource.uuid = `Actor.${actorData._id}`;
    }

    // Invalid trait values that should be removed from weapon strikes
    const invalidWeaponTraits = [
      'melee', 'ranged', // weapon types, not traits
      'skirmisher', 'concealed', 'stabbing', 'light', // invalid for PF2e weapons
      'piercing', 'slashing', 'bludgeoning', // damage types, not traits
      'defense', 'mobility', 'curved', // generic descriptors, not valid traits
      'special' // "special" is never a valid trait in PF2e
    ];
    
    // Invalid item types for NPCs
    const invalidItemTypes = new Set(['loot', 'ranged']);

    // Process items
    if (Array.isArray(actorData.items)) {
      // CRITICAL: Filter out invalid item types FIRST
      actorData.items = actorData.items.filter(item => {
        if (invalidItemTypes.has(item.type)) {
          console.warn(`[NPC Builder] Removing invalid item type "${item.type}":`, item.name);
          return false;
        }
        return true;
      });
      
      // CRITICAL: Convert feat items to action items - NPCs cannot have feats in PF2e!
      actorData.items = actorData.items.map(item => {
        if (item.type === 'feat') {
          console.warn('[NPC Builder] Converting feat to action:', item.name);

          // ✅ CRITICAL FIX: Preserve the description!
          const description = item.system?.description?.value || '';

          // Determine if this should be active or passive based on action cost
          const hasActionCost = item.system?.actions?.value !== null &&
                               item.system?.actions?.value !== undefined;

          const actionType = hasActionCost ? 'action' : 'passive';
          const category = hasActionCost ? 'offensive' : 'defensive';

          console.log(`[NPC Builder] Converting "${item.name}" to ${actionType}`, {
            hasDescription: !!description,
            descriptionLength: description?.length || 0,
            actionCost: item.system?.actions?.value
          });

          // Convert feat to action
          const action = {
            ...item,
            type: 'action',
            system: {
              ...item.system,
              // ✅ PRESERVE THE DESCRIPTION
              description: {
                value: description
              },
              category: category,
              actionType: { value: actionType },
              actions: item.system?.actions || { value: null }
            }
          };

          // Remove feat-specific fields that don't apply to actions
          if (action.system.prerequisites) delete action.system.prerequisites;
          if (action.system.level && typeof action.system.level === 'object') {
            delete action.system.level;
          }

          // Remove selfEffect references (feat stances create invalid UUIDs for NPCs)
          if (action.system.selfEffect) {
            console.warn('[NPC Builder] Removing selfEffect from converted feat:', item.name);
            delete action.system.selfEffect;
          }

          return action;
        }

        // Convert "ranged" item type to "weapon" (ranged is not a valid item type in PF2e)
        if (item.type === 'ranged') {
          console.warn('[NPC Builder] Converting invalid item type "ranged" to "weapon":', item.name);
          return {
            ...item,
            type: 'weapon'
          };
        }

        return item;
      });

      actorData.items.forEach(item => {
        // Fix item IDs
        if (!item._id || item._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(item._id)) {
          console.warn('[NPC Builder] Fixing invalid item _id:', item._id, 'for', item.name);
          item._id = generateId();
        }

        // Fix weapon strike traits (type: 'melee')
        if (item.type === 'melee' && item.system?.traits?.value) {
          const originalTraits = item.system.traits.value;
          item.system.traits.value = originalTraits.filter(trait =>
            !invalidWeaponTraits.includes(trait.toLowerCase())
          );

          if (item.system.traits.value.length !== originalTraits.length) {
            console.warn('[NPC Builder] Removed invalid traits from', item.name, ':',
              originalTraits.filter(t => !item.system.traits.value.includes(t))
            );
          }
        }

        // Fix weapon items
        if (item.type === 'weapon' && item.system?.traits?.value) {
          const originalTraits = item.system.traits.value;
          item.system.traits.value = originalTraits.filter(trait =>
            !invalidWeaponTraits.includes(trait.toLowerCase())
          );

          if (item.system.traits.value.length !== originalTraits.length) {
            console.warn('[NPC Builder] Removed invalid traits from weapon', item.name);
          }
        }
        
        // Filter "special" and other invalid traits from ALL items with traits
        if (item.system?.traits?.value && Array.isArray(item.system.traits.value)) {
          const originalTraits = item.system.traits.value;
          item.system.traits.value = originalTraits.filter(trait =>
            trait.toLowerCase() !== 'special'
          );
          
          if (item.system.traits.value.length !== originalTraits.length) {
            console.warn('[NPC Builder] Removed "special" trait from', item.name);
          }
        }
      });
    }

    console.log('[NPC Builder] Actor data sanitized successfully');
  }

  /**
   * Try to fix a validation error by parsing the error message and modifying actorData
   * Returns true if the error was fixed and a retry should be attempted
   * @param {Object} actorData - The actor data to modify
   * @param {string} errorMessage - The validation error message from Foundry
   * @returns {boolean} - True if the error was fixed
   */
  _tryFixValidationError(actorData, errorMessage) {
    console.log('[NPC Builder] Attempting to fix validation error:', errorMessage);

    // Pattern: "curved is not a valid choice"
    const invalidTraitMatch = errorMessage.match(/(\w+) is not a valid choice/);
    if (invalidTraitMatch) {
      const invalidTrait = invalidTraitMatch[1];
      console.warn(`[NPC Builder] Removing invalid trait "${invalidTrait}" from all items`);

      let removed = false;
      if (Array.isArray(actorData.items)) {
        actorData.items.forEach(item => {
          if (item.system?.traits?.value && Array.isArray(item.system.traits.value)) {
            const before = item.system.traits.value.length;
            item.system.traits.value = item.system.traits.value.filter(
              trait => trait.toLowerCase() !== invalidTrait.toLowerCase()
            );
            if (item.system.traits.value.length < before) {
              console.warn(`[NPC Builder] Removed "${invalidTrait}" from ${item.name}`);
              removed = true;
            }
          }
        });
      }
      return removed;
    }

    // Pattern: "Invalid document ID "Some ID String""
    const invalidDocIdMatch = errorMessage.match(/Invalid document ID "([^"]+)"/);
    if (invalidDocIdMatch) {
      const invalidId = invalidDocIdMatch[1];
      console.warn(`[NPC Builder] Removing invalid document reference: "${invalidId}"`);

      // Remove selfEffect references with this ID
      let removed = false;
      if (Array.isArray(actorData.items)) {
        actorData.items.forEach(item => {
          if (item.system?.selfEffect?.uuid && item.system.selfEffect.uuid.includes(invalidId)) {
            console.warn(`[NPC Builder] Removing selfEffect with invalid ID from ${item.name}`);
            delete item.system.selfEffect;
            removed = true;
          }
        });
      }
      return removed;
    }

    // Pattern: "ranged" or "loot" is not a valid type
    const invalidTypeMatch = errorMessage.match(/"(\w+)" is not a valid type/);
    if (invalidTypeMatch) {
      const invalidType = invalidTypeMatch[1];
      console.warn(`[NPC Builder] Handling invalid item type "${invalidType}"`);

      let fixed = false;
      if (Array.isArray(actorData.items)) {
        // Filter out "loot" entirely, convert "ranged" to "weapon"
        if (invalidType === 'loot') {
          const beforeCount = actorData.items.length;
          actorData.items = actorData.items.filter(item => {
            if (item.type === 'loot') {
              console.warn(`[NPC Builder] Removing loot item: ${item.name}`);
              return false;
            }
            return true;
          });
          fixed = actorData.items.length < beforeCount;
        } else {
          actorData.items.forEach(item => {
            if (item.type === invalidType) {
              console.warn(`[NPC Builder] Converting ${item.name} from type "${invalidType}" to "weapon"`);
              item.type = 'weapon';
              fixed = true;
            }
          });
        }
      }
      return fixed;
    }

    // Couldn't fix this error
    return false;
  }

  /** Export generated NPC as JSON file */
  async _exportJSON(event) {
    event?.preventDefault?.();

    if (!this.lastGeneratedNPC) {
      ui.notifications.warn('No NPC has been generated yet.');
      return;
    }

    const json = JSON.stringify(this.lastGeneratedNPC, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.lastGeneratedNPC.name || 'npc'}.json`;
    a.click();
    URL.revokeObjectURL(url);

    ui.notifications.info('NPC exported to JSON file.');
  }
}

/* -----------------------------------------------------------------------------
   Header controls + sidebar injection
----------------------------------------------------------------------------- */

function registerNPCBuilderControl(app, controls) {
  if (!game.user?.isGM) return;
  const exists = controls.some(c => c.name === 'pf2e-npc-builder');
  if (exists) return;
  controls.push({
    action: 'pf2e-npc-builder',
    icon: 'fa-solid fa-robot',
    label: 'NPC Builder',
    onClick: () => { new NPCBuilderApp().render(true); },
    visible: true
  });
}

function injectSidebarButton(app, html) {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  if (root.querySelector('.npc-builder-button')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('npc-builder-button');
  button.style.marginLeft = '4px';
  button.innerHTML = '<i class="fa-solid fa-robot"></i> NPC Builder';
  button.addEventListener('click', () => new NPCBuilderApp().render(true));

  const header = root.querySelector('header') || root.querySelector('.directory-header');
  if (header) header.appendChild(button); else root.prepend(button);
}

// Support common hook names across versions
Hooks.on('getHeaderControlsActorDirectory', registerNPCBuilderControl);
Hooks.on('getHeaderControlsCompendiumDirectory', registerNPCBuilderControl);
Hooks.on('getHeaderControlsActorDirectoryPF2e', registerNPCBuilderControl);
Hooks.on('getHeaderControlsCompendiumDirectoryPF2e', registerNPCBuilderControl);
Hooks.on('getHeaderControlsApplicationV2', (app, controls) => {
  try {
    const name = app?.constructor?.name;
    if (name === 'ActorDirectory' || name === 'CompendiumDirectory'
      || name === 'ActorDirectoryPF2e' || name === 'CompendiumDirectoryPF2e') {
      registerNPCBuilderControl(app, controls);
    }
  } catch (err) {
    console.warn('PF2E NPC Builder: generic header control hook failed', err);
  }
});

// Sidebar fallbacks
Hooks.on('renderActorDirectory', injectSidebarButton);
Hooks.on('renderCompendiumDirectory', injectSidebarButton);
Hooks.on('renderActorDirectoryPF2e', injectSidebarButton);
Hooks.on('renderCompendiumDirectoryPF2e', injectSidebarButton);

// Log init
Hooks.once('ready', () => {
  console.log('PF2E NPC Auto-Builder (n8n edition with spell mapping and rate limiting) initialised.');
});