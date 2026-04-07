import type {
  Character, AbilityScores, Skills, SkillProficiency,
  SpellSlot, Spell, InventoryItem, DeathSaves, Feature,
  CharacterBackground, CharacterCharacteristics, CharacterPersonality,
  CharacterNotes, CharacterProficiencies, CharacterSenses,
  CharacterDefenses, CharacterCurrency,
} from '@dnd-vtt/shared';
import { proficiencyBonusForLevel, abilityModifier, SKILL_ABILITY_MAP } from '@dnd-vtt/shared';

/**
 * Parse a D&D Beyond character JSON export into our Character type.
 * Handles the standard D&D Beyond character sheet JSON format.
 */
export function parseCharacterJSON(json: Record<string, unknown>): Omit<Character, 'id' | 'userId' | 'createdAt' | 'updatedAt'> {
  const data = json.data ? (json.data as Record<string, unknown>) : json;

  // Basic info
  const name = (data.name as string) ?? 'Unknown Character';
  const race = extractRace(data);
  const classes = extractClasses(data);
  const level = extractTotalLevel(data);
  const profBonus = proficiencyBonusForLevel(level);
  const hitDice = extractHitDice(data);

  // Ability scores
  const abilityScores = extractAbilityScores(data);

  // HP
  const { hitPoints, maxHitPoints, tempHitPoints } = extractHitPoints(data, abilityScores, level);

  // AC
  const armorClass = extractArmorClass(data, abilityScores);

  // Speed
  const speed = extractSpeed(data);

  // Saving throws
  const savingThrows = extractSavingThrows(data);

  // Skills
  const skills = extractSkills(data);

  // Spells
  const spellSlots = extractSpellSlots(data);
  const spells = extractSpells(data);

  // Features
  const features = extractFeatures(data);

  // Inventory
  const inventory = extractInventory(data);

  // New extended fields
  const background = extractBackground(data);
  const characteristics = extractCharacteristics(data);
  const personality = extractPersonality(data);
  const notes = extractNotes(data);
  const proficiencies = extractProficiencies(data);
  const senses = extractSenses(data, abilityScores, skills, profBonus);
  const defenses = extractDefenses(data);
  const conditions: string[] = [];
  const currency = extractCurrency(data);
  const extras = extractExtras(data);
  const { spellcastingAbility, spellAttackBonus, spellSaveDC } = extractSpellcasting(data, abilityScores, profBonus);
  const initiative = extractInitiative(data, abilityScores);

  // Portrait - proxy through our server to avoid CORS issues on canvas
  const rawPortraitUrl = (data.avatarUrl as string) ??
    (data.decorations as Record<string, unknown>)?.avatarUrl as string ?? null;
  const portraitUrl = rawPortraitUrl && rawPortraitUrl.includes('dndbeyond.com')
    ? `/api/dndbeyond/proxy-image?url=${encodeURIComponent(rawPortraitUrl)}`
    : rawPortraitUrl;

  // D&D Beyond ID
  const dndbeyondId = data.id ? String(data.id) : null;

  return {
    name,
    race,
    class: classes,
    level,
    hitPoints,
    maxHitPoints,
    tempHitPoints,
    armorClass,
    speed,
    proficiencyBonus: profBonus,
    abilityScores,
    savingThrows,
    skills,
    spellSlots,
    spells,
    features,
    inventory,
    deathSaves: { successes: 0, failures: 0 },
    background,
    characteristics,
    personality,
    notes,
    proficiencies,
    senses,
    defenses,
    conditions,
    currency,
    extras,
    spellcastingAbility,
    spellAttackBonus,
    spellSaveDC,
    concentratingOn: null,
    hitDice,
    initiative,
    portraitUrl,
    dndbeyondId,
    source: 'dndbeyond_import',
  };
}

/**
 * Build hit dice pools from the DDB classes array. Multi-class characters
 * get one HitDicePool per die size (the pools may be merged if two classes
 * happen to share the same die — e.g. Bard d8 + Cleric d8 → 1 pool).
 */
function extractHitDice(data: Record<string, unknown>): Array<{ dieSize: number; total: number; used: number }> {
  const classes = data.classes as Array<Record<string, unknown>> | undefined;
  if (!classes || !Array.isArray(classes)) return [];
  const pools = new Map<number, { total: number; used: number }>();
  for (const c of classes) {
    const def = (c.definition as Record<string, unknown>) || {};
    const dieSize = (def.hitDice as number) || 8;
    const lvl = (c.level as number) || 0;
    if (lvl <= 0) continue;
    const existing = pools.get(dieSize) || { total: 0, used: 0 };
    existing.total += lvl;
    pools.set(dieSize, existing);
  }
  return Array.from(pools.entries()).map(([dieSize, p]) => ({
    dieSize,
    total: p.total,
    used: p.used,
  }));
}

function extractRace(data: Record<string, unknown>): string {
  if (data.race && typeof data.race === 'object') {
    const raceObj = data.race as Record<string, unknown>;
    const baseName = (raceObj.baseName as string) ?? (raceObj.fullName as string) ?? '';
    const subrace = raceObj.subRaceShortName as string;
    return subrace ? `${baseName} (${subrace})` : baseName;
  }
  if (typeof data.race === 'string') return data.race;
  return '';
}

function extractClasses(data: Record<string, unknown>): string {
  const classes = data.classes as Array<Record<string, unknown>> | undefined;
  if (!classes || !Array.isArray(classes)) return '';

  return classes.map(c => {
    const name = (c.definition as Record<string, unknown>)?.name as string ?? '';
    const level = c.level as number ?? 1;
    const subclass = (c.subclassDefinition as Record<string, unknown>)?.name as string;
    const base = subclass ? `${name} (${subclass})` : name;
    return `${base} ${level}`;
  }).join(' / ');
}

function extractTotalLevel(data: Record<string, unknown>): number {
  const classes = data.classes as Array<Record<string, unknown>> | undefined;
  if (!classes || !Array.isArray(classes)) return 1;
  return classes.reduce((sum, c) => sum + ((c.level as number) ?? 0), 0) || 1;
}

function extractAbilityScores(data: Record<string, unknown>): AbilityScores {
  const stats = data.stats as Array<Record<string, unknown>> | undefined;
  const modifiers = data.modifiers as Record<string, Array<Record<string, unknown>>> | undefined;
  const overrides = data.overrideStats as Array<Record<string, unknown>> | undefined;
  const bonusStats = data.bonusStats as Array<Record<string, unknown>> | undefined;

  const abilityNames: Array<keyof AbilityScores> = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  // D&D Beyond stat IDs: 1=STR, 2=DEX, 3=CON, 4=INT, 5=WIS, 6=CHA
  const result: AbilityScores = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  if (stats && Array.isArray(stats)) {
    for (let i = 0; i < 6; i++) {
      const statId = i + 1;
      const stat = stats.find(s => (s.id as number) === statId);
      if (stat) {
        let value = (stat.value as number) ?? 10;

        // Apply override if present
        if (overrides && Array.isArray(overrides)) {
          const override = overrides.find(o => (o.id as number) === statId);
          if (override && (override.value as number | null) != null) {
            value = override.value as number;
          }
        }

        // Apply bonus stats
        if (bonusStats && Array.isArray(bonusStats)) {
          const bonus = bonusStats.find(b => (b.id as number) === statId);
          if (bonus && (bonus.value as number | null) != null) {
            value += bonus.value as number;
          }
        }

        result[abilityNames[i]] = value;
      }
    }
  }

  // Apply racial and other modifiers
  if (modifiers) {
    const allMods = [
      ...(modifiers.race ?? []),
      ...(modifiers.class ?? []),
      ...(modifiers.background ?? []),
      ...(modifiers.item ?? []),
      ...(modifiers.feat ?? []),
    ];

    for (const mod of allMods) {
      if ((mod.type as string) === 'bonus' && (mod.subType as string)?.endsWith('-score')) {
        const abilityStr = (mod.subType as string).replace('-score', '');
        const abilityIndex = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
          .indexOf(abilityStr);
        if (abilityIndex >= 0) {
          result[abilityNames[abilityIndex]] += (mod.value as number) ?? 0;
        }
      }
    }
  }

  return result;
}

function extractHitPoints(
  data: Record<string, unknown>,
  abilities: AbilityScores,
  level: number,
): { hitPoints: number; maxHitPoints: number; tempHitPoints: number } {
  const conMod = abilityModifier(abilities.con);
  const baseHp = data.baseHitPoints as number | undefined;
  const bonusHp = data.bonusHitPoints as number | undefined;
  const overrideHp = data.overrideHitPoints as number | null | undefined;
  const removedHp = data.removedHitPoints as number | undefined;
  const tempHp = data.temporaryHitPoints as number | undefined;

  let maxHitPoints: number;
  if (overrideHp != null) {
    maxHitPoints = overrideHp;
  } else {
    maxHitPoints = (baseHp ?? 10) + (conMod * level) + (bonusHp ?? 0);
  }
  maxHitPoints = Math.max(1, maxHitPoints);

  const hitPoints = Math.max(0, maxHitPoints - (removedHp ?? 0));
  const tempHitPoints = tempHp ?? 0;

  return { hitPoints, maxHitPoints, tempHitPoints };
}

function extractArmorClass(data: Record<string, unknown>, abilities: AbilityScores): number {
  // Try to use the pre-calculated AC if available
  const armorClass = data.armorClass as number | undefined;
  if (armorClass != null) return armorClass;

  // Basic calculation: 10 + DEX modifier
  const dexMod = abilityModifier(abilities.dex);
  let ac = 10 + dexMod;

  // Check inventory for armor
  const inventory = data.inventory as Array<Record<string, unknown>> | undefined;
  if (inventory && Array.isArray(inventory)) {
    for (const item of inventory) {
      if (!(item.equipped as boolean)) continue;
      const def = item.definition as Record<string, unknown> | undefined;
      if (!def) continue;
      const armorTypeId = def.armorTypeId as number | undefined;
      if (armorTypeId == null) continue;

      const baseAC = def.armorClass as number | undefined;
      if (baseAC == null) continue;

      // Light armor: base + DEX
      if (armorTypeId === 1) {
        ac = baseAC + dexMod;
      }
      // Medium armor: base + DEX (max 2)
      else if (armorTypeId === 2) {
        ac = baseAC + Math.min(dexMod, 2);
      }
      // Heavy armor: base AC only
      else if (armorTypeId === 3) {
        ac = baseAC;
      }
      // Shield: +2
      else if (armorTypeId === 4) {
        ac += 2;
      }
    }
  }

  return ac;
}

function extractSpeed(data: Record<string, unknown>): number {
  // Check for walking speed in the race
  const race = data.race as Record<string, unknown> | undefined;
  if (race) {
    const weightSpeeds = race.weightSpeeds as Record<string, unknown> | undefined;
    if (weightSpeeds) {
      const normal = weightSpeeds.normal as Record<string, unknown> | undefined;
      if (normal?.walk != null) return normal.walk as number;
    }
  }

  // Fallback: check the top-level walkSpeed or default
  if (data.walkSpeed != null) return data.walkSpeed as number;
  return 30;
}

function extractSavingThrows(data: Record<string, unknown>): ('str' | 'dex' | 'con' | 'int' | 'wis' | 'cha')[] {
  const saves: ('str' | 'dex' | 'con' | 'int' | 'wis' | 'cha')[] = [];
  const modifiers = data.modifiers as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!modifiers) return saves;

  const allMods = [
    ...(modifiers.class ?? []),
    ...(modifiers.race ?? []),
    ...(modifiers.background ?? []),
    ...(modifiers.feat ?? []),
  ];

  const abilityShortNames = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const abilityLongNames = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

  for (const mod of allMods) {
    if ((mod.type as string) === 'proficiency' && (mod.subType as string)?.endsWith('-saving-throws')) {
      const abilityStr = (mod.subType as string).replace('-saving-throws', '');
      const idx = abilityLongNames.indexOf(abilityStr);
      const shortName = abilityShortNames[idx] as 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
      if (idx >= 0 && !saves.includes(shortName)) {
        saves.push(shortName);
      }
    }
  }

  return saves;
}

function extractSkills(data: Record<string, unknown>): Skills {
  const skills: Skills = {
    acrobatics: 'none', animalHandling: 'none', arcana: 'none', athletics: 'none',
    deception: 'none', history: 'none', insight: 'none', intimidation: 'none',
    investigation: 'none', medicine: 'none', nature: 'none', perception: 'none',
    performance: 'none', persuasion: 'none', religion: 'none', sleightOfHand: 'none',
    stealth: 'none', survival: 'none',
  };

  const modifiers = data.modifiers as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!modifiers) return skills;

  const allMods = [
    ...(modifiers.class ?? []),
    ...(modifiers.race ?? []),
    ...(modifiers.background ?? []),
    ...(modifiers.feat ?? []),
    ...(modifiers.item ?? []),
  ];

  // Map D&D Beyond subType names to our skill keys
  const skillMap: Record<string, keyof Skills> = {
    'acrobatics': 'acrobatics',
    'animal-handling': 'animalHandling',
    'arcana': 'arcana',
    'athletics': 'athletics',
    'deception': 'deception',
    'history': 'history',
    'insight': 'insight',
    'intimidation': 'intimidation',
    'investigation': 'investigation',
    'medicine': 'medicine',
    'nature': 'nature',
    'perception': 'perception',
    'performance': 'performance',
    'persuasion': 'persuasion',
    'religion': 'religion',
    'sleight-of-hand': 'sleightOfHand',
    'stealth': 'stealth',
    'survival': 'survival',
  };

  for (const mod of allMods) {
    const modType = mod.type as string;
    const subType = mod.subType as string;
    if (!subType) continue;

    for (const [ddbName, skillKey] of Object.entries(skillMap)) {
      if (subType === ddbName) {
        if (modType === 'expertise') {
          skills[skillKey] = 'expertise';
        } else if (modType === 'proficiency' && skills[skillKey] !== 'expertise') {
          skills[skillKey] = 'proficient';
        }
      }
    }
  }

  return skills;
}

function extractSpellSlots(data: Record<string, unknown>): Record<number, SpellSlot> {
  const slots: Record<number, SpellSlot> = {};
  const classes = data.classes as Array<Record<string, unknown>> | undefined;
  if (!classes) return slots;

  // Determine caster level and slot table
  let casterLevel = 0;
  for (const cls of classes) {
    const def = cls.definition as Record<string, unknown> | undefined;
    if (!def) continue;
    const canCastSpells = def.canCastSpells as boolean;
    const spellCasting = def.spellCastingAbilityId as number | undefined;
    if (canCastSpells || spellCasting != null) {
      // Full caster
      const spellRules = cls.subclassDefinition as Record<string, unknown> | undefined;
      const isHalfCaster = def.name === 'Paladin' || def.name === 'Ranger';
      const level = cls.level as number ?? 1;
      casterLevel += isHalfCaster ? Math.floor(level / 2) : level;
    }
  }

  if (casterLevel === 0) return slots;

  // Standard spell slot table (simplified)
  const slotTable: Record<number, number[]> = {
    1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2],
    6: [4, 3, 3], 7: [4, 3, 3, 1], 8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1],
    10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1], 12: [4, 3, 3, 3, 2, 1],
    13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1],
    15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1],
    17: [4, 3, 3, 3, 2, 1, 1, 1, 1], 18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
    19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
  };

  const table = slotTable[Math.min(casterLevel, 20)] ?? slotTable[1];
  for (let i = 0; i < table.length; i++) {
    slots[i + 1] = { max: table[i], used: 0 };
  }

  // Check for used spell slots
  const spellSlots = data.spellSlots as Array<Record<string, unknown>> | undefined;
  if (spellSlots && Array.isArray(spellSlots)) {
    for (const slot of spellSlots) {
      const level = slot.level as number;
      const used = slot.used as number;
      if (slots[level]) {
        slots[level].used = used;
      }
    }
  }

  return slots;
}

function extractSpells(data: Record<string, unknown>): Spell[] {
  const spells: Spell[] = [];
  const classSpells = data.classSpells as Array<Record<string, unknown>> | undefined;
  const spellsList = data.spells as Record<string, Array<Record<string, unknown>>> | undefined;

  const rawSpells: Array<Record<string, unknown>> = [];

  if (classSpells && Array.isArray(classSpells)) {
    for (const cs of classSpells) {
      const spellList = cs.spells as Array<Record<string, unknown>> | undefined;
      if (spellList) rawSpells.push(...spellList);
    }
  }

  if (spellsList) {
    for (const list of Object.values(spellsList)) {
      if (Array.isArray(list)) rawSpells.push(...list);
    }
  }

  for (const raw of rawSpells) {
    const def = (raw.definition as Record<string, unknown>) ?? raw;
    if (!def.name) continue;

    // Extract higher levels description
    let higherLevels = '';
    const atHigherLevels = def.atHigherLevels as Record<string, unknown> | undefined;
    if (atHigherLevels) {
      const higherLevelDefs = atHigherLevels.higherLevelDefinitions as Array<Record<string, unknown>> | undefined;
      if (higherLevelDefs && higherLevelDefs.length > 0) {
        higherLevels = (higherLevelDefs[0].description as string) ?? '';
      }
    }

    // Extract attack type
    let attackType = '';
    const rawAttackType = def.attackType as number | undefined;
    if (rawAttackType === 1) attackType = 'melee';
    else if (rawAttackType === 2) attackType = 'ranged';

    const spell: Spell = {
      name: def.name as string,
      level: (def.level as number) ?? 0,
      school: (def.school as string) ?? '',
      castingTime: formatCastingTime(def),
      range: formatRange(def),
      components: formatComponents(def),
      duration: formatDuration(def),
      description: (def.description as string) ?? '',
      isConcentration: (def.concentration as boolean) ?? false,
      isRitual: (def.ritual as boolean) ?? false,
      higherLevels,
      attackType,
    };

    // Extract damage if available
    if (def.damage) {
      const dmg = def.damage as Record<string, unknown>;
      const diceStr = dmg.diceString as string;
      if (diceStr) spell.damage = diceStr;
      const dmgType = (dmg.damageType as Record<string, unknown>)?.name as string;
      if (dmgType) spell.damageType = dmgType;
    }

    // Extract saving throw
    if (def.saveDcAbilityId) {
      const abilityMap: Record<number, string> = { 1: 'str', 2: 'dex', 3: 'con', 4: 'int', 5: 'wis', 6: 'cha' };
      const saveAbility = abilityMap[def.saveDcAbilityId as number];
      if (saveAbility) spell.savingThrow = saveAbility as Spell['savingThrow'];
    }

    // Extract AoE
    if (def.range && typeof def.range === 'object') {
      const rangeObj = def.range as Record<string, unknown>;
      const aoe = rangeObj.aoeType as string | undefined;
      const aoeSize = rangeObj.aoeSize as number | undefined;
      if (aoe) {
        const aoeMap: Record<string, Spell['aoeType']> = {
          'Cone': 'cone', 'Sphere': 'sphere', 'Line': 'line',
          'Cube': 'cube', 'Cylinder': 'cylinder',
        };
        spell.aoeType = aoeMap[aoe];
        spell.aoeSize = aoeSize;
      }
    }

    spells.push(spell);
  }

  return spells;
}

function formatCastingTime(def: Record<string, unknown>): string {
  const activation = def.activation as Record<string, unknown> | undefined;
  if (!activation) return '1 action';
  const time = activation.activationTime as number ?? 1;
  const type = activation.activationType as number ?? 1;
  const typeMap: Record<number, string> = {
    1: 'action', 2: 'bonus action', 3: 'reaction',
    4: 'minute', 5: 'hour', 6: 'no action',
  };
  const typeName = typeMap[type] ?? 'action';
  return time > 1 ? `${time} ${typeName}s` : `${time} ${typeName}`;
}

function formatRange(def: Record<string, unknown>): string {
  const range = def.range as Record<string, unknown> | undefined;
  if (!range) return 'Self';
  const origin = range.origin as string;
  const value = range.rangeValue as number | undefined;
  if (origin === 'Self') return 'Self';
  if (origin === 'Touch') return 'Touch';
  if (value) return `${value} ft`;
  return 'Self';
}

function formatComponents(def: Record<string, unknown>): string {
  const parts: string[] = [];
  const components = def.components as number[] | undefined;
  if (components && Array.isArray(components)) {
    if (components.includes(1)) parts.push('V');
    if (components.includes(2)) parts.push('S');
    if (components.includes(3)) parts.push('M');
  }
  return parts.join(', ') || 'V, S';
}

function formatDuration(def: Record<string, unknown>): string {
  const duration = def.duration as Record<string, unknown> | undefined;
  if (!duration) return 'Instantaneous';
  const type = duration.durationType as string;
  const value = duration.durationInterval as number;
  const unit = duration.durationUnit as string;

  if (type === 'Instantaneous') return 'Instantaneous';
  if (type === 'Concentration') {
    return `Concentration, up to ${value} ${unit}${value > 1 ? 's' : ''}`;
  }
  if (value && unit) {
    return `${value} ${unit}${value > 1 ? 's' : ''}`;
  }
  return 'Instantaneous';
}

function extractFeatures(data: Record<string, unknown>): Feature[] {
  const features: Feature[] = [];

  // Race features
  const race = data.race as Record<string, unknown> | undefined;
  if (race) {
    const raceName = (race.baseName as string) ?? (race.fullName as string) ?? 'Race';
    const racialTraits = race.racialTraits as Array<Record<string, unknown>> | undefined;
    if (racialTraits) {
      for (const trait of racialTraits) {
        const def = trait.definition as Record<string, unknown> | undefined;
        const name = (def?.name as string) ?? (trait.name as string);
        if (name) {
          features.push({
            name,
            description: (def?.description as string) ?? '',
            source: raceName,
            sourceType: 'race',
          });
        }
      }
    }
  }

  // Class features (including subclass features)
  const classes = data.classes as Array<Record<string, unknown>> | undefined;
  if (classes) {
    for (const cls of classes) {
      const classDef = cls.definition as Record<string, unknown> | undefined;
      const className = (classDef?.name as string) ?? 'Class';

      // Main class features
      const classFeatures = cls.classFeatures as Array<Record<string, unknown>> | undefined;
      if (classFeatures) {
        for (const feat of classFeatures) {
          const def = feat.definition as Record<string, unknown> | undefined;
          const name = (def?.name as string) ?? (feat.name as string);
          if (name) {
            features.push({
              name,
              description: (def?.description as string) ?? '',
              source: className,
              sourceType: 'class',
            });
          }
        }
      }

      // Subclass features
      const subclassDef = cls.subclassDefinition as Record<string, unknown> | undefined;
      if (subclassDef) {
        const subclassName = (subclassDef.name as string) ?? className;
        const subclassFeatures = subclassDef.classFeatures as Array<Record<string, unknown>> | undefined;
        if (subclassFeatures) {
          for (const feat of subclassFeatures) {
            const name = (feat.name as string);
            if (name) {
              features.push({
                name,
                description: (feat.description as string) ?? '',
                source: subclassName,
                sourceType: 'class',
              });
            }
          }
        }
      }
    }
  }

  // Feats
  const feats = data.feats as Array<Record<string, unknown>> | undefined;
  if (feats) {
    for (const feat of feats) {
      const def = feat.definition as Record<string, unknown> | undefined;
      const name = (def?.name as string) ?? (feat.name as string);
      if (name) {
        features.push({
          name,
          description: (def?.description as string) ?? '',
          source: name,
          sourceType: 'feat',
        });
      }
    }
  }

  return features;
}

function extractInventory(data: Record<string, unknown>): InventoryItem[] {
  const items: InventoryItem[] = [];
  const inventory = data.inventory as Array<Record<string, unknown>> | undefined;
  if (!inventory || !Array.isArray(inventory)) return items;

  for (const item of inventory) {
    const def = item.definition as Record<string, unknown> | undefined;
    if (!def) continue;

    const filterType = def.filterType as string | undefined;
    const typeMap: Record<string, InventoryItem['type']> = {
      'Weapon': 'weapon', 'Armor': 'armor', 'Potion': 'potion',
      'Scroll': 'scroll', 'Wondrous item': 'gear',
    };

    const grantedModifiers = def.grantedModifiers as Array<Record<string, unknown>> | undefined;
    const properties: string[] = [];
    if (def.properties && Array.isArray(def.properties)) {
      for (const prop of def.properties as Array<Record<string, unknown>>) {
        const propName = prop.name as string;
        if (propName) properties.push(propName);
      }
    }
    if (grantedModifiers && Array.isArray(grantedModifiers)) {
      for (const gm of grantedModifiers) {
        const friendlySubType = gm.friendlySubtypeName as string;
        if (friendlySubType && !properties.includes(friendlySubType)) {
          properties.push(friendlySubType);
        }
      }
    }

    let itemDamage = '';
    let itemDamageType = '';
    if (def.damage) {
      const dmg = def.damage as Record<string, unknown>;
      itemDamage = (dmg.diceString as string) ?? '';
      const dmgTypeObj = dmg.damageType as Record<string, unknown> | undefined;
      itemDamageType = (dmgTypeObj?.name as string) ?? '';
    }

    // Build slug from DDB name for compendium matching
    const ddbName = (def.name as string) ?? 'Unknown Item';
    const ddbId = def.id as number | undefined;
    const nameSlug = ddbName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/'/g, '');

    // DDB name → compendium slug mapping for known mismatches
    const slugOverrides: Record<string, string> = {
      'leather': 'leather-armor', 'studded-leather': 'studded-leather-armor',
      'padded': 'padded-armor', 'hide': 'hide-armor',
      'chain-shirt': 'chain-shirt', 'chain-mail': 'chain-mail',
      'scale-mail': 'scale-mail', 'half-plate': 'half-plate',
      'ring-mail': 'ring-mail', 'splint': 'splint-armor',
      'plate': 'plate-armor', 'breastplate': 'breastplate',
      'rations': 'rations-1-day', 'oil': 'oil-flask',
      'crossbow-light': 'crossbow-light', 'crossbow-hand': 'crossbow-hand',
      'crossbow-heavy': 'crossbow-heavy',
      'rope-hempen-50-feet': 'rope-hempen-50-feet',
      'rope-silk-50-feet': 'rope-silk-50-feet',
    };

    const slug = slugOverrides[nameSlug] || nameSlug;
    const imageUrl = `/uploads/items/${slug}.png`;

    items.push({
      name: ddbName,
      quantity: (item.quantity as number) ?? 1,
      weight: (def.weight as number) ?? 0,
      description: (def.description as string) ?? '',
      equipped: (item.equipped as boolean) ?? false,
      type: typeMap[filterType ?? ''] ?? 'gear',
      cost: (def.cost as number) ?? 0,
      attunement: (def.canAttune as boolean) ?? false,
      attuned: (def.isAttuned as boolean) ?? false,
      properties,
      damage: itemDamage,
      damageType: itemDamageType,
      rarity: 'common',
      slug,
      imageUrl,
    } as any);
  }

  return items;
}

function getAllModifiers(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const modifiers = data.modifiers as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!modifiers) return [];
  return [
    ...(modifiers.race ?? []),
    ...(modifiers.class ?? []),
    ...(modifiers.background ?? []),
    ...(modifiers.item ?? []),
    ...(modifiers.feat ?? []),
    ...(modifiers.condition ?? []),
  ];
}

function extractBackground(data: Record<string, unknown>): CharacterBackground {
  const result: CharacterBackground = { name: '', description: '', feature: '' };
  const bg = data.background as Record<string, unknown> | undefined;
  if (!bg) return result;

  const def = bg.definition as Record<string, unknown> | undefined;
  if (def) {
    result.name = (def.name as string) ?? '';
    result.description = (def.description as string) ?? '';
    // The feature is often in featureDescription or the first feature
    result.feature = (def.featureDescription as string) ?? (def.shortDescription as string) ?? '';
  }

  // Fallback: check hasCustomBackground
  if (!result.name && bg.hasCustomBackground) {
    result.name = (bg.customBackground as Record<string, unknown>)?.name as string ?? 'Custom';
  }

  return result;
}

function extractCharacteristics(data: Record<string, unknown>): CharacterCharacteristics {
  const result: CharacterCharacteristics = {
    alignment: '', gender: '', eyes: '', hair: '', skin: '',
    height: '', weight: '', age: '', faith: '', size: 'Medium',
  };

  // Alignment
  const alignmentId = data.alignmentId as number | undefined;
  const alignmentMap: Record<number, string> = {
    1: 'Lawful Good', 2: 'Neutral Good', 3: 'Chaotic Good',
    4: 'Lawful Neutral', 5: 'True Neutral', 6: 'Chaotic Neutral',
    7: 'Lawful Evil', 8: 'Neutral Evil', 9: 'Chaotic Evil',
  };
  if (alignmentId != null) result.alignment = alignmentMap[alignmentId] ?? '';

  // Traits contain appearance and bio info
  const traits = data.traits as Record<string, unknown> | undefined;
  if (traits) {
    result.gender = (traits.gender as string) ?? '';
    result.eyes = (traits.eyes as string) ?? '';
    result.hair = (traits.hair as string) ?? '';
    result.skin = (traits.skin as string) ?? '';
    result.height = (traits.height as string) ?? '';
    result.weight = (traits.weight as string) ?? '';
    result.age = (traits.age as string) ?? '';
    result.faith = (traits.faith as string) ?? '';
  }

  // Size from race
  const race = data.race as Record<string, unknown> | undefined;
  if (race) {
    const sizeId = race.size as number | string | undefined;
    if (typeof sizeId === 'string') {
      result.size = sizeId;
    } else if (typeof sizeId === 'number') {
      const sizeMap: Record<number, string> = {
        2: 'Tiny', 3: 'Small', 4: 'Medium', 5: 'Large', 6: 'Huge', 7: 'Gargantuan',
      };
      result.size = sizeMap[sizeId] ?? 'Medium';
    }
    // Also check race.sizeId
    const raceSizeId = race.sizeId as number | undefined;
    if (raceSizeId != null && !result.size) {
      const sizeMap: Record<number, string> = {
        2: 'Tiny', 3: 'Small', 4: 'Medium', 5: 'Large', 6: 'Huge', 7: 'Gargantuan',
      };
      result.size = sizeMap[raceSizeId] ?? 'Medium';
    }
  }

  return result;
}

function extractPersonality(data: Record<string, unknown>): CharacterPersonality {
  const result: CharacterPersonality = { traits: '', ideals: '', bonds: '', flaws: '' };
  const traits = data.traits as Record<string, unknown> | undefined;
  if (!traits) return result;

  result.traits = (traits.personalityTraits as string) ?? '';
  result.ideals = (traits.ideals as string) ?? '';
  result.bonds = (traits.bonds as string) ?? '';
  result.flaws = (traits.flaws as string) ?? '';

  return result;
}

function extractNotes(data: Record<string, unknown>): CharacterNotes {
  const result: CharacterNotes = { organizations: '', allies: '', enemies: '', backstory: '', other: '' };
  const notes = data.notes as Record<string, unknown> | undefined;
  if (!notes) return result;

  result.organizations = (notes.organizations as string) ?? '';
  result.allies = (notes.allies as string) ?? '';
  result.enemies = (notes.enemies as string) ?? '';
  result.backstory = (notes.backstory as string) ?? '';
  result.other = (notes.otherNotes as string) ?? '';

  return result;
}

function extractProficiencies(data: Record<string, unknown>): CharacterProficiencies {
  const result: CharacterProficiencies = { armor: [], weapons: [], tools: [], languages: [] };
  const allMods = getAllModifiers(data);

  for (const mod of allMods) {
    const modType = mod.type as string;
    const subType = (mod.subType as string) ?? '';
    const friendlySubType = (mod.friendlySubtypeName as string) ?? '';

    if (modType === 'proficiency') {
      if (subType.includes('armor') || friendlySubType.toLowerCase().includes('armor')) {
        const name = friendlySubType || subType;
        if (name && !result.armor.includes(name)) result.armor.push(name);
      } else if (subType.includes('weapon') || friendlySubType.toLowerCase().includes('weapon')) {
        const name = friendlySubType || subType;
        if (name && !result.weapons.includes(name)) result.weapons.push(name);
      } else if (subType.includes('tool') || subType.includes('kit') || subType.includes('supplies') ||
                 friendlySubType.toLowerCase().includes('tool') || friendlySubType.toLowerCase().includes('kit')) {
        const name = friendlySubType || subType;
        if (name && !result.tools.includes(name)) result.tools.push(name);
      } else if (subType.includes('language')) {
        const name = friendlySubType || subType;
        if (name && !result.languages.includes(name)) result.languages.push(name);
      }
    }
  }

  // Also check for language modifiers with type 'language'
  for (const mod of allMods) {
    const modType = mod.type as string;
    if (modType === 'language') {
      const friendlySubType = (mod.friendlySubtypeName as string) ?? (mod.subType as string) ?? '';
      if (friendlySubType && !result.languages.includes(friendlySubType)) {
        result.languages.push(friendlySubType);
      }
    }
  }

  // Custom proficiencies
  const customProfs = data.customProficiencies as Array<Record<string, unknown>> | undefined;
  if (customProfs && Array.isArray(customProfs)) {
    for (const cp of customProfs) {
      const name = (cp.name as string) ?? '';
      const typeId = cp.type as number | undefined;
      if (!name) continue;
      // type 1=armor, 2=weapon, 3=tool, 4=language (approximate)
      if (typeId === 1 && !result.armor.includes(name)) result.armor.push(name);
      else if (typeId === 2 && !result.weapons.includes(name)) result.weapons.push(name);
      else if (typeId === 3 && !result.tools.includes(name)) result.tools.push(name);
      else if (typeId === 4 && !result.languages.includes(name)) result.languages.push(name);
    }
  }

  return result;
}

function extractSenses(
  data: Record<string, unknown>,
  abilityScores: AbilityScores,
  skills: Skills,
  profBonus: number,
): CharacterSenses {
  const wisMod = abilityModifier(abilityScores.wis);
  const intMod = abilityModifier(abilityScores.int);

  const profMultiplier = (skill: SkillProficiency): number => {
    if (skill === 'expertise') return 2;
    if (skill === 'proficient') return 1;
    return 0;
  };

  const passivePerception = 10 + wisMod + (profMultiplier(skills.perception) * profBonus);
  const passiveInvestigation = 10 + intMod + (profMultiplier(skills.investigation) * profBonus);
  const passiveInsight = 10 + wisMod + (profMultiplier(skills.insight) * profBonus);

  // Check for darkvision from race traits or modifiers
  let darkvision = 0;
  const allMods = getAllModifiers(data);
  for (const mod of allMods) {
    const subType = (mod.subType as string) ?? '';
    if (subType === 'darkvision') {
      const value = (mod.value as number) ?? 60;
      darkvision = Math.max(darkvision, value);
    }
  }

  // Also check race racial traits for darkvision
  const race = data.race as Record<string, unknown> | undefined;
  if (race) {
    const racialTraits = race.racialTraits as Array<Record<string, unknown>> | undefined;
    if (racialTraits) {
      for (const trait of racialTraits) {
        const def = trait.definition as Record<string, unknown> | undefined;
        const name = ((def?.name as string) ?? '').toLowerCase();
        if (name.includes('darkvision') || name.includes('superior darkvision')) {
          darkvision = Math.max(darkvision, name.includes('superior') ? 120 : 60);
        }
      }
    }
  }

  return { passivePerception, passiveInvestigation, passiveInsight, darkvision };
}

function extractDefenses(data: Record<string, unknown>): CharacterDefenses {
  const result: CharacterDefenses = { resistances: [], immunities: [], vulnerabilities: [] };
  const allMods = getAllModifiers(data);

  for (const mod of allMods) {
    const modType = mod.type as string;
    const subType = (mod.subType as string) ?? '';
    const friendlySubType = (mod.friendlySubtypeName as string) ?? subType;

    if (modType === 'resistance' && friendlySubType) {
      if (!result.resistances.includes(friendlySubType)) result.resistances.push(friendlySubType);
    } else if (modType === 'immunity' && friendlySubType) {
      if (!result.immunities.includes(friendlySubType)) result.immunities.push(friendlySubType);
    } else if (modType === 'vulnerability' && friendlySubType) {
      if (!result.vulnerabilities.includes(friendlySubType)) result.vulnerabilities.push(friendlySubType);
    }
  }

  return result;
}

function extractCurrency(data: Record<string, unknown>): CharacterCurrency {
  const result: CharacterCurrency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const currencies = data.currencies as Record<string, unknown> | undefined;
  if (!currencies) return result;

  result.cp = (currencies.cp as number) ?? 0;
  result.sp = (currencies.sp as number) ?? 0;
  result.ep = (currencies.ep as number) ?? 0;
  result.gp = (currencies.gp as number) ?? 0;
  result.pp = (currencies.pp as number) ?? 0;

  return result;
}

function extractExtras(data: Record<string, unknown>): string[] {
  const extras: string[] = [];
  const creatures = data.creatures as Array<Record<string, unknown>> | undefined;
  if (creatures && Array.isArray(creatures)) {
    for (const creature of creatures) {
      const name = (creature.name as string) ?? '';
      if (name) extras.push(name);
    }
  }
  const companions = data.companions as Array<Record<string, unknown>> | undefined;
  if (companions && Array.isArray(companions)) {
    for (const companion of companions) {
      const name = (companion.name as string) ?? '';
      if (name) extras.push(name);
    }
  }
  return extras;
}

function extractSpellcasting(
  data: Record<string, unknown>,
  abilityScores: AbilityScores,
  profBonus: number,
): { spellcastingAbility: string; spellAttackBonus: number; spellSaveDC: number } {
  const classes = data.classes as Array<Record<string, unknown>> | undefined;
  if (!classes || !Array.isArray(classes)) {
    return { spellcastingAbility: '', spellAttackBonus: 0, spellSaveDC: 10 };
  }

  const abilityIdMap: Record<number, keyof AbilityScores> = {
    1: 'str', 2: 'dex', 3: 'con', 4: 'int', 5: 'wis', 6: 'cha',
  };

  for (const cls of classes) {
    const def = cls.definition as Record<string, unknown> | undefined;
    if (!def) continue;
    const spellCastingAbilityId = def.spellCastingAbilityId as number | undefined;
    if (spellCastingAbilityId == null) continue;

    const abilityKey = abilityIdMap[spellCastingAbilityId];
    if (!abilityKey) continue;

    const mod = abilityModifier(abilityScores[abilityKey]);
    return {
      spellcastingAbility: abilityKey,
      spellAttackBonus: mod + profBonus,
      spellSaveDC: 8 + mod + profBonus,
    };
  }

  return { spellcastingAbility: '', spellAttackBonus: 0, spellSaveDC: 10 };
}

function extractInitiative(data: Record<string, unknown>, abilityScores: AbilityScores): number {
  const dexMod = abilityModifier(abilityScores.dex);
  let bonus = 0;

  // Check for initiative bonuses in modifiers
  const allMods = getAllModifiers(data);
  for (const mod of allMods) {
    const modType = mod.type as string;
    const subType = (mod.subType as string) ?? '';
    if (modType === 'bonus' && subType === 'initiative') {
      bonus += (mod.value as number) ?? 0;
    }
  }

  return dexMod + bonus;
}
