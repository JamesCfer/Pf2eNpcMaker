/**
 * D&D 5e — actor data sanitization helpers.
 *
 * Fixes common validation issues returned by the n8n D&D 5e workflow before
 * passing the data to Actor.create().
 */

/**
 * Sanitize a D&D 5e actor data object in-place.
 * Ensures NPC type, fixes ability/save structures, normalises trait sets,
 * initialises movement and currency, and removes prototypeToken so that
 * the token can be patched after Actor.create() completes.
 */
export function sanitizeActorDataDnd5e(actorData) {
  const generateId = () => foundry.utils.randomID(16);

  if (!actorData._id || actorData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(actorData._id)) {
    console.warn('[NPC Builder] D&D 5e: Fixing invalid actor _id:', actorData._id);
    actorData._id = generateId();
  }

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
      if (!item.system) item.system = {};
      if (!item.system.description) item.system.description = { value: '', chat: '', unidentified: '' };
    });
  }

  if (!actorData.flags) actorData.flags = {};
  if (!actorData.img) actorData.img = 'icons/svg/mystery-man.svg';

  const _abilities = actorData.system?.abilities || {};

  if (actorData.system?.save && typeof actorData.system.save === 'object') {
    console.warn('[NPC Builder] D&D 5e: Fixing misplaced system.save');
    for (const [k, v] of Object.entries(actorData.system.save)) {
      if (_abilities[k]) _abilities[k].proficient = v?.proficient ?? 0;
    }
    delete actorData.system.save;
  }
  if (actorData.system?.['attributes.save'] && typeof actorData.system['attributes.save'] === 'object') {
    console.warn('[NPC Builder] D&D 5e: Fixing misplaced system["attributes.save"]');
    for (const [k, v] of Object.entries(actorData.system['attributes.save'])) {
      if (_abilities[k]) _abilities[k].proficient = v?.proficient ?? 0;
    }
    delete actorData.system['attributes.save'];
  }
  if (actorData.system?.attributes?.save && typeof actorData.system.attributes.save === 'object') {
    console.warn('[NPC Builder] D&D 5e: Fixing misplaced system.attributes.save');
    for (const [k, v] of Object.entries(actorData.system.attributes.save)) {
      if (_abilities[k]) _abilities[k].proficient = v?.proficient ?? 0;
    }
    delete actorData.system.attributes.save;
  }

  const _traits = actorData.system?.traits;
  if (_traits) {
    const toTraitSet = (val) => {
      if (val && typeof val === 'object' && !Array.isArray(val) && Array.isArray(val.value)) {
        if (!val.custom) val.custom = '';
        return val;
      }
      if (Array.isArray(val)) return { value: val, custom: '' };
      return { value: [], custom: '' };
    };
    if (_traits.di        !== undefined) _traits.di        = toTraitSet(_traits.di);
    if (_traits.dr        !== undefined) _traits.dr        = toTraitSet(_traits.dr);
    if (_traits.dv        !== undefined) _traits.dv        = toTraitSet(_traits.dv);
    if (_traits.ci        !== undefined) _traits.ci        = toTraitSet(_traits.ci);
    if (_traits.languages !== undefined) _traits.languages = toTraitSet(_traits.languages);
  }

  const _attrs = actorData.system?.attributes;
  if (_attrs && !_attrs.movement) {
    const spd = _attrs.speed;
    const walkVal = (spd && typeof spd === 'object' ? spd.value : spd) || 30;
    _attrs.movement = {
      burrow: 0, climb: 0, fly: 0, swim: 0,
      walk: typeof walkVal === 'number' ? walkVal : (parseInt(walkVal) || 30),
      units: 'ft', hover: false,
    };
  }

  if (actorData.system && !actorData.system.currency) {
    actorData.system.currency = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  }

  delete actorData.prototypeToken;

  console.log('[NPC Builder] D&D 5e actor data sanitized:', actorData.name, '| items:', actorData.items?.length || 0);
}
