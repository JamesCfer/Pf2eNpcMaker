/**
 * Header controls + sidebar button injection.
 *
 * Each module calls `registerSidebar(moduleId, openFn, options)` once at init.
 * The button label, icon, and which directories to inject into are configurable
 * so an Item Maker can hook into the Items directory instead of Actors.
 */

const DIR_HOOKS = {
  actors: {
    headerHooks: [
      'getHeaderControlsActorDirectory',
      'getHeaderControlsActorDirectoryPF2e',
    ],
    renderHooks: [
      'renderActorDirectory',
      'renderActorDirectoryPF2e',
    ],
    appNames: ['ActorDirectory', 'ActorDirectoryPF2e'],
  },
  compendium: {
    headerHooks: [
      'getHeaderControlsCompendiumDirectory',
      'getHeaderControlsCompendiumDirectoryPF2e',
    ],
    renderHooks: [
      'renderCompendiumDirectory',
      'renderCompendiumDirectoryPF2e',
    ],
    appNames: ['CompendiumDirectory', 'CompendiumDirectoryPF2e'],
  },
  items: {
    headerHooks: [
      'getHeaderControlsItemDirectory',
      'getHeaderControlsItemDirectoryPF2e',
    ],
    renderHooks: [
      'renderItemDirectory',
      'renderItemDirectoryPF2e',
    ],
    appNames: ['ItemDirectory', 'ItemDirectoryPF2e'],
  },
};

export function registerSidebar(moduleId, openFn, {
  buttonLabel = 'NPC Builder',
  buttonIcon  = '★',
  directories = ['actors', 'compendium'],
} = {}) {

  const headerControl = (app, controls) => {
    if (!game.user?.isGM) return;
    const exists = controls.some(c => c.action === `${moduleId}-control`);
    if (exists) return;
    controls.push({
      action:  `${moduleId}-control`,
      icon:    'fa-solid fa-star',
      label:   buttonLabel,
      onClick: openFn,
      onclick: openFn,
      visible: true,
    });
  };

  const sidebarButton = (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const cls = `npc-builder-button-${moduleId}`;
    if (root.querySelector(`.${cls}`)) return;

    const button = document.createElement('button');
    button.type  = 'button';
    button.classList.add('npc-builder-button', cls);
    button.style.marginLeft = '4px';
    button.innerHTML = `${buttonIcon} ${buttonLabel} ${buttonIcon}`;
    button.addEventListener('click', openFn);

    const header = root.querySelector('header') || root.querySelector('.directory-header');
    if (header) header.appendChild(button); else root.prepend(button);
  };

  const matchingAppNames = new Set();
  for (const dir of directories) {
    const cfg = DIR_HOOKS[dir];
    if (!cfg) continue;
    cfg.headerHooks.forEach(h => Hooks.on(h, headerControl));
    cfg.renderHooks.forEach(h => Hooks.on(h, sidebarButton));
    cfg.appNames.forEach(n => matchingAppNames.add(n));
  }

  // Generic ApplicationV2 fallback for hooks that don't have specific names yet
  Hooks.on('getHeaderControlsApplicationV2', (app, controls) => {
    try {
      if (matchingAppNames.has(app?.constructor?.name)) headerControl(app, controls);
    } catch (err) {
      console.warn(`[${moduleId}] generic header control hook failed`, err);
    }
  });
}
