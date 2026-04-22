/**
 * Pathfinder 2e — actor data sanitization helpers.
 *
 * Fixes common validation issues returned by the n8n PF2e workflow before
 * passing the data to Actor.create().
 */

/**
 * Enrich spell items on an actor data object by fetching full system data
 * from the local PF2e compendium using each spell's compendiumSource UUID.
 *
 * Must be called BEFORE sanitizeActorDataPf2e and BEFORE Actor.create().
 * Client-side only — n8n only knows spell IDs, not full data.
 */
export async function enrichSpellsFromCompendium(actorData) {
  if (!Array.isArray(actorData.items)) return;

  const spellItems = actorData.items.filter(i => i.type === 'spell');
  if (!spellItems.length) return;

  console.log(`[NPC Builder] Enriching ${spellItems.length} spells from compendium...`);

  await Promise.all(spellItems.map(async (spellItem) => {
    const source = spellItem._stats?.compendiumSource;
    if (!source) return;

    try {
      const compendiumSpell = await fromUuid(source);
      if (!compendiumSpell) {
        console.warn(`[NPC Builder] Could not find compendium spell: ${source}`);
        return;
      }

      const ourLocation = spellItem.system?.location;
      const compendiumData = compendiumSpell.toObject();
      spellItem.system = foundry.utils.mergeObject(
        compendiumData.system,
        { location: ourLocation },
        { overwrite: true, inplace: false }
      );
      if (compendiumData.img) spellItem.img = compendiumData.img;
    } catch (e) {
      console.warn(`[NPC Builder] Could not enrich spell "${spellItem.name}" from ${source}:`, e);
    }
  }));

  console.log('[NPC Builder] Spell enrichment complete');
}

export function sanitizeActorDataPf2e(actorData) {
  const generateId = () => foundry.utils.randomID(16);

  if (!actorData._id || actorData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(actorData._id)) {
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
    actorData.items = actorData.items.filter(item => !invalidItemTypes.has(item.type));

    actorData.items = actorData.items.map(item => {
      if (item.type === 'feat') {
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
        if (action.system.selfEffect) delete action.system.selfEffect;
        return action;
      }

      if (item.type === 'ranged') return { ...item, type: 'weapon' };
      return item;
    });

    actorData.items.forEach(item => {
      if (!item._id || item._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(item._id)) {
        item._id = generateId();
      }

      if ((item.type === 'melee' || item.type === 'weapon') && item.system?.traits?.value) {
        item.system.traits.value = item.system.traits.value.filter(
          t => !invalidWeaponTraits.includes(t.toLowerCase())
        );
      }

      if (item.system?.traits?.value && Array.isArray(item.system.traits.value)) {
        item.system.traits.value = item.system.traits.value.filter(
          t => t.toLowerCase() !== 'special'
        );
      }
    });
  }
}

export function tryFixValidationError(actorData, errorMessage) {
  const invalidTraitMatch = errorMessage.match(/(\w+) is not a valid choice/);
  if (invalidTraitMatch) {
    const badTrait = invalidTraitMatch[1];
    let removed = false;
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
    let removed = false;
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
    let fixed = false;
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
