import type { Spell, AbilityName } from '@dnd-vtt/shared';

/**
 * Parse damage dice, damage type, save ability, attack type, and AoE info
 * from a spell's description text. Returns only the fields it could find;
 * fields it couldn't parse are left undefined so callers can fall back to
 * any structured data they already have.
 *
 * Used to "enrich" spells whose structured fields are missing — typically
 * spells imported from D&D Beyond, where damage often lives in modifier
 * arrays instead of a top-level field.
 *
 * Mirrors enrichSpellInPlaceFromDescription on the server. Keep them in sync.
 */
export function parseSpellMetaFromDesc(description: string): Partial<Spell> {
  const out: Partial<Spell> = {};
  const cleanDesc = (description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (!cleanDesc) return out;

  // Damage dice + type. Match the FIRST "NdM[+K] <type> damage" we find;
  // this is usually the base damage. Higher-level scaling text appears
  // separately under "At Higher Levels".
  const dmgMatch = cleanDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(\w+)\s*damage/i);
  if (dmgMatch) {
    out.damage = dmgMatch[1].replace(/\s/g, '');
    const candidateType = dmgMatch[2].toLowerCase();
    const validTypes = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
    if (validTypes.includes(candidateType)) out.damageType = candidateType;
  }

  // Healing dice. Healing spells say "regains hit points equal to 1d4 +
  // your spellcasting ability modifier", so the damage regex misses them.
  // Try a healing-specific pattern only if we didn't find damage above.
  if (!out.damage) {
    const healMatch = cleanDesc.match(/(?:regains|heals?|healing|hit\s+points\s+equal\s+to)[^.]*?(\d+d\d+(?:\s*\+\s*\d+)?)/i);
    if (healMatch) {
      out.damage = healMatch[1].replace(/\s/g, '');
      out.damageType = 'healing';
    }
  }

  // Saving throw
  const saveMatch = cleanDesc.match(/(strength|dexterity|constitution|wisdom|intelligence|charisma)\s+saving\s+throw/i);
  if (saveMatch) {
    const m: Record<string, AbilityName> = { strength: 'str', dexterity: 'dex', constitution: 'con', wisdom: 'wis', intelligence: 'int', charisma: 'cha' };
    out.savingThrow = m[saveMatch[1].toLowerCase()];
  }

  // Attack type
  if (/ranged spell attack/i.test(cleanDesc)) out.attackType = 'ranged';
  else if (/melee spell attack/i.test(cleanDesc)) out.attackType = 'melee';

  // AoE shape + size. Spell descriptions use TWO common patterns:
  //   • "20-foot-radius sphere" / "15 foot cube"  → number FIRST
  //   • "line 100 feet long" / "cone 60 feet"    → shape FIRST (Lightning Bolt!)
  // Try both. The matched shape word picks the AoE type.
  let aoeShape: string | null = null;
  let aoeSizeNum: number | null = null;
  const m1 = cleanDesc.match(/(\d+)[- ]?(?:foot|feet)[- ]?(?:long\s+|wide\s+)?(radius|sphere|cube|cone|line|cylinder|emanation)/i);
  if (m1) {
    aoeSizeNum = parseInt(m1[1]);
    aoeShape = m1[2].toLowerCase();
  } else {
    const m2 = cleanDesc.match(/(line|sphere|cube|cone|cylinder|radius|emanation)\s+(\d+)\s*(?:feet|foot)/i);
    if (m2) {
      aoeShape = m2[1].toLowerCase();
      aoeSizeNum = parseInt(m2[2]);
    }
  }
  if (aoeShape && aoeSizeNum !== null) {
    out.aoeSize = aoeSizeNum;
    if (aoeShape === 'cube') out.aoeType = 'cube';
    else if (aoeShape === 'cone') out.aoeType = 'cone';
    else if (aoeShape === 'line') out.aoeType = 'line';
    else if (aoeShape === 'cylinder') out.aoeType = 'cylinder';
    else out.aoeType = 'sphere';
  }

  return out;
}

/**
 * Take an existing Spell object and fill in any missing combat fields by
 * parsing the description. Existing fields take precedence — we only set a
 * field if it's not already populated. This is what makes a DDB-imported
 * Vicious Mockery suddenly show "1d4 psychic" in the spell list without
 * touching the database.
 */
export function enrichSpellFromDescription(spell: Spell): Spell {
  const parsed = parseSpellMetaFromDesc(spell.description);
  return {
    ...spell,
    damage: spell.damage || parsed.damage,
    damageType: spell.damageType || parsed.damageType,
    savingThrow: spell.savingThrow || parsed.savingThrow,
    attackType: spell.attackType || parsed.attackType,
    aoeType: spell.aoeType || parsed.aoeType,
    aoeSize: spell.aoeSize || parsed.aoeSize,
  };
}
