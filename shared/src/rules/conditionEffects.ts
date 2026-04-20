import type { Condition } from '../types/map.js';

/**
 * Pure data description of what each 5e condition does mechanically.
 * Consumed by the rules modifier pipeline so every attack / save /
 * action / movement path can make a single call and get the right
 * advantage / disadvantage / auto-fail / action-block result without
 * restating the condition table inline.
 *
 * Everything here is DATA — no functions, no side effects. The server
 * (authoritative) and the client (optimistic preview) both consult
 * the same record.
 */

export interface ConditionEffect {
  /** Short name tag for the condition (matches the Condition union). */
  name: Condition;
  /** When this condition is on the ROLLING creature, how its own rolls react. */
  selfAttack?: 'advantage' | 'disadvantage';
  /** When this condition is on the TARGET of a roll, how attacks against them react. */
  attacksAgainst?: 'advantage' | 'disadvantage';
  /**
   * A melee attack that hits the target at 5 ft range is an automatic
   * critical hit. Applies to paralyzed, unconscious, petrified (kinda —
   * petrified has resistance too but the auto-crit stacks).
   */
  meleeCritWithin5ft?: boolean;
  /** Auto-fail ability checks that require sight. */
  autoFailSightChecks?: boolean;
  /** Auto-fail ability checks that require hearing. */
  autoFailHearingChecks?: boolean;
  /** Auto-fail saving throws on this list of abilities. */
  autoFailSaves?: Array<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'>;
  /** Disadvantage on ability checks. */
  disadvantageAbilityChecks?: boolean;
  /** Disadvantage on attacks — covered by selfAttack but split here for clarity when the rule fires only for attack rolls. */
  disadvantageOwnRolls?: { attacks?: boolean; checks?: boolean; saves?: boolean };
  /** Speed modifier: 0 = immobile, 0.5 = half, 1 = normal (default). */
  speedMultiplier?: number;
  /** Blocks the `action` slot (incapacitated-family conditions). */
  blocksActions?: boolean;
  /** Blocks the `reaction` slot. */
  blocksReactions?: boolean;
  /** Blocks the bonus action slot. */
  blocksBonusActions?: boolean;
  /** Drops concentration on this creature. */
  dropsConcentration?: boolean;
  /** Cannot speak (deafened doesn't include this; paralyzed/stunned do). */
  cannotSpeak?: boolean;
  /** Falls prone automatically (cascades from unconscious). */
  forcesProne?: boolean;
  /** Drops held items on apply (unconscious, petrified). */
  dropsHeldItems?: boolean;
  /** Resistance to ALL damage (petrified only, roughly). */
  resistAllDamage?: boolean;
  /** Immune to poison (petrified). */
  immuneToPoison?: boolean;
  /** Immune to disease (petrified). */
  immuneToDisease?: boolean;
  /**
   * Freeform rules notes the roll breakdown can surface inline so the
   * DM can explain to players why a modifier landed. Not authoritative.
   */
  notes?: string[];
}

export const CONDITION_EFFECTS: Record<Condition, ConditionEffect> = {
  blinded: {
    name: 'blinded',
    selfAttack: 'disadvantage',
    attacksAgainst: 'advantage',
    autoFailSightChecks: true,
    notes: ['Attacks roll with disadvantage', 'Attacks against have advantage'],
  },
  charmed: {
    name: 'charmed',
    // The "can't attack charmer" restriction needs the charmer's
    // identity, handled at resolve time. The social-check advantage
    // is asymmetric (charmer side) — also resolve-time.
    notes: ['Cannot attack the charmer', 'Charmer has advantage on social checks'],
  },
  deafened: {
    name: 'deafened',
    autoFailHearingChecks: true,
    notes: ['Auto-fail hearing-based ability checks'],
  },
  frightened: {
    name: 'frightened',
    selfAttack: 'disadvantage',
    disadvantageAbilityChecks: true,
    notes: ['Disadvantage on attacks + checks while source in sight', 'Cannot willingly move closer to the source of fear'],
  },
  grappled: {
    name: 'grappled',
    speedMultiplier: 0,
    notes: ['Speed 0', 'Ends when grappler incapacitated or removed'],
  },
  incapacitated: {
    name: 'incapacitated',
    blocksActions: true,
    blocksReactions: true,
    blocksBonusActions: true,
    dropsConcentration: true,
    notes: ['Cannot take actions, bonus actions, or reactions'],
  },
  invisible: {
    name: 'invisible',
    selfAttack: 'advantage',
    attacksAgainst: 'disadvantage',
    notes: ['Own attacks have advantage', 'Attacks against have disadvantage'],
  },
  paralyzed: {
    name: 'paralyzed',
    speedMultiplier: 0,
    blocksActions: true,
    blocksReactions: true,
    blocksBonusActions: true,
    dropsConcentration: true,
    cannotSpeak: true,
    autoFailSaves: ['str', 'dex'],
    attacksAgainst: 'advantage',
    meleeCritWithin5ft: true,
    notes: ['Incapacitated', 'Cannot move or speak', 'Auto-fail STR + DEX saves', 'Melee within 5 ft auto-crits'],
  },
  petrified: {
    name: 'petrified',
    speedMultiplier: 0,
    blocksActions: true,
    blocksReactions: true,
    blocksBonusActions: true,
    dropsConcentration: true,
    cannotSpeak: true,
    autoFailSaves: ['str', 'dex'],
    attacksAgainst: 'advantage',
    resistAllDamage: true,
    immuneToPoison: true,
    immuneToDisease: true,
    dropsHeldItems: true,
    notes: ['Incapacitated + transformed to stone', 'Resistance to ALL damage', 'Immune to poison + disease', 'Auto-fail STR + DEX saves'],
  },
  poisoned: {
    name: 'poisoned',
    selfAttack: 'disadvantage',
    disadvantageAbilityChecks: true,
    notes: ['Disadvantage on attacks + ability checks'],
  },
  prone: {
    name: 'prone',
    selfAttack: 'disadvantage',
    speedMultiplier: 0.5,
    // attacksAgainst depends on range: melee = advantage, ranged =
    // disadvantage. Encoded separately at resolve time.
    notes: ['Attacks roll with disadvantage', 'Melee attacks against have advantage', 'Ranged attacks against have disadvantage', 'Half speed to stand or crawl'],
  },
  restrained: {
    name: 'restrained',
    selfAttack: 'disadvantage',
    attacksAgainst: 'advantage',
    speedMultiplier: 0,
    disadvantageOwnRolls: { saves: true }, // DEX saves specifically
    notes: ['Speed 0', 'Attacks roll disadvantage', 'Attacks against advantage', 'DEX saves with disadvantage'],
  },
  stunned: {
    name: 'stunned',
    speedMultiplier: 0,
    blocksActions: true,
    blocksReactions: true,
    blocksBonusActions: true,
    dropsConcentration: true,
    autoFailSaves: ['str', 'dex'],
    attacksAgainst: 'advantage',
    notes: ['Incapacitated', 'Auto-fail STR + DEX saves', 'Attacks against have advantage'],
  },
  unconscious: {
    name: 'unconscious',
    speedMultiplier: 0,
    blocksActions: true,
    blocksReactions: true,
    blocksBonusActions: true,
    dropsConcentration: true,
    autoFailSaves: ['str', 'dex'],
    attacksAgainst: 'advantage',
    meleeCritWithin5ft: true,
    forcesProne: true,
    dropsHeldItems: true,
    notes: ['Incapacitated', 'Auto-fail STR + DEX saves', 'Melee within 5 ft auto-crits', 'Drops held items; falls prone'],
  },
  exhaustion: {
    name: 'exhaustion',
    // Exhaustion is multi-level (1–6) and the effect depends on
    // level. Stored separately on the character; the condition tag
    // here just indicates "has at least level 1". Level-specific
    // effects resolve via characterExhaustionLevel().
    disadvantageAbilityChecks: true,
    notes: ['L1: disadvantage on ability checks', 'L2: speed halved', 'L3: disadvantage on attacks + saves', 'L4: HP max halved', 'L5: speed 0', 'L6: death'],
  },
};

/**
 * Derived speed multiplier for a token with a set of conditions. The
 * minimum wins — a paralyzed + prone combatant is still speed 0, not
 * half. Also supports exhaustion levels (2 = half, 5 = 0).
 */
export function speedMultiplierFor(
  conditions: Iterable<Condition | string>,
  exhaustionLevel: number = 0,
): number {
  let mul = 1;
  for (const c of conditions) {
    const eff = CONDITION_EFFECTS[c as Condition];
    if (!eff) continue;
    if (eff.speedMultiplier !== undefined && eff.speedMultiplier < mul) {
      mul = eff.speedMultiplier;
    }
  }
  if (exhaustionLevel >= 5) mul = 0;
  else if (exhaustionLevel >= 2 && mul > 0.5) mul = 0.5;
  return mul;
}

/** Returns true if ANY condition in the set blocks the action slot. */
export function blocksActions(conditions: Iterable<Condition | string>): boolean {
  for (const c of conditions) {
    if (CONDITION_EFFECTS[c as Condition]?.blocksActions) return true;
  }
  return false;
}

/** Returns true if ANY condition blocks reactions. */
export function blocksReactions(conditions: Iterable<Condition | string>): boolean {
  for (const c of conditions) {
    if (CONDITION_EFFECTS[c as Condition]?.blocksReactions) return true;
  }
  return false;
}

/**
 * Compute advantage / disadvantage + auto-crit for a roll where
 * `source` is rolling against `target` from `range` ('melee5' | 'melee' | 'ranged').
 * Collapses advantage + disadvantage into 'normal' per 5e rules.
 */
export interface AttackModifierResult {
  effectiveAdvantage: 'advantage' | 'disadvantage' | 'normal';
  autoCrit: boolean;
  notes: string[];
}

export function computeAttackModifiers(
  sourceConditions: Iterable<Condition | string>,
  targetConditions: Iterable<Condition | string>,
  range: 'melee5' | 'melee' | 'ranged',
): AttackModifierResult {
  let hasAdv = false;
  let hasDis = false;
  let autoCrit = false;
  const notes: string[] = [];

  for (const c of sourceConditions) {
    const eff = CONDITION_EFFECTS[c as Condition];
    if (!eff) continue;
    if (eff.selfAttack === 'advantage') { hasAdv = true; notes.push(`${eff.name}: advantage`); }
    if (eff.selfAttack === 'disadvantage') { hasDis = true; notes.push(`${eff.name}: disadvantage`); }
  }
  for (const c of targetConditions) {
    const eff = CONDITION_EFFECTS[c as Condition];
    if (!eff) continue;
    if (eff.attacksAgainst === 'advantage') { hasAdv = true; notes.push(`target ${eff.name}: attacks against have advantage`); }
    if (eff.attacksAgainst === 'disadvantage') { hasDis = true; notes.push(`target ${eff.name}: attacks against have disadvantage`); }
    // Prone: melee att against advantage, ranged att against disadv.
    if (eff.name === 'prone') {
      if (range === 'melee5' || range === 'melee') { hasAdv = true; notes.push('target prone: melee against has advantage'); }
      if (range === 'ranged') { hasDis = true; notes.push('target prone: ranged against has disadvantage'); }
    }
    if (eff.meleeCritWithin5ft && range === 'melee5') {
      autoCrit = true;
      notes.push(`target ${eff.name}: melee within 5 ft is a critical hit`);
    }
  }

  let effectiveAdvantage: 'advantage' | 'disadvantage' | 'normal' = 'normal';
  if (hasAdv && hasDis) effectiveAdvantage = 'normal';
  else if (hasAdv) effectiveAdvantage = 'advantage';
  else if (hasDis) effectiveAdvantage = 'disadvantage';

  return { effectiveAdvantage, autoCrit, notes };
}

export interface SaveModifierResult {
  effectiveAdvantage: 'advantage' | 'disadvantage' | 'normal';
  autoFail: boolean;
  notes: string[];
}

/** Compute advantage + auto-fail for a specific ability save on a target. */
export function computeSaveModifiers(
  targetConditions: Iterable<Condition | string>,
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  exhaustionLevel: number = 0,
): SaveModifierResult {
  let hasAdv = false;
  let hasDis = false;
  let autoFail = false;
  const notes: string[] = [];

  for (const c of targetConditions) {
    const eff = CONDITION_EFFECTS[c as Condition];
    if (!eff) continue;
    if (eff.autoFailSaves?.includes(ability)) {
      autoFail = true;
      notes.push(`${eff.name}: auto-fail ${ability.toUpperCase()} save`);
    }
    // Restrained → disadvantage on DEX saves
    if (eff.name === 'restrained' && ability === 'dex') {
      hasDis = true;
      notes.push('restrained: disadvantage on DEX saves');
    }
  }

  // Exhaustion level 3 → disadvantage on ALL saves
  if (exhaustionLevel >= 3) {
    hasDis = true;
    notes.push(`exhaustion L${exhaustionLevel}: disadvantage on all saves`);
  }

  let effectiveAdvantage: 'advantage' | 'disadvantage' | 'normal' = 'normal';
  if (hasAdv && hasDis) effectiveAdvantage = 'normal';
  else if (hasAdv) effectiveAdvantage = 'advantage';
  else if (hasDis) effectiveAdvantage = 'disadvantage';

  return { effectiveAdvantage, autoFail, notes };
}
