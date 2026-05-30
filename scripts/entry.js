/**
 * PF2e NPC Maker — module entry point.
 *
 * Wires the Pf2eNpcAdapter into the shared BuilderApp shell, registers
 * Foundry hooks (init/ready, sidebar buttons, sheet injection), and
 * handles the one-time welcome message + update check.
 */

import { openBuilder, ensureBuilder }      from './core/app.js';
import { checkForModuleUpdate }            from './core/update-check.js';
import { registerSidebar }                 from './core/sidebar.js';
import { startHeartbeat }                  from './core/heartbeat.js';
import { Storage }                         from './core/storage.js';
import { Pf2eNpcAdapter }                  from './adapter.js';

const adapter   = new Pf2eNpcAdapter();
const MODULE_ID = adapter.module.id;

const openFn = () => {
  openBuilder(adapter);
  checkForModuleUpdate(MODULE_ID, adapter.module.githubUrl).catch(() => {});
};

// Sheet buttons need a live app instance; hand them a getter that ensures one exists
adapter.registerSheetHooks(() => ensureBuilder(adapter));

registerSidebar(MODULE_ID, openFn, {
  buttonLabel: 'NPC Builder',
  buttonIcon:  adapter.module.icon,
  directories: ['actors', 'compendium'],
});

class ResetWelcomeMessageMenu {
  render() {
    foundry.applications.api.DialogV2.confirm({
      window:      { title: game.i18n.localize('NpcBuilder.Settings.ResetWelcome.Name') },
      content:     `<p>${game.i18n.localize('NpcBuilder.Settings.ResetWelcome.ConfirmContent')}</p>`,
      yes:         { label: game.i18n.localize('NpcBuilder.Settings.ResetWelcome.ConfirmLabel'), icon: 'fa-solid fa-rotate-left' },
      no:          { label: 'Cancel' },
      rejectClose: false,
    }).then(ok => {
      if (ok) {
        game.settings.set(MODULE_ID, 'welcomeMessageShown', false);
        ui.notifications.info(game.i18n.localize('NpcBuilder.Settings.ResetWelcome.Success'));
      }
    }).catch(() => {});
    return this;
  }
}

class ClearSessionMenu {
  render() {
    foundry.applications.api.DialogV2.confirm({
      window:      { title: game.i18n.localize('NpcBuilder.Settings.ClearSession.Name') },
      content:     `<p>${game.i18n.localize('NpcBuilder.Settings.ClearSession.ConfirmContent')}</p>`,
      yes:         { label: game.i18n.localize('NpcBuilder.Settings.ClearSession.ConfirmLabel'), icon: 'fa-solid fa-right-from-bracket' },
      no:          { label: 'Cancel' },
      rejectClose: false,
    }).then(ok => {
      if (ok) {
        new Storage(MODULE_ID).setKey('');
        ui.notifications.info(game.i18n.localize('NpcBuilder.Settings.ClearSession.Success'));
      }
    }).catch(() => {});
    return this;
  }
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'devMode', {
    name:   'Developer Mode',
    hint:   'When enabled, all webhook URLs are routed to the -dev endpoints. Disable before going live.',
    scope:  'world',
    config: true,
    type:   Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, 'welcomeMessageShown', {
    scope:  'world',
    config: false,
    type:   Boolean,
    default: false,
  });

  game.settings.registerMenu(MODULE_ID, 'resetWelcome', {
    name:       'NpcBuilder.Settings.ResetWelcome.Name',
    label:      'NpcBuilder.Settings.ResetWelcome.Label',
    hint:       'NpcBuilder.Settings.ResetWelcome.Hint',
    icon:       'fa-solid fa-rotate-left',
    type:       ResetWelcomeMessageMenu,
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, 'clearSession', {
    name:       'NpcBuilder.Settings.ClearSession.Name',
    label:      'NpcBuilder.Settings.ClearSession.Label',
    hint:       'NpcBuilder.Settings.ClearSession.Hint',
    icon:       'fa-solid fa-right-from-bracket',
    type:       ClearSessionMenu,
    restricted: true,
  });
});

// Cross-module bridge — lets sibling modules (e.g. Pf2eNationsAndCitiesMaker)
// open the NPC builder pre-filled and receive the created actor.
Hooks.on('Pf2eNpcMaker.openWithPrefill', (payload = {}) => {
  try {
    const app = ensureBuilder(adapter);
    app.render({ force: true });
    const tryFill = (attemptsLeft) => {
      const form = app.element?.querySelector?.('.npc-form');
      if (!form) {
        if (attemptsLeft > 0) setTimeout(() => tryFill(attemptsLeft - 1), 100);
        return;
      }
      const set = (sel, val) => { const el = form.querySelector(sel); if (el != null && val != null) el.value = val; };
      set('[name="name"]',        payload.name);
      set('[name="level"]',       payload.level);
      set('[name="description"]', payload.description);
      if (typeof payload.includeSpells === 'boolean') {
        const c = form.querySelector('[name="includeSpells"]'); if (c) c.checked = payload.includeSpells;
      }
    };
    tryFill(20);
    if (typeof payload.onCreate === 'function') {
      const handler = (actor) => {
        try { payload.onCreate(actor); } catch (e) { console.error('[Pf2eNpcMaker] onCreate handler failed', e); }
      };
      // One-shot: fire on the next successful creation, then unregister.
      const id = Hooks.on('createActor', (actor) => {
        if (actor?.type === 'npc') { handler(actor); Hooks.off('createActor', id); }
      });
    }
  } catch (err) {
    console.error('[Pf2eNpcMaker] openWithPrefill failed', err);
  }
});

Hooks.once('ready', () => {
  const mod = game.modules?.get(MODULE_ID);
  const currentVersion = mod?.version || '';

  const storage = new Storage(MODULE_ID);
  const storedVersion = storage.getVersion();

  // Clear the session when the module updates so stale keys don't persist
  if (currentVersion && storedVersion && currentVersion !== storedVersion) {
    storage.setKey('');
    ui.notifications?.info?.('NPC Builder was updated — please sign in again.');
  }
  if (currentVersion) storage.setVersion(currentVersion);

  foundry.applications.handlebars.loadTemplates([
    `modules/${MODULE_ID}/templates/builder.html`,
  ]);
  console.log(`PF2E NPC Auto-Builder ready (version: ${currentVersion}).`);

  startHeartbeat(MODULE_ID);

  if (game.user.isGM && !game.settings.get(MODULE_ID, 'welcomeMessageShown')) {
    const welcomeContent = `
<h3>Welcome to the PF2e NPC Auto-Builder!</h3>
<p>The builder has opened automatically — you're ready to start generating NPCs right away.</p>
<p>You can reopen the builder any time from the <em>NPC Builder</em> button in the <strong>Actors</strong> or <strong>Compendium</strong> sidebar header.</p>`.trim();

    ChatMessage.create({
      content: welcomeContent,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
    });
    game.settings.set(MODULE_ID, 'welcomeMessageShown', true);
    openBuilder(adapter);
    checkForModuleUpdate(MODULE_ID, adapter.module.githubUrl).catch(() => {});
  }
});
