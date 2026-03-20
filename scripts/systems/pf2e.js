/**
 * Pathfinder 2e — actor data sanitization helpers.
 *
 * Fixes common validation issues returned by the n8n PF2e workflow before
 * passing the data to Actor.create().
 */

/**
 * Sanitize a PF2e actor data object in-place.
 * Fixes IDs, removes invalid item types, converts feats to actions, and
 * strips invalid weapon traits.
 */
export function sanitizeActorDataPf2e(actorData) {
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
export function tryFixValidationError(actorData, errorMessage) {
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
