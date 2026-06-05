import {
  SKILL_ABILITY_MAP,
  abilityModifier,
  type AbilityName,
  type Skills,
  type SkillProficiency,
} from '@dnd-vtt/shared';

/**
 * Ability/skill check resolver — the engine behind `!check`.
 *
 * 5e has no first-class "roll a check" path in this app yet: skills,
 * expertise, and ability mods all exist as character data but nothing
 * actually rolls one. This module computes the modifier (ability mod +
 * proficiency/expertise, plus Bard Jack-of-All-Trades) and rolls the
 * d20 (advantage/disadvantage, plus Rogue Reliable Talent), mirroring
 * the existing save resolver in `saveRoll.ts`.
 *
 * Pure + RNG-injectable so the math is unit-tested without booting the
 * socket pipeline.
 */

export type Advantage = 'normal' | 'advantage' | 'disadvantage';

export const ABILITY_NAMES: AbilityName[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export type CheckTarget =
  | { kind: 'skill'; skill: keyof Skills; ability: AbilityName }
  | { kind: 'ability'; ability: AbilityName };

// Canonical lowercase, space-stripped forms of each skill key, plus a
// few short aliases players are likely to type. Built from the shared
// SKILL_ABILITY_MAP so it can never drift from the skill list.
const SKILL_ALIASES: Record<string, keyof Skills> = (() => {
  const map: Record<string, keyof Skills> = {};
  for (const key of Object.keys(SKILL_ABILITY_MAP) as (keyof Skills)[]) {
    map[key.toLowerCase()] = key; // e.g. "animalhandling", "sleightofhand"
  }
  Object.assign(map, {
    acro: 'acrobatics',
    animal: 'animalHandling',
    ah: 'animalHandling',
    ath: 'athletics',
    decep: 'deception',
    hist: 'history',
    intim: 'intimidation',
    invest: 'investigation',
    investigate: 'investigation',
    med: 'medicine',
    perc: 'perception',
    perform: 'performance',
    persuade: 'persuasion',
    pers: 'persuasion',
    rel: 'religion',
    sleight: 'sleightOfHand',
    soh: 'sleightOfHand',
    surv: 'survival',
  } satisfies Record<string, keyof Skills>);
  return map;
})();

/** Parse a user token like "perception" / "soh" / "dex" into a check target. */
export function parseCheckTarget(input: string): CheckTarget | null {
  const needle = input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if ((ABILITY_NAMES as string[]).includes(needle)) {
    return { kind: 'ability', ability: needle as AbilityName };
  }
  const skill = SKILL_ALIASES[needle];
  if (skill) return { kind: 'skill', skill, ability: SKILL_ABILITY_MAP[skill] };
  return null;
}

function classIncludes(className: string, needle: string): boolean {
  return className.toLowerCase().includes(needle);
}

/** Bard adds half proficiency (rounded down) to checks lacking proficiency. */
export function jackOfAllTradesBonus(
  className: string,
  profBonus: number,
  proficient: boolean
): number {
  if (proficient) return 0;
  if (!classIncludes(className, 'bard')) return 0;
  return Math.floor(profBonus / 2);
}

/** Rogue 11+ may treat a d20 below 10 as a 10 on proficient checks. */
export function isReliableTalent(className: string, level: number, proficient: boolean): boolean {
  return proficient && level >= 11 && classIncludes(className, 'rogue');
}

export interface CheckModifierResult {
  total: number;
  ability: AbilityName;
  proficiency: SkillProficiency;
  proficient: boolean;
  parts: Array<{ label: string; value: number }>;
}

export function computeCheckModifier(args: {
  target: CheckTarget;
  scores: Record<string, number>;
  skills: Partial<Record<keyof Skills, SkillProficiency>>;
  profBonus: number;
  className: string;
  flatBonus?: number;
}): CheckModifierResult {
  const { target, scores, skills, profBonus, className } = args;
  const ability = target.ability;
  const abilityScore = scores[ability] ?? 10;
  const abilityMod = abilityModifier(abilityScore);

  const proficiency: SkillProficiency =
    target.kind === 'skill' ? (skills[target.skill] ?? 'none') : 'none';
  const proficient = proficiency === 'proficient' || proficiency === 'expertise';
  const profValue =
    proficiency === 'expertise' ? profBonus * 2 : proficiency === 'proficient' ? profBonus : 0;
  const joat = jackOfAllTradesBonus(className, profBonus, proficient);
  const flat = args.flatBonus ?? 0;

  const parts: Array<{ label: string; value: number }> = [
    { label: `${ability.toUpperCase()} mod`, value: abilityMod },
  ];
  if (profValue !== 0)
    parts.push({
      label: proficiency === 'expertise' ? 'Expertise' : 'Proficiency',
      value: profValue,
    });
  if (joat !== 0) parts.push({ label: 'Jack of All Trades', value: joat });
  if (flat !== 0) parts.push({ label: 'Bonus', value: flat });

  return {
    total: abilityMod + profValue + joat + flat,
    ability,
    proficiency,
    proficient,
    parts,
  };
}

/**
 * Combine an explicit adv/dis flag with condition-driven disadvantage.
 * Poisoned, Frightened, and any level of Exhaustion impose disadvantage
 * on ability checks. Per RAW, any advantage + any disadvantage cancel to
 * a normal single roll.
 */
export function resolveCheckAdvantage(args: {
  explicit: Advantage;
  conditions: string[];
  exhaustion: number;
}): { effective: Advantage; disadvantageSources: string[] } {
  const conds = args.conditions.map((c) => c.toLowerCase());
  const disadvantageSources: string[] = [];
  if (conds.includes('poisoned')) disadvantageSources.push('poisoned');
  if (conds.includes('frightened')) disadvantageSources.push('frightened');
  if (args.exhaustion >= 1) disadvantageSources.push('exhaustion');

  const hasAdv = args.explicit === 'advantage';
  const hasDis = args.explicit === 'disadvantage' || disadvantageSources.length > 0;
  const effective: Advantage =
    hasAdv && hasDis ? 'normal' : hasAdv ? 'advantage' : hasDis ? 'disadvantage' : 'normal';
  return { effective, disadvantageSources };
}

export interface RolledCheck {
  d20: number;
  d20Rolls?: number[];
  advantage: Advantage;
  reliableTalentApplied: boolean;
  total: number;
  rollText: string;
}

const d20 = (rng: () => number): number => Math.floor(rng() * 20) + 1;

export function rollCheck(args: {
  modifier: number;
  advantage: Advantage;
  reliableTalent: boolean;
  rng?: () => number;
}): RolledCheck {
  const rng = args.rng ?? Math.random;
  let kept: number;
  let d20Rolls: number[] | undefined;
  let rollText: string;

  if (args.advantage === 'advantage') {
    const r1 = d20(rng);
    const r2 = d20(rng);
    kept = Math.max(r1, r2);
    d20Rolls = [r1, r2];
    rollText = `[${r1},${r2}] adv keep ${kept}`;
  } else if (args.advantage === 'disadvantage') {
    const r1 = d20(rng);
    const r2 = d20(rng);
    kept = Math.min(r1, r2);
    d20Rolls = [r1, r2];
    rollText = `[${r1},${r2}] disadv keep ${kept}`;
  } else {
    kept = d20(rng);
    rollText = `${kept}`;
  }

  let reliableTalentApplied = false;
  if (args.reliableTalent && kept < 10) {
    kept = 10;
    reliableTalentApplied = true;
    rollText += ' → 10 (Reliable Talent)';
  }

  const sign = args.modifier >= 0 ? '+' : '−';
  const total = kept + args.modifier;
  return {
    d20: kept,
    d20Rolls,
    advantage: args.advantage,
    reliableTalentApplied,
    total,
    rollText: `d20=${rollText}${sign}${Math.abs(args.modifier)}=${total}`,
  };
}
