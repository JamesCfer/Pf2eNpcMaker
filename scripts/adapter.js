/**
 * PF2e NPC SystemAdapter — implements the BuilderApp contract for Pathfinder 2e NPCs.
 */

import { SystemAdapter, postToN8n } from './core/adapter.js';
import { N8N_BASE, devUrl,
         isDevMode }                 from './core/n8n.js';
import { detectModuleFolder,
         escapeHtml }                from './core/utils.js';
import { enrichSpellsFromCompendium,
         sanitizeActorDataPf2e,
         tryFixValidationError }     from './sanitizer.js';

const MODULE_FOLDER = detectModuleFolder('Pf2eNpcMaker');
const NPC_ENDPOINT  = `${N8N_BASE}/webhook/npc-builder`;
const LEVELUP_URL   = `${N8N_BASE}/webhook/npc-levelup`;

export class Pf2eNpcAdapter extends SystemAdapter {
  get moduleFolder() { return MODULE_FOLDER; }

  get module() {
    return {
      id:           'Pf2eNpcMaker',
      label:        'Pathfinder 2e',
      icon:         'fa-solid fa-dragon',
      githubUrl:    'https://github.com/JamesCfer/Pf2eNpcMaker',
      historyLabel: 'Created NPCs',
    };
  }

  get systemId() { return 'pf2e'; }

  get supportsImageGeneration() { return true; }

  get formConfig() { return { documentNoun: 'NPC' }; }

  /* ── Form handling ──────────────────────────────────────── */

  gatherFormData(form) {
    const fd = new FormData(form);
    const name          = (fd.get('name')?.toString()?.trim()) || 'Generated NPC';
    const level         = Number(fd.get('level')) || 1;
    const description   = (fd.get('description')?.toString()?.trim()) || '';
    const includeSpells = fd.get('includeSpells') === 'on';

    if (!description) throw new Error('Please provide a description for the NPC.');
    return { name, level, description, includeSpells };
  }

  historyEntryFromForm(formData) {
    return {
      name:          formData.name,
      level:         formData.level,
      description:   formData.description,
      includeSpells: formData.includeSpells,
    };
  }

  historyMeta(entry) { return `Lv.&nbsp;${entry.level}`; }

  populateForm(form, entry) {
    const nameInput      = form.querySelector('[name="name"]');
    const levelInput     = form.querySelector('[name="level"]');
    const descTextarea   = form.querySelector('[name="description"]');
    const spellsCheckbox = form.querySelector('[name="includeSpells"]');
    if (nameInput)      nameInput.value        = entry.name ?? '';
    if (levelInput)     levelInput.value       = entry.level ?? 1;
    if (descTextarea)   descTextarea.value     = entry.description ?? '';
    if (spellsCheckbox) spellsCheckbox.checked = !!entry.includeSpells;
  }

  /* ── Generation ─────────────────────────────────────────── */

  async generate({ formData, key, devMode, builderApp }) {
    const endpoint = devUrl(NPC_ENDPOINT, devMode);
    const payload  = {
      name:        formData.name,
      level:       formData.level,
      description: formData.description,
    };

    if (formData.includeSpells) {
      ui.notifications.info('Building spell mapping… (this may take 5–10 seconds)');
      payload.spellMapping = await this._buildSpellMapping();
    }

    const { response, responseText } = await postToN8n(endpoint, payload, key);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Invalid JSON response (${responseText.length} bytes): ${err.message}`);
    }

    if (!response.ok) throw new Error(data?.message || `Server returned status ${response.status}`);
    if (data?.ok === false) throw new Error(data?.message || data?.error || 'Server rejected the request');

    const actorData = data.foundryNpc || data.npcDesign || data.actor || data;
    if (!actorData || typeof actorData !== 'object') throw new Error('No valid actor data returned from server');
    if (!actorData.name || !actorData.type) {
      throw new Error(`Invalid actor data: missing ${!actorData.name ? 'name' : 'type'}`);
    }

    await enrichSpellsFromCompendium(actorData);
    sanitizeActorDataPf2e(actorData);

    let actor, attempts = 0;
    const maxAttempts = 10;
    while (!actor && attempts < maxAttempts) {
      attempts++;
      try {
        actor = await Actor.create(actorData);
      } catch (error) {
        const errorText = error.toString ? error.toString() : String(error.message || error);
        if (tryFixValidationError(actorData, errorText)) continue;
        throw error;
      }
    }
    if (!actor) throw new Error('Failed to create actor after maximum retry attempts');

    return {
      document:   actor,
      exportData: {
        content:  JSON.stringify(actorData, null, 2),
        filename: `${actor.name || 'npc'}.json`,
        mimeType: 'application/json',
      },
      message: `NPC "${actor.name}" created successfully!`,
    };
  }

  async _buildSpellMapping() {
    const spellMapping = [];
    const spellPacks   = game.packs.filter(pack =>
      pack.documentName === 'Item' &&
      pack.metadata.type === 'Item' &&
      (pack.metadata.id?.includes('spell') || pack.metadata.label?.toLowerCase().includes('spell'))
    );

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
    return spellMapping;
  }

  /* ── Level Up (PF2e-specific) ───────────────────────────── */

  async levelUpNpc(actor, builderApp) {
    if (!builderApp.authenticated) {
      ui.notifications.warn('Please sign in with Patreon to use Level Up.');
      return;
    }

    const currentLevel = actor.system?.details?.level?.value ?? actor.system?.details?.level ?? 0;

    const result = await new Promise(resolve => {
      const DialogV2 = foundry.applications?.api?.DialogV2;
      const content  = `
        <div style="display:flex;flex-direction:column;gap:0.7em;padding:0.25em 0;">
          <p style="margin:0;">
            Level up (or down) <strong>${escapeHtml(actor.name)}</strong>
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
          </div>
          <p style="margin:0;font-size:0.85em;color:#666;">
            The NPC will be re-processed through the builder at the selected level.
            This costs <strong>1 NPC use</strong>.
          </p>
        </div>`;

      const extract = (container) => {
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
        }).then(() => resolve(extract(document))).catch(() => resolve(null));
      } else {
        new Dialog({
          title:   'Level Up NPC',
          content,
          buttons: {
            confirm: { label: '<i class="fa-solid fa-arrow-up"></i> Level Up', callback: (h) => resolve(extract(h)) },
            cancel:  { label: 'Cancel', callback: () => resolve(null) },
          },
          default: 'cancel',
          close:   () => resolve(null),
        }).render(true);
      }
    });

    if (!result) return;
    const { level: targetLevel, instructions } = result;
    if (targetLevel === currentLevel) {
      ui.notifications.info('Target level is the same as current level.');
      return;
    }

    const key = builderApp.accessKey || builderApp.storage.getKey() || '';
    if (!key) {
      builderApp.authenticated = false;
      builderApp._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    ui.notifications.info(`Processing level change for "${actor.name}" to level ${targetLevel}…`);

    try {
      const payload = {
        npcData:      actor.toObject(),
        targetLevel,
        instructions: instructions || '',
        system:       'pf2e',
      };

      const endpoint = devUrl(LEVELUP_URL, isDevMode(builderApp.moduleFolder));
      const { response, responseText } = await postToN8n(endpoint, payload, key);

      const data = JSON.parse(responseText);
      if (!response.ok) throw new Error(data?.message || `Server returned status ${response.status}`);

      const newActorData = data.foundryNpc || data.npcDesign || data.actor || data;
      if (!newActorData || typeof newActorData !== 'object') {
        throw new Error('No valid actor data returned from server');
      }

      await enrichSpellsFromCompendium(newActorData);
      sanitizeActorDataPf2e(newActorData);

      let newActor, attempts = 0;
      while (!newActor && attempts < 10) {
        attempts++;
        try {
          newActor = await Actor.create(newActorData);
        } catch (error) {
          const errorText = error.toString ? error.toString() : String(error.message || error);
          if (tryFixValidationError(newActorData, errorText)) continue;
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

  /* ── Sheet injection ────────────────────────────────────── */

  registerSheetHooks(getApp) {
    const inject = (app, html) => {
      if (!game.user?.isGM) return;
      const actor = app.actor || app.document;
      if (!actor || actor.type !== 'npc') return;

      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;
      if (root.querySelector('.npc-builder-levelup-btn')) return;

      const eliteWeakArea =
        root.querySelector('.adjustment') ||
        root.querySelector('.elite-weak') ||
        root.querySelector('[data-action="elite"]')?.parentElement ||
        root.querySelector('.npc-header')?.querySelector('.tags') ||
        root.querySelector('.sheet-header .tags');

      if (eliteWeakArea) {
        const levelUpBtn = document.createElement('button');
        levelUpBtn.type = 'button';
        levelUpBtn.className = 'npc-builder-levelup-btn';
        levelUpBtn.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Level Up';
        levelUpBtn.title = "Change this NPC's level via the NPC Builder";
        levelUpBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.levelUpNpc(actor, getApp());
        });
        eliteWeakArea.parentNode.insertBefore(levelUpBtn, eliteWeakArea);
      }

      const acSection =
        root.querySelector('.armor-class') ||
        root.querySelector('.ac') ||
        root.querySelector('[data-slug="ac"]') ||
        root.querySelector('.side-bar-section');

      if (acSection) {
        const imageBtn = document.createElement('button');
        imageBtn.type = 'button';
        imageBtn.className = 'npc-builder-sheet-image-btn';
        imageBtn.innerHTML = '<i class="fa-solid fa-image"></i> Generate Image <span class="btn-cost-badge">4 uses</span>';
        imageBtn.title = 'Generate an AI image for this NPC (costs 4 NPC uses)';
        imageBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          getApp()._generateImage(null, actor.toObject(), 'pf2e');
        });
        acSection.parentNode.insertBefore(imageBtn, acSection);
      }
    };

    Hooks.on('renderNPCSheetPF2e',   inject);
    Hooks.on('renderActorSheetPF2e', (app, html) => { if (app.actor?.type === 'npc') inject(app, html); });
    Hooks.on('renderActorSheet',     (app, html) => {
      if (game.system?.id !== 'pf2e') return;
      if (app.actor?.type === 'npc') inject(app, html);
    });
  }
}
