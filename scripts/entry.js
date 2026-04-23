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
  buttonIcon:  '★',
  directories: ['actors', 'compendium'],
});

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
});

Hooks.once('ready', () => {
  const mod = game.modules?.get(MODULE_ID);
  const currentVersion = mod?.version || '';

  const storedVersionKey = `${MODULE_ID}.module-version`;
  let storedVersion = '';
  try { storedVersion = localStorage.getItem(storedVersionKey) || ''; } catch (_) {}

  // Clear the session when the module updates so stale keys don't persist
  if (currentVersion && storedVersion && currentVersion !== storedVersion) {
    try {
      localStorage.removeItem(`${MODULE_ID}.key`);
      localStorage.removeItem(`${MODULE_ID}:key`);
    } catch (_) {}
    ui.notifications?.info?.('NPC Builder was updated — please sign in again.');
  }
  if (currentVersion) {
    try { localStorage.setItem(storedVersionKey, currentVersion); } catch (_) {}
  }

  (foundry.applications.handlebars?.loadTemplates ?? loadTemplates)([
    `modules/${MODULE_ID}/templates/builder.html`,
  ]);
  console.log(`PF2E NPC Auto-Builder ready (version: ${currentVersion}).`);

  if (game.user.isGM && !game.settings.get(MODULE_ID, 'welcomeMessageShown')) {
    const welcomeContent = `
<h3>Welcome to the PF2e NPC Auto-Builder!</h3>
<p>The builder has opened automatically. The <strong>Home</strong> tab inside it walks you through how to get started.</p>
<p>You can reopen the builder any time from the <em>NPC Builder</em> button in the <strong>Actors</strong> or <strong>Compendium</strong> sidebar header.</p>`.trim();

    ChatMessage.create({
      content: welcomeContent,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
    });
    game.settings.set(MODULE_ID, 'welcomeMessageShown', true);
    openBuilder(adapter, { initialTab: 'home' });
    checkForModuleUpdate(MODULE_ID, adapter.module.githubUrl).catch(() => {});
  }
});
