export function safeJsonParse(value: unknown, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function dbRowToCharacter(row: Record<string, unknown>) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    race: row.race,
    class: row.class,
    level: row.level,
    hitPoints: row.hit_points,
    maxHitPoints: row.max_hit_points,
    tempHitPoints: row.temp_hit_points,
    armorClass: row.armor_class,
    speed: row.speed,
    proficiencyBonus: row.proficiency_bonus,
    abilityScores: safeJsonParse(row.ability_scores, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
    savingThrows: safeJsonParse(row.saving_throws, []),
    skills: safeJsonParse(row.skills, {}),
    spellSlots: safeJsonParse(row.spell_slots, {}),
    spells: safeJsonParse(row.spells, []),
    features: safeJsonParse(row.features, []),
    inventory: safeJsonParse(row.inventory, []),
    deathSaves: safeJsonParse(row.death_saves, { successes: 0, failures: 0 }),
    hitDice: safeJsonParse(row.hit_dice, []),
    concentratingOn: row.concentrating_on ?? null,
    background: safeJsonParse(row.background, { name: '', description: '', feature: '' }),
    characteristics: safeJsonParse(row.characteristics, { alignment: '', gender: '', eyes: '', hair: '', skin: '', height: '', weight: '', age: '', faith: '', size: 'Medium' }),
    personality: safeJsonParse(row.personality, { traits: '', ideals: '', bonds: '', flaws: '' }),
    notes: safeJsonParse(row.notes_data, { organizations: '', allies: '', enemies: '', backstory: '', other: '' }),
    proficiencies: safeJsonParse(row.proficiencies_data, { armor: [], weapons: [], tools: [], languages: [] }),
    senses: safeJsonParse(row.senses, { passivePerception: 10, passiveInvestigation: 10, passiveInsight: 10, darkvision: 0 }),
    defenses: safeJsonParse(row.defenses, { resistances: [], immunities: [], vulnerabilities: [] }),
    conditions: safeJsonParse(row.conditions, []),
    currency: safeJsonParse(row.currency, { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }),
    extras: safeJsonParse(row.extras, []),
    spellcastingAbility: row.spellcasting_ability ?? '',
    spellAttackBonus: row.spell_attack_bonus ?? 0,
    spellSaveDC: row.spell_save_dc ?? 10,
    initiative: row.initiative ?? 0,
    compendiumSlug: row.compendium_slug ?? null,
    portraitUrl: row.portrait_url,
    dndbeyondId: row.dndbeyond_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
