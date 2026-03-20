/**
 * Hero System 6e — actor data sanitization helpers.
 *
 * Fixes common validation issues returned by the n8n Hero 6e workflow before
 * passing the data to Actor.create().
 *
 * IMPORTANT: n8n Step 4 injects critical fields onto each item.system before
 * returning the response. This function MUST preserve those fields:
 *
 *   INPUT       — required by _getNonCharacteristicsBasedRollComponents; calling
 *                 INPUT.includes() on undefined causes a TypeError that crashes
 *                 the entire actor sheet render.
 *   OPTIONID    — required by COMBAT_LEVELS, FLASHDEFENSE, STRIKING_APPEARANCE,
 *                 SKILL_LEVELS, etc.; missing causes a crash on sheet open.
 *   OPTION      — companion to OPTIONID.
 *   OPTION_ALIAS — display label for the selected option.
 *   CHARACTERISTIC — required by skills (DEX, INT, PRE, etc.) and some talents.
 *   ADDER       — required by REPUTATION, ACCIDENTALCHANGE, HUNTED, SOCIALLIMITATION,
 *                 ENRAGED, PSYCHOLOGICALLIMITATION; missing causes a fatal TypeError.
 *   xmlTag      — required by getPowerInfo() to resolve the correct power definition.
 *   is5e        — must be false on every item to suppress 5e-mode warnings.
 *
 * CHARACTERISTIC STORAGE — two paths must both be populated:
 *
 *   system.characteristics[KEY] — what this sanitizer reads (LEVELS → max/value).
 *
 *   system[KEY] e.g. system.STR  — EmbeddedDataField HeroItemCharacteristic.
 *     hero6efoundryvttv2's _preCreate iterates all uppercase system keys and, when
 *     XMLID is MISSING, does:
 *       actorChanges.system[KEY] = { XMLID: KEY, xmlTag: KEY }
 *     then calls updateSource(actorChanges) which REPLACES the embedded object,
 *     wiping LEVELS back to 0.
 *     Fix: always write { LEVELS, XMLID, xmlTag } onto every direct uppercase key
 *     so the `!char.XMLID` guard is false and _preCreate skips it entirely.
 *
 * CASE NORMALIZATION — Foundry actor exports store characteristics under lowercase
 *   keys (e.g. "str", "dex") with { max, value } but NO LEVELS field. The n8n
 *   workflow may produce uppercase keys with a LEVELS field. This sanitizer handles
 *   both, deriving LEVELS from (max - base) when reading a lowercase Foundry export
 *   key, and always normalizing to uppercase before writing.
 *
 * This function only handles structural concerns (IDs, type coercion, required
 * defaults). It trusts n8n's validated XMLIDs and injected fields completely.
 */

/**
 * Sanitize a Hero System 6e actor data object in-place.
 */
export function sanitizeActorDataHero6e(actorData) {
  const generateId = () => foundry.utils.randomID(16);

  // ── Actor-level fields ────────────────────────────────────────────────────
  if (!actorData._id || actorData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(actorData._id)) {
    console.warn('[NPC Builder] Hero 6e: Fixing invalid actor _id:', actorData._id);
    actorData._id = generateId();
  }

  if (actorData.type !== 'npc') {
    console.warn('[NPC Builder] Hero 6e: Correcting actor type to "npc" (was:', actorData.type, ')');
    actorData.type = 'npc';
  }

  if (!actorData.img)     actorData.img     = 'icons/svg/mystery-man.svg';
  if (!actorData.flags)   actorData.flags   = {};
  if (!actorData.effects) actorData.effects = [];

  // ── System-level fields ───────────────────────────────────────────────────
  if (!actorData.system) actorData.system = {};
  const sys = actorData.system;

  if (typeof sys.is5e === 'undefined') sys.is5e = false;

  // ── Characteristics ───────────────────────────────────────────────────────
  // hero6efoundryvttv2 stores characteristics in TWO places that must both be set:
  //
  // 1. system.characteristics[KEY]  (HeroCharacteristicsModel — what THIS code reads)
  //    { LEVELS, value, max } where value = max = base + LEVELS.
  //
  // 2. system[KEY]  e.g. system.STR  (EmbeddedDataField HeroItemCharacteristic)
  //    _preCreate reads these. If XMLID is absent it REPLACES the whole object with
  //    { XMLID, xmlTag }, zeroing LEVELS. We must include XMLID so _preCreate skips
  //    the field. After Actor.create() the _onUpdate hook reads system[KEY].LEVELS
  //    and propagates it into system.characteristics[key].max / .value.
  //
  // Source priority for LEVELS:
  //   a) chars[KEY] (uppercase) with explicit LEVELS field  → use directly
  //   b) chars[key] (lowercase, Foundry export) with max    → derive: max - base
  //   c) sys[KEY].LEVELS (direct uppercase field)           → use as fallback
  //   d) Nothing found                                      → 0 (base value)
  const CHAR_BASES = {
    STR:10, DEX:10, CON:10, INT:10, EGO:10, PRE:10,
    OCV:3,  DCV:3,  OMCV:3, DMCV:3,
    SPD:2,  PD:2,   ED:2,
    REC:4,  END:20, BODY:10, STUN:20,
  };

  if (!sys.characteristics) sys.characteristics = {};
  const chars = sys.characteristics;

  for (const [key, base] of Object.entries(CHAR_BASES)) {
    const lkey   = key.toLowerCase();
    const upper  = chars[key];   // uppercase key (n8n output)
    const lower  = chars[lkey];  // lowercase key (Foundry export)

    let levels;

    if (upper && upper.LEVELS !== undefined) {
      // Path A: uppercase key with explicit LEVELS (n8n workflow output)
      levels = Math.max(0, parseInt(upper.LEVELS) || 0);
    } else if (lower && lower.max !== undefined) {
      // Path B: lowercase Foundry export key — derive LEVELS from max - base
      levels = Math.max(0, (parseInt(lower.max) || base) - base);
    } else if (upper && upper.max !== undefined) {
      // Path C: uppercase key but no LEVELS, has max — derive same way
      levels = Math.max(0, (parseInt(upper.max) || base) - base);
    } else if (sys[key] && sys[key].LEVELS !== undefined) {
      // Path D: fall back to the direct uppercase system field
      levels = Math.max(0, parseInt(sys[key].LEVELS) || 0);
    } else {
      // Path E: nothing useful found — use base (0 purchased levels)
      levels = 0;
    }

    // Normalize to uppercase key with all required fields
    chars[key] = {
      LEVELS: levels,
      max:    base + levels,
      value:  base + levels,
    };

    // Delete the lowercase dupe so the system doesn't see unknown keys
    if (lower !== undefined) {
      delete chars[lkey];
    }

    // Mirror onto the direct uppercase field with XMLID present.
    // This prevents _preCreate from replacing the object and zeroing LEVELS.
    sys[key] = { LEVELS: levels, XMLID: key, xmlTag: key };
  }

  // Remove any non-standard characteristic keys (e.g. "Natural", stray lowercase
  // dupes that weren't caught above, movement keys like "running" / "flight").
  // The Hero system iterates ALL keys in characteristics and calls getPowerInfo()
  // on each — any unknown key logs "Unable to find 6e power entry" and can
  // interfere with point calculations and sheet rendering.
  for (const k of Object.keys(chars)) {
    if (!CHAR_BASES[k]) {
      console.warn('[NPC Builder] Hero 6e: Removing non-standard characteristic key:', k);
      delete chars[k];
    }
  }

  // ── Items: coerce LEVELS to string, ensure required fields ───────────────
  if (!Array.isArray(actorData.items)) actorData.items = [];

  const VALID_ITEM_TYPES = new Set([
    'power', 'skill', 'talent', 'complication', 'equipment',
    'perk', 'martialart', 'maneuver', 'characteristic',
  ]);

  actorData.items = actorData.items.map(item => {
    if (!item._id || item._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(item._id)) {
      item._id = generateId();
    }

    // Default type to 'power' if missing or invalid
    if (!VALID_ITEM_TYPES.has(item.type)) {
      console.warn('[NPC Builder] Hero 6e: Unknown item type', item.type, '— defaulting to "power"');
      item.type = 'power';
    }

    if (!item.system) item.system = {};
    const s = item.system;

    // XMLID: trust n8n's validated value entirely.
    // Only set a safe fallback if the field is completely absent.
    // Do NOT use invalid 5e-era defaults like 'PSYCHOLOGICAL_LIMITATION' (broken —
    // the correct 6e XMLID has no underscores: PSYCHOLOGICALLIMITATION) or 'SKILL'
    // (doesn't exist in hero6efoundryvttv2).
    if (!s.XMLID) {
      const xmlidDefaults = {
        power:        'CUSTOMPOWER',
        skill:        'CUSTOMSKILL',
        talent:       'CUSTOMTALENT',
        complication: 'GENERICDISADVANTAGE',
      };
      s.XMLID = xmlidDefaults[item.type] || 'CUSTOMPOWER';
      console.warn('[NPC Builder] Hero 6e: Missing XMLID on', item.type, '→ defaulting to', s.XMLID);
    }

    // LEVELS must be a string (hero6e system reads it that way)
    if (typeof s.LEVELS === 'number') s.LEVELS = String(s.LEVELS);
    if (!s.LEVELS) s.LEVELS = '1';

    // ALIAS doubles as the display name
    if (!s.ALIAS)       s.ALIAS       = item.name || s.XMLID;
    if (!s.description) s.description = item.name || '';

    // Numeric fields
    if (s.active_points !== undefined) s.active_points = parseInt(s.active_points) || 0;
    if (s.real_cost     !== undefined) s.real_cost     = parseInt(s.real_cost)     || 0;
    if (s.ENDCOST       !== undefined) s.ENDCOST       = parseInt(s.ENDCOST)       || 0;

    // Complications need a numeric POINTS value
    if (item.type === 'complication') {
      s.POINTS = parseInt(s.POINTS) || 10;
    }

    // Debug: log key fields for every power so we can confirm INPUT/OPTIONID survive
    if (item.type === 'power') {
      console.log('[NPC Builder] Hero 6e item:', s.XMLID,
        '| INPUT:', s.INPUT        || 'MISSING',
        '| OPTIONID:', s.OPTIONID  || 'none',
        '| CHARACTERISTIC:', s.CHARACTERISTIC || 'none');
    }

    item.system = s;
    return item;
  });

  console.log('[NPC Builder] Hero 6e actor data sanitized:', actorData.name,
    '| items:', actorData.items.length,
    '| powers:', actorData.items.filter(i => i.type === 'power').length,
    '| skills:', actorData.items.filter(i => i.type === 'skill').length,
    '| complications:', actorData.items.filter(i => i.type === 'complication').length);
}
