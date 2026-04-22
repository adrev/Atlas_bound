import type { AbilityName } from '@dnd-vtt/shared';
import {
  computeEffectiveAC,
  computeEffectiveSpeed,
  effectForCondition,
  type EffectiveStat as SharedEffectiveStat,
} from '@dnd-vtt/shared';

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

/**
 * Default empty-modifier bundle. Kept around because call-sites may
 * want to seed a `RollModifiers` before layering condition/feat logic
 * on top \u2014 even though no current caller uses it directly.
 */
export const EMPTY_MODS: RollModifiers = {
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
 * Detect Magic Resistance from a character's special abilities or
 * traits text. Creatures like Drow, Tieflings (Infernal Constitution),
 * Yuan-ti, and many higher CR monsters have advantage on saving throws
 * against spells and magical effects. This is a feature, not a
 * condition, so it lives outside the conditions array.
 */
export function hasMagicResistance(character: unknown): boolean {
  if (!character) return false;
  const c = character as { features?: unknown; specialAbilities?: unknown };

  // Check the features array (PCs)
  let features: Array<{ name?: string; description?: string; desc?: string }> = [];
  if (typeof c.features === 'string') {
    try { features = JSON.parse(c.features); } catch { /* ignore */ }
  } else if (Array.isArray(c.features)) {
    features = c.features;
  }
  for (const f of features) {
    const name = (f.name || '').toLowerCase();
    const desc = (f.description || '').toLowerCase();
    if (name.includes('magic resistance') || desc.includes('advantage on saving throws against spells')) {
      return true;
    }
  }

  // Check special abilities (creatures from compendium)
  let specials: Array<{ name?: string; desc?: string; description?: string }> = [];
  if (typeof c.specialAbilities === 'string') {
    try { specials = JSON.parse(c.specialAbilities); } catch { /* ignore */ }
  } else if (Array.isArray(c.specialAbilities)) {
    specials = c.specialAbilities;
  }
  for (const s of specials) {
    const name = (s.name || '').toLowerCase();
    const desc = (s.desc || s.description || '').toLowerCase();
    if (name.includes('magic resistance') || desc.includes('advantage on saving throws against spells')) {
      return true;
    }
  }

  return false;
}

/**
 * Compute the modifier set for a token's OWN rolls (when this token is
 * the one rolling). For example, when this token is the attacker, the
 * `attackAdvantage` reflects whether THIS token's attacks are made with
 * advantage/disadvantage.
 */
const ALL_ABILITIES: AbilityName[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/**
 * Translate a single shared `ConditionEffect` entry into deltas on the
 * `RollModifiers` bag the roll engine outputs. Split out so both
 * getOwnRollModifiers (rolling side) and getTargetRollModifiers (target
 * side) can walk the SAME data without hard-coding each condition
 * individually.
 *
 * The `side` discriminator controls which fields we read: the rolling
 * side reads `selfAttack` / `selfAttackAdvantage` / `saveAdvantage` /
 * `checkAdvantage` / `autoFailSaves` / `attackBonusDice` / etc., while
 * the target side reads `attacksAgainst` / `meleeCritWithin5ft`.
 */
function applyEffectOwn(out: RollModifiers, key: string): void {
  const eff = effectForCondition(key);
  if (!eff) return;

  // Attack advantage / disadvantage from the rolling side.
  if (eff.selfAttack === 'advantage' || eff.selfAttackAdvantage) {
    applyAdvantage(out, 'attack', 'advantage');
  }
  if (eff.selfAttack === 'disadvantage') {
    applyAdvantage(out, 'attack', 'disadvantage');
  }
  // Bonus dice (Bless +1d4, Bane -1d4). Last non-empty wins — sessions
  // rarely stack two bonus-dice sources, and when they do it's a DM
  // call which to honour.
  if (eff.attackBonusDice) out.attackBonusDice = eff.attackBonusDice;
  if (eff.saveBonusDice) out.saveBonusDice = eff.saveBonusDice;
  // Auto-fail saves (paralyzed / stunned / unconscious / petrified).
  if (eff.autoFailSaves) {
    for (const ab of eff.autoFailSaves) {
      if (!out.autoFailSaves.includes(ab as AbilityName)) out.autoFailSaves.push(ab as AbilityName);
    }
  }
  // Per-ability save + check advantage.
  if (eff.saveAdvantage) {
    for (const [ab, dir] of Object.entries(eff.saveAdvantage)) {
      if (dir) applyAdvantage(out, 'save', dir, ab as AbilityName);
    }
  }
  if (eff.checkAdvantage) {
    for (const [ab, dir] of Object.entries(eff.checkAdvantage)) {
      if (dir) applyAdvantage(out, 'check', dir, ab as AbilityName);
    }
  }
  // Disadvantage on ALL ability checks (poisoned / frightened / exhaustion).
  if (eff.disadvantageAbilityChecks) {
    for (const ab of ALL_ABILITIES) applyAdvantage(out, 'check', 'disadvantage', ab);
  }
  // Restrained: disadvantage on DEX saves via the legacy flag.
  if (eff.disadvantageOwnRolls?.saves && eff.name === 'restrained') {
    applyAdvantage(out, 'save', 'disadvantage', 'dex');
  }
  // Pick a nice single note. If the effect has multiple, join them.
  if (eff.notes && eff.notes.length > 0) {
    const display = eff.name.charAt(0).toUpperCase() + eff.name.slice(1).replace(/-/g, ' ');
    out.notes.push(`${display}: ${eff.notes[0]}`);
  }
}

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

  for (const c of conditions) applyEffectOwn(out, String(c).toLowerCase());

  return out;
}

/**
 * Compute the modifier set for rolls AGAINST this token (when this token
 * is the target). The `attackAdvantage` reflects whether INCOMING attacks
 * have advantage/disadvantage.
 *
 * `attackRange` refines prone handling — melee attackers get advantage
 * against a prone target, ranged attackers get disadvantage. Defaults
 * to 'melee' since most combat is melee and that matches the prior
 * behaviour of this function (advantage was always granted on prone).
 */
export function getTargetRollModifiers(
  conditions: string[],
  attackRange: 'melee' | 'ranged' = 'melee',
): RollModifiers {
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

  for (const raw of conditions) {
    const key = String(raw).toLowerCase();
    const eff = effectForCondition(key);
    if (!eff) continue;

    // Prone is the one rule that's range-sensitive: melee → adv,
    // ranged → disadv. Handle it explicitly so the data file can
    // stay range-agnostic.
    if (eff.name === 'prone') {
      if (attackRange === 'ranged') {
        applyAdvantage(out, 'attack', 'disadvantage');
        out.notes.push('Target Prone (ranged → disadv)');
      } else {
        applyAdvantage(out, 'attack', 'advantage');
        out.notes.push('Target Prone (melee → adv)');
      }
      if (eff.meleeCritWithin5ft && attackRange !== 'ranged') {
        out.meleeCritWithin5ft = true;
      }
      continue;
    }

    if (eff.attacksAgainst === 'advantage') {
      applyAdvantage(out, 'attack', 'advantage');
      const display = eff.name.charAt(0).toUpperCase() + eff.name.slice(1).replace(/-/g, ' ');
      out.notes.push(`Target ${display} (adv. to attackers)`);
    } else if (eff.attacksAgainst === 'disadvantage') {
      applyAdvantage(out, 'attack', 'disadvantage');
      const display = eff.name.charAt(0).toUpperCase() + eff.name.slice(1).replace(/-/g, ' ');
      out.notes.push(`Target ${display} (disadv. to attackers)`);
    }

    if (eff.meleeCritWithin5ft) {
      out.meleeCritWithin5ft = true;
    }
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

// --- AC + speed modifiers (Phase 2) ---

export interface EffectiveStat {
  /** Final value after all modifiers */
  value: number;
  /** Base value before modifiers */
  base: number;
  /** Per-source notes for tooltip ("+2 Hasted", "-2 Slowed") */
  notes: string[];
}

/**
 * Compute the effective AC for a token, applying all condition modifiers.
 * Thin wrapper over the shared `computeEffectiveAC` helper — the actual
 * rules data (which conditions add AC, which floor) lives in
 * shared/rules/conditionEffects.ts so the server can reason about the
 * same effects.
 */
export function effectiveAC(baseAC: number, conditions: string[], dexMod: number): EffectiveStat {
  return computeEffectiveAC(baseAC, conditions, dexMod) as SharedEffectiveStat;
}

/**
 * Compute the effective movement speed for a token in feet. Thin
 * wrapper over the shared `computeEffectiveSpeed` helper.
 */
export function effectiveSpeed(baseSpeed: number, conditions: string[]): EffectiveStat {
  return computeEffectiveSpeed(baseSpeed, conditions) as SharedEffectiveStat;
}

// --- Damage resistance / immunity / vulnerability (Phase 3) ---

export interface DamageResult {
  /** Final amount applied to HP */
  amount: number;
  /** Multiplier vs the input amount: 0 immune, 0.5 resistant, 1 normal, 2 vulnerable */
  multiplier: number;
  /** Human-readable label for chat ("resisted Stoneskin", "vulnerable to fire", etc.) */
  source: string;
}

interface DefenseLists {
  resistances: string[];
  immunities: string[];
  vulnerabilities: string[];
}

/**
 * Apply resistance / immunity / vulnerability to a damage amount.
 *
 * Looks at:
 *   1. The character's `defenses` arrays (from DDB import or compendium)
 *   2. Active conditions:
 *        • Stoneskin → resistance to nonmagical bludgeoning, piercing, slashing
 *        • Petrified → resistance to all damage
 *
 * Returns the adjusted amount + a label for chat output.
 */
/**
 * Weapon material markers that matter for resistance-bypass rules.
 * Werewolves / werebears / lycanthropes resist non-magical non-silvered
 * weapon damage; golems / many constructs resist non-magical
 * non-adamantine weapon damage. Optional fourth parameter on
 * `applyDamageWithResist`.
 */
export type WeaponMaterial = 'silvered' | 'adamantine' | 'cold-iron' | null;

/**
 * True when a resistance / immunity string should be SKIPPED for this
 * attack because the attack satisfies an exemption qualifier in the
 * string itself. Handles the three 5e monster-manual formats:
 *   "nonmagical attacks"                         → skip if isMagical
 *   "nonmagical attacks that aren't silvered"    → skip if silvered
 *   "nonmagical attacks that aren't adamantine"  → skip if adamantine
 *
 * Returns true = this particular resistance entry is exempted.
 */
function resistanceExempted(
  entry: string, isMagical: boolean, material: WeaponMaterial,
): boolean {
  const e = entry.toLowerCase();
  // The entry only applies to NONMAGICAL attacks. Magical attacks skip.
  if (/\bnon[\s-]?magical\b/.test(e)) {
    if (isMagical) return true;
    // Silvered / adamantine / cold-iron weapons bypass the remaining
    // non-magical resistance via explicit "that aren't X" clause.
    if (material === 'silvered' && /aren'?t\s+silvered|except\s+silvered/.test(e)) return true;
    if (material === 'adamantine' && /aren'?t\s+adamantine|except\s+adamantine/.test(e)) return true;
    if (material === 'cold-iron' && /aren'?t\s+cold[\s-]?iron|except\s+cold[\s-]?iron/.test(e)) return true;
  }
  return false;
}

export function applyDamageWithResist(
  baseAmount: number,
  damageType: string,
  defenses: Partial<DefenseLists> | undefined,
  conditions: string[],
  isMagical: boolean = true,
  material: WeaponMaterial = null,
): DamageResult {
  const dt = (damageType || '').toLowerCase();
  const set = new Set(conditions.map(c => c.toLowerCase()));
  const sourceParts: string[] = [];
  let multiplier = 1;

  // 1. Character racial / class defenses. Each entry is checked against
  // the damage type substring — AND against the "nonmagical" /
  // "aren't silvered" / "aren't adamantine" exemptions. Silvered
  // longsword vs werewolf: the werewolf's "non-magical non-silvered"
  // resistance is skipped, so full damage lands.
  const lists: DefenseLists = {
    resistances: (defenses?.resistances || []).map(s => s.toLowerCase()),
    immunities: (defenses?.immunities || []).map(s => s.toLowerCase()),
    vulnerabilities: (defenses?.vulnerabilities || []).map(s => s.toLowerCase()),
  };

  if (dt && lists.immunities.some(d => d.includes(dt) && !resistanceExempted(d, isMagical, material))) {
    return {
      amount: 0,
      multiplier: 0,
      source: `immune to ${dt}`,
    };
  }
  if (dt && lists.resistances.some(d => d.includes(dt) && !resistanceExempted(d, isMagical, material))) {
    multiplier = 0.5;
    sourceParts.push(`resist ${dt}`);
  }
  if (dt && lists.vulnerabilities.some(d => d.includes(dt))) {
    multiplier = 2;
    sourceParts.push(`vulnerable to ${dt}`);
  }

  // 2. Petrified → resistance to ALL damage (overrides current state if more lenient)
  if (set.has('petrified')) {
    if (multiplier > 0.5) multiplier = 0.5;
    sourceParts.push('Petrified (resist all)');
  }

  // 3. Stoneskin → resistance to nonmagical bludgeoning, piercing, slashing
  if (set.has('stoneskin') && !isMagical) {
    if (dt === 'bludgeoning' || dt === 'piercing' || dt === 'slashing') {
      if (multiplier > 0.5) multiplier = 0.5;
      sourceParts.push(`Stoneskin (resist ${dt})`);
    }
  }

  // 4. Raging (Barbarian) → resistance to bludgeoning, piercing, slashing
  // regardless of magical/non-magical (5e: "you have resistance to
  // bludgeoning, piercing, and slashing damage" while raging — no
  // magic qualifier).
  if (set.has('raging')) {
    if (dt === 'bludgeoning' || dt === 'piercing' || dt === 'slashing') {
      if (multiplier > 0.5) multiplier = 0.5;
      sourceParts.push(`Rage (resist ${dt})`);
    }
  }
  // 5. Bear Totem (Path of the Totem Warrior L3) — while raging,
  // resistance to ALL damage except psychic. Stacks with standard
  // Rage resistance; psychic is explicitly excluded per RAW.
  if (set.has('bear-raging') && set.has('raging')) {
    if (dt !== 'psychic' && dt !== '') {
      if (multiplier > 0.5) multiplier = 0.5;
      sourceParts.push(`Bear Totem (resist ${dt})`);
    }
  }

  return {
    amount: Math.floor(baseAmount * multiplier),
    multiplier,
    source: sourceParts.length > 0 ? sourceParts.join(', ') : '',
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
