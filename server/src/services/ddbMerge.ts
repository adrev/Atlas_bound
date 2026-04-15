/**
 * D&D Beyond character re-import merge.
 *
 * When a user re-imports an existing DDB character (e.g. they levelled
 * up on dndbeyond.com and want their VTT sheet to reflect that), we
 * want the import to UPDATE the existing row in place instead of
 * silently creating a duplicate. That's a UX must — otherwise the
 * user ends up with "Liraya Voss (1)", "Liraya Voss (2)", … each
 * session.
 *
 * Merge strategy (opinionated, but matches what players actually want):
 *
 *   REPLACED from DDB:
 *     name, race, class, level, max_hit_points, armor_class, speed,
 *     proficiency_bonus, ability_scores, saving_throws, skills,
 *     portrait_url, background, characteristics, personality, notes_data,
 *     proficiencies_data, senses, defenses, currency, extras,
 *     spellcasting_ability, spell_attack_bonus, spell_save_dc,
 *     initiative, spells (fresh list), features (fresh list),
 *     inventory (fresh list), dndbeyond_json (latest blob).
 *
 *   PRESERVED from VTT session state:
 *     hit_points (clamped to new max), temp_hit_points, death_saves,
 *     concentrating_on, conditions.
 *
 *   MERGED (structure from DDB + per-entity usage from VTT):
 *     hit_dice           — new totals, preserved `used` per die size
 *     spell_slots        — new totals, preserved `used` per level
 *     features           — new definitions, preserved `usesRemaining`
 *                          for matching feature names (clamped to
 *                          the new usesTotal to avoid over-filling
 *                          when DDB lowered a cap).
 */

export interface MergeInputs {
  /** Row currently in the DB (raw postgres result). */
  existing: Record<string, unknown>;
  /** Parsed Character object from parseCharacterJSON. */
  incoming: Record<string, unknown>;
  /** Full raw DDB JSON to stash in dndbeyond_json. */
  raw: unknown;
}

/**
 * Build the SQL SET-list and parameter array for a merge UPDATE. The
 * caller runs the UPDATE itself (different routes have different
 * auth / response shapes).
 *
 * Returns an object with:
 *   columns: string[]  — column names for SET clause
 *   values:  unknown[] — matching values, JSON-stringified where the
 *                        column stores JSON
 *
 * The row `id` is NOT returned — the caller already has it.
 */
export function buildMergeUpdate({ existing, incoming, raw }: MergeInputs): {
  columns: string[];
  values: unknown[];
} {
  const columns: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => { columns.push(col); values.push(v); };

  // --- REPLACED fields ---
  set('name', incoming.name);
  set('race', incoming.race);
  set('class', incoming.class);
  set('level', incoming.level);
  set('max_hit_points', incoming.maxHitPoints);
  set('armor_class', incoming.armorClass);
  set('speed', incoming.speed);
  set('proficiency_bonus', incoming.proficiencyBonus);
  set('ability_scores', JSON.stringify(incoming.abilityScores));
  set('saving_throws', JSON.stringify(incoming.savingThrows));
  set('skills', JSON.stringify(incoming.skills));
  set('portrait_url', incoming.portraitUrl);
  set('dndbeyond_json', JSON.stringify(raw));
  set('background', JSON.stringify(incoming.background));
  set('characteristics', JSON.stringify(incoming.characteristics));
  set('personality', JSON.stringify(incoming.personality));
  set('notes_data', JSON.stringify(incoming.notes));
  set('proficiencies_data', JSON.stringify(incoming.proficiencies));
  set('senses', JSON.stringify(incoming.senses));
  set('defenses', JSON.stringify(incoming.defenses));
  set('currency', JSON.stringify(incoming.currency));
  set('extras', JSON.stringify(incoming.extras));
  set('spellcasting_ability', incoming.spellcastingAbility);
  set('spell_attack_bonus', incoming.spellAttackBonus);
  set('spell_save_dc', incoming.spellSaveDC);
  set('initiative', incoming.initiative);
  set('spells', JSON.stringify(incoming.spells));
  set('inventory', JSON.stringify(incoming.inventory));

  // --- PRESERVED fields (no column in SET, value stays as-is) ---
  // (These are intentionally left out so the existing row values
  // remain. hit_points still needs clamping though — see below.)

  // Clamp hit_points to the new max so a level-down or HP-down on
  // DDB doesn't leave the character over-healed.
  const oldHp = Number(existing.hit_points ?? 0);
  const newMax = Number(incoming.maxHitPoints ?? 0);
  set('hit_points', Math.max(0, Math.min(oldHp, newMax)));

  // --- MERGED fields ---
  set('hit_dice', JSON.stringify(
    mergeHitDice(
      parseJson(existing.hit_dice, [] as Array<{ dieSize: number; total: number; used: number }>),
      incoming.hitDice as Array<{ dieSize: number; total: number; used: number }> | undefined ?? [],
    ),
  ));

  set('spell_slots', JSON.stringify(
    mergeSpellSlots(
      parseJson(existing.spell_slots, {} as Record<string, { max: number; used: number }>),
      incoming.spellSlots as Record<string, { max: number; used: number }> | undefined ?? {},
    ),
  ));

  set('features', JSON.stringify(
    mergeFeatures(
      parseJson(existing.features, [] as Array<FeatureShape>),
      incoming.features as Array<FeatureShape> | undefined ?? [],
    ),
  ));

  return { columns, values };
}

type FeatureShape = {
  name: string;
  usesTotal?: number;
  usesRemaining?: number;
  resetOn?: string | null;
  [k: string]: unknown;
};

// -- helpers -------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return raw as T;
}

export function mergeHitDice(
  old: Array<{ dieSize: number; total: number; used: number }>,
  incoming: Array<{ dieSize: number; total: number; used: number }>,
): Array<{ dieSize: number; total: number; used: number }> {
  // Preserve `used` per die size, clamped to the new total.
  const oldByDie = new Map(old.map((p) => [p.dieSize, p]));
  return incoming.map((p) => {
    const prev = oldByDie.get(p.dieSize);
    const used = prev ? Math.min(prev.used, p.total) : 0;
    return { dieSize: p.dieSize, total: p.total, used };
  });
}

export function mergeSpellSlots(
  old: Record<string, { max: number; used: number }>,
  incoming: Record<string, { max: number; used: number }>,
): Record<string, { max: number; used: number }> {
  const out: Record<string, { max: number; used: number }> = {};
  for (const [lvl, slot] of Object.entries(incoming)) {
    const prev = old[lvl];
    const used = prev ? Math.min(prev.used, slot.max) : 0;
    out[lvl] = { max: slot.max, used };
  }
  return out;
}

export function mergeFeatures(
  old: FeatureShape[],
  incoming: FeatureShape[],
): FeatureShape[] {
  // Case-insensitive name match for preservation — class features
  // don't usually get renamed between levels.
  const oldByName = new Map(old.map((f) => [f.name.toLowerCase(), f]));
  return incoming.map((f) => {
    const prev = oldByName.get(f.name.toLowerCase());
    if (!prev) return f;
    // Take the incoming feature shape (new `usesTotal`, updated `desc`,
    // etc.) but preserve the usesRemaining count clamped to the new max.
    const usesTotal = f.usesTotal ?? prev.usesTotal;
    const prevRem = prev.usesRemaining ?? prev.usesTotal ?? 0;
    const usesRemaining = typeof usesTotal === 'number'
      ? Math.max(0, Math.min(prevRem, usesTotal))
      : prev.usesRemaining;
    return { ...f, usesRemaining };
  });
}
