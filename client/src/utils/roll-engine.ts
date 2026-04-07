import type { AbilityName } from '@dnd-vtt/shared';

/**
 * Centralized roll engine that reads a token's conditions/buffs and
 * returns the modifiers, advantage flags, and bonus dice that should be
 * applied to its rolls.
 *
 * Used by the spell cast resolver, weapon attacks, and saving throws so
 * conditions like Bless, Bane, Poisoned, Paralyzed etc. actually affect
 * the math instead of being decorative badges.
 *
 * Mechanical effects implemented in this phase:
 *   • Blessed   → +1d4 to attacks AND saving throws
 *   • Baned     → -1d4 to attacks AND saving throws
 *   • Poisoned  → disadvantage on attacks AND ability checks
 *   • Frightened→ disadvantage on attacks (we ignore the source-visible check)
 *   • Restrained→ disadvantage on attacks; disadvantage on DEX saves;
 *                 advantage to attackers
 *   • Prone     → disadvantage on attacks; advantage to melee attackers ≤5ft;
 *                 disadvantage to ranged attackers
 *   • Blinded   → disadvantage on attacks; advantage to attackers
 *   • Invisible (attacker) → advantage on attacks; disadvantage to attackers
 *   • Paralyzed → auto-fail STR/DEX saves; advantage to attackers; melee
 *                 within 5ft auto-crit
 *   • Stunned   → auto-fail STR/DEX saves; advantage to attackers
 *   • Unconscious→ auto-fail STR/DEX saves; advantage to attackers; melee
 *                 within 5ft auto-crit; auto-fail CON-related death checks
 *   • Petrified → advantage to attackers
 *   • Hasted    → advantage on DEX saves
 *
 * NOT yet implemented (need separate phases):
 *   • Slow's -2 DEX save penalty (handled as part of AC/save modifier
 *     phase 2)
 *   • Frightened source-visibility check (we apply unconditionally for now)
 *   • Hex / Hunter's Mark damage rider (separate damage system)
 *   • Bardic Inspiration (target picks when to use, not auto-applied)
 */

export type Adv = 'advantage' | 'disadvantage' | 'normal';

export interface RollContext {
  /** Conditions on this token, lowercased */
  conditions: string[];
}

export interface RollModifiers {
  /** Net advantage state for attack rolls */
  attackAdvantage: Adv;
  /** Net advantage state for saves of each ability */
  saveAdvantage: Partial<Record<AbilityName, Adv>>;
  /** Net advantage state for ability checks of each ability */
  checkAdvantage: Partial<Record<AbilityName, Adv>>;
  /** Bonus dice notation for attack rolls (e.g. '+1d4', '-1d4', '') */
  attackBonusDice: string;
  /** Bonus dice notation for saves */
  saveBonusDice: string;
  /** Saves that automatically fail (Paralyzed STR/DEX, etc.) */
  autoFailSaves: AbilityName[];
  /** Saves that automatically succeed (rare — none in phase 1) */
  autoSucceedSaves: AbilityName[];
  /** Force a critical hit on melee attacks within 5 ft against this target */
  meleeCritWithin5ft: boolean;
  /** Human-readable notes for chat output */
  notes: string[];
}

const EMPTY_MODS: RollModifiers = {
  attackAdvantage: 'normal',
  saveAdvantage: {},
  checkAdvantage: {},
  attackBonusDice: '',
  saveBonusDice: '',
  autoFailSaves: [],
  autoSucceedSaves: [],
  meleeCritWithin5ft: false,
  notes: [],
};

/**
 * Compute the modifier set for a token's OWN rolls (when this token is
 * the one rolling). For example, when this token is the attacker, the
 * `attackAdvantage` reflects whether THIS token's attacks are made with
 * advantage/disadvantage.
 */
export function getOwnRollModifiers(conditions: string[]): RollModifiers {
  const out: RollModifiers = {
    attackAdvantage: 'normal',
    saveAdvantage: {},
    checkAdvantage: {},
    attackBonusDice: '',
    saveBonusDice: '',
    autoFailSaves: [],
    autoSucceedSaves: [],
    meleeCritWithin5ft: false,
    notes: [],
  };

  const set = new Set(conditions.map(c => c.toLowerCase()));

  // Bonus dice (Bless / Bane)
  if (set.has('blessed')) {
    out.attackBonusDice = '+1d4';
    out.saveBonusDice = '+1d4';
    out.notes.push('Blessed (+1d4)');
  }
  if (set.has('baned')) {
    out.attackBonusDice = '-1d4';
    out.saveBonusDice = '-1d4';
    out.notes.push('Baned (-1d4)');
  }

  // Disadvantage on attacks
  if (set.has('poisoned')) {
    applyAdvantage(out, 'attack', 'disadvantage');
    out.notes.push('Poisoned (disadv. attacks)');
  }
  if (set.has('frightened')) {
    applyAdvantage(out, 'attack', 'disadvantage');
    out.notes.push('Frightened (disadv. attacks)');
  }
  if (set.has('restrained')) {
    applyAdvantage(out, 'attack', 'disadvantage');
    applyAdvantage(out, 'save', 'disadvantage', 'dex');
    out.notes.push('Restrained (disadv. attacks/DEX saves)');
  }
  if (set.has('prone')) {
    applyAdvantage(out, 'attack', 'disadvantage');
    out.notes.push('Prone (disadv. attacks)');
  }
  if (set.has('blinded')) {
    applyAdvantage(out, 'attack', 'disadvantage');
    out.notes.push('Blinded (disadv. attacks)');
  }

  // Disadvantage on ability checks (treated like saves for our purposes)
  if (set.has('poisoned')) {
    for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as AbilityName[]) {
      applyAdvantage(out, 'check', 'disadvantage', ab);
    }
  }

  // Auto-fail saves
  if (set.has('paralyzed') || set.has('stunned') || set.has('unconscious') || set.has('petrified')) {
    out.autoFailSaves = ['str', 'dex'];
    if (set.has('paralyzed')) out.notes.push('Paralyzed (auto-fail STR/DEX)');
    if (set.has('stunned')) out.notes.push('Stunned (auto-fail STR/DEX)');
    if (set.has('unconscious')) out.notes.push('Unconscious (auto-fail STR/DEX)');
    if (set.has('petrified')) out.notes.push('Petrified (auto-fail STR/DEX)');
  }

  // Hasted: advantage on DEX saves
  if (set.has('hasted')) {
    applyAdvantage(out, 'save', 'advantage', 'dex');
    out.notes.push('Hasted (adv. DEX saves)');
  }

  // Slowed: handled in Phase 2 as a save penalty (-2)

  return out;
}

/**
 * Compute the modifier set for rolls AGAINST this token (when this token
 * is the target). The `attackAdvantage` reflects whether INCOMING attacks
 * have advantage/disadvantage.
 */
export function getTargetRollModifiers(conditions: string[]): RollModifiers {
  const out: RollModifiers = {
    attackAdvantage: 'normal',
    saveAdvantage: {},
    checkAdvantage: {},
    attackBonusDice: '',
    saveBonusDice: '',
    autoFailSaves: [],
    autoSucceedSaves: [],
    meleeCritWithin5ft: false,
    notes: [],
  };

  const set = new Set(conditions.map(c => c.toLowerCase()));

  // Advantage to attackers (target is easier to hit)
  if (set.has('blinded')) {
    applyAdvantage(out, 'attack', 'advantage');
    out.notes.push('Target Blinded (adv. to attackers)');
  }
  if (set.has('paralyzed')) {
    applyAdvantage(out, 'attack', 'advantage');
    out.meleeCritWithin5ft = true;
    out.notes.push('Target Paralyzed (adv. + melee crit ≤5ft)');
  }
  if (set.has('stunned')) {
    applyAdvantage(out, 'attack', 'advantage');
    out.notes.push('Target Stunned (adv.)');
  }
  if (set.has('unconscious')) {
    applyAdvantage(out, 'attack', 'advantage');
    out.meleeCritWithin5ft = true;
    out.notes.push('Target Unconscious (adv. + melee crit ≤5ft)');
  }
  if (set.has('petrified')) {
    applyAdvantage(out, 'attack', 'advantage');
    out.notes.push('Target Petrified (adv.)');
  }
  if (set.has('restrained')) {
    applyAdvantage(out, 'attack', 'advantage');
    out.notes.push('Target Restrained (adv.)');
  }
  if (set.has('prone')) {
    // Prone is conditional on melee vs ranged. We can't know which here
    // without more context, so we conservatively give NO advantage and
    // let the caller pass `attackKind` to a more detailed function. For
    // single-target spells we just give advantage (most spells are
    // ranged but prone targets are more often hit by melee in practice).
    applyAdvantage(out, 'attack', 'advantage');
    out.notes.push('Target Prone');
  }
  if (set.has('outlined')) {
    // Faerie Fire
    applyAdvantage(out, 'attack', 'advantage');
    out.notes.push('Target Outlined (Faerie Fire)');
  }

  // Invisible target → disadvantage to attackers
  if (set.has('invisible')) {
    applyAdvantage(out, 'attack', 'disadvantage');
    out.notes.push('Target Invisible (disadv. to attackers)');
  }

  return out;
}

/**
 * Combine attacker's own modifiers with the target's incoming modifiers
 * to produce the FINAL modifiers for an attack roll. Advantage and
 * disadvantage cancel out (per RAW).
 */
export function combineAttackModifiers(
  attackerOwn: RollModifiers,
  targetIncoming: RollModifiers,
): RollModifiers {
  const out: RollModifiers = {
    attackAdvantage: 'normal',
    saveAdvantage: { ...attackerOwn.saveAdvantage },
    checkAdvantage: { ...attackerOwn.checkAdvantage },
    attackBonusDice: attackerOwn.attackBonusDice,
    saveBonusDice: attackerOwn.saveBonusDice,
    autoFailSaves: [...attackerOwn.autoFailSaves],
    autoSucceedSaves: [...attackerOwn.autoSucceedSaves],
    meleeCritWithin5ft: targetIncoming.meleeCritWithin5ft,
    notes: [...attackerOwn.notes, ...targetIncoming.notes],
  };

  // Combine advantage flags. Per RAW: any source of advantage AND any
  // source of disadvantage cancel each other out — you roll one d20.
  const attackerAdv = attackerOwn.attackAdvantage;
  const targetAdv = targetIncoming.attackAdvantage;
  const hasAdvantage = attackerAdv === 'advantage' || targetAdv === 'advantage';
  const hasDisadvantage = attackerAdv === 'disadvantage' || targetAdv === 'disadvantage';
  if (hasAdvantage && hasDisadvantage) out.attackAdvantage = 'normal';
  else if (hasAdvantage) out.attackAdvantage = 'advantage';
  else if (hasDisadvantage) out.attackAdvantage = 'disadvantage';
  else out.attackAdvantage = 'normal';

  return out;
}

/**
 * Roll a d20 with optional advantage / disadvantage. Returns the kept
 * value plus the rolled values for chat display.
 */
export function rollD20(adv: Adv = 'normal'): { kept: number; rolls: number[]; advantage: Adv } {
  if (adv === 'normal') {
    const r = Math.floor(Math.random() * 20) + 1;
    return { kept: r, rolls: [r], advantage: 'normal' };
  }
  const r1 = Math.floor(Math.random() * 20) + 1;
  const r2 = Math.floor(Math.random() * 20) + 1;
  const kept = adv === 'advantage' ? Math.max(r1, r2) : Math.min(r1, r2);
  return { kept, rolls: [r1, r2], advantage: adv };
}

/**
 * Roll a bonus-dice notation like "+1d4" or "-1d4". Returns the signed value
 * and the raw die result. Empty input returns 0.
 */
export function rollBonusDice(notation: string): { value: number; raw: number } {
  if (!notation) return { value: 0, raw: 0 };
  const m = notation.match(/^([+-])(\d+)d(\d+)$/);
  if (!m) return { value: 0, raw: 0 };
  const sign = m[1] === '-' ? -1 : 1;
  const numDice = parseInt(m[2]);
  const dieSize = parseInt(m[3]);
  let raw = 0;
  for (let i = 0; i < numDice; i++) raw += Math.floor(Math.random() * dieSize) + 1;
  return { value: sign * raw, raw };
}

/**
 * Roll a save with all the modifiers applied. Returns the total, the
 * dice breakdown, and a human-readable summary.
 */
export interface SaveResult {
  total: number;
  d20Roll: number;
  d20Rolls: number[];
  advantage: Adv;
  bonusDiceValue: number;
  bonusDiceNotation: string;
  autoFailed: boolean;
  breakdown: string;       // "d20=14 +5 +1d4(3) = 22 (advantage)"
}

export function rollSaveWithModifiers(
  ability: AbilityName,
  saveMod: number,
  modifiers: RollModifiers,
): SaveResult {
  // Auto-fail check
  if (modifiers.autoFailSaves.includes(ability)) {
    return {
      total: -999, // sentinel for "always fails"
      d20Roll: 1,
      d20Rolls: [1],
      advantage: 'normal',
      bonusDiceValue: 0,
      bonusDiceNotation: '',
      autoFailed: true,
      breakdown: 'auto-fail (Paralyzed/Stunned/Unconscious)',
    };
  }

  const adv = modifiers.saveAdvantage[ability] ?? 'normal';
  const { kept, rolls } = rollD20(adv);
  const bonus = rollBonusDice(modifiers.saveBonusDice);
  const total = kept + saveMod + bonus.value;

  const advLabel = adv === 'advantage' ? ' (adv)' : adv === 'disadvantage' ? ' (disadv)' : '';
  const rollsStr = rolls.length > 1 ? `[${rolls.join(',')}]` : `${kept}`;
  const modStr = saveMod >= 0 ? `+${saveMod}` : `${saveMod}`;
  const bonusStr = bonus.value !== 0
    ? ` ${bonus.value > 0 ? '+' : '-'}${Math.abs(bonus.raw)}(${modifiers.saveBonusDice.replace(/[+-]/, '')})`
    : '';
  const breakdown = `d20=${rollsStr}${advLabel}${modStr}${bonusStr} = ${total}`;

  return {
    total,
    d20Roll: kept,
    d20Rolls: rolls,
    advantage: adv,
    bonusDiceValue: bonus.value,
    bonusDiceNotation: modifiers.saveBonusDice,
    autoFailed: false,
    breakdown,
  };
}

/**
 * Roll an attack with all modifiers. Returns the total, kept d20, and
 * the breakdown string for chat.
 */
export interface AttackResult {
  total: number;
  d20Roll: number;
  d20Rolls: number[];
  advantage: Adv;
  bonusDiceValue: number;
  isCritical: boolean;
  isFumble: boolean;
  forceCritOnHit: boolean;   // Paralyzed melee within 5ft
  breakdown: string;
}

export function rollAttackWithModifiers(
  attackBonus: number,
  modifiers: RollModifiers,
): AttackResult {
  const { kept, rolls } = rollD20(modifiers.attackAdvantage);
  const bonus = rollBonusDice(modifiers.attackBonusDice);
  const total = kept + attackBonus + bonus.value;
  const isCritical = kept === 20;
  const isFumble = kept === 1;

  const advLabel = modifiers.attackAdvantage === 'advantage' ? ' (adv)'
    : modifiers.attackAdvantage === 'disadvantage' ? ' (disadv)' : '';
  const rollsStr = rolls.length > 1 ? `[${rolls.join(',')}]` : `${kept}`;
  const bonusModStr = attackBonus >= 0 ? `+${attackBonus}` : `${attackBonus}`;
  const bonusStr = bonus.value !== 0
    ? ` ${bonus.value > 0 ? '+' : '-'}${Math.abs(bonus.raw)}(${modifiers.attackBonusDice.replace(/[+-]/, '')})`
    : '';
  const breakdown = `d20=${rollsStr}${advLabel}${bonusModStr}${bonusStr} = ${total}`;

  return {
    total,
    d20Roll: kept,
    d20Rolls: rolls,
    advantage: modifiers.attackAdvantage,
    bonusDiceValue: bonus.value,
    isCritical,
    isFumble,
    forceCritOnHit: modifiers.meleeCritWithin5ft,
    breakdown,
  };
}

// --- Internal helpers ---

function applyAdvantage(
  out: RollModifiers,
  kind: 'attack' | 'save' | 'check',
  adv: 'advantage' | 'disadvantage',
  ability?: AbilityName,
): void {
  if (kind === 'attack') {
    // Combine: existing × new. If they're opposite, cancel to normal.
    if (out.attackAdvantage === 'normal') out.attackAdvantage = adv;
    else if (out.attackAdvantage !== adv) out.attackAdvantage = 'normal';
  } else {
    const map = kind === 'save' ? out.saveAdvantage : out.checkAdvantage;
    if (!ability) {
      for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as AbilityName[]) {
        const cur = map[ab] ?? 'normal';
        if (cur === 'normal') map[ab] = adv;
        else if (cur !== adv) map[ab] = 'normal';
      }
    } else {
      const cur = map[ability] ?? 'normal';
      if (cur === 'normal') map[ability] = adv;
      else if (cur !== adv) map[ability] = 'normal';
    }
  }
}
