/**
 * Metadata for every module in the family.
 * The home page renders one card per entry — the card matching the running
 * module is highlighted as "this module"; the others link to their GitHub
 * release pages so users can install them too.
 */

export const ALL_MODULES = [
  {
    id:          'Pf2eNpcMaker',
    label:       'Pathfinder 2e NPC',
    icon:        'fa-solid fa-dragon',
    accentClass: 'card--pf2e',
    description: 'Generate fully-statted PF2e NPCs from a description.',
    github:      'https://github.com/JamesCfer/Pf2eNpcMaker',
    install:     'https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest',
  },
  {
    id:          'DnD5eNpcMaker',
    label:       'D&D 5e NPC',
    icon:        'fa-solid fa-shield-halved',
    accentClass: 'card--dnd5e',
    description: 'Generate D&D 5e creatures with stat blocks, spells, and CR.',
    github:      'https://github.com/JamesCfer/DnD5eNpcMaker',
    install:     'https://github.com/JamesCfer/DnD5eNpcMaker/releases/latest',
  },
  {
    id:          'Hero6eNpcMaker',
    label:       'HERO System 6e',
    icon:        'fa-solid fa-bolt',
    accentClass: 'card--hero6e',
    description: 'Generate Hero System 6e characters and import the .hdc directly.',
    github:      'https://github.com/JamesCfer/Hero6eNpcMaker',
    install:     'https://github.com/JamesCfer/Hero6eNpcMaker/releases/latest',
  },
  {
    id:          'Pf2eItemGenerator',
    label:       'Pathfinder 2e Item',
    icon:        'fa-solid fa-flask',
    accentClass: 'card--pf2eitem',
    description: 'Generate PF2e items (weapons, armor, consumables, treasure) from a description.',
    github:      'https://github.com/JamesCfer/Pf2eItemMaker',
    install:     'https://github.com/JamesCfer/Pf2eItemMaker/releases/latest',
  },
];

export function getModuleMeta(id) {
  return ALL_MODULES.find(m => m.id === id) || null;
}
