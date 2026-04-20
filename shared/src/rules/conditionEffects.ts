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

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export interface ConditionEffect {
  /** Short name tag for the condition (matches the Condition union). */
  name: string;
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
  autoFailSaves?: Ability[];
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
   * Flat AC bonus (positive or negative). Hasted +2, Slowed -2,
   * Shield of Faith +2, Shield spell +5, half cover +2, 3/4 cover +5.
   */
  acBonus?: number;
  /**
   * AC floor — the effective AC is max(current, floor). Lets Mage
   * Armor (floor = 13 + DEX) and Barkskin (floor = 16) lift low-AC
   * targets without stacking past what they already wore.
   */
  acFloor?: number;
  /** If true, acFloor is added to dexMod at compute time (Mage Armor). */
  acFloorAddDex?: boolean;
  /**
   * Bonus dice added to attack rolls (Bless +1d4, Bane -1d4). Value
   * is a notation string prefixed with + or - so callers can parse /
   * display consistently.
   */
  attackBonusDice?: string;
  /** Bonus dice added to saves. Same shape as attackBonusDice. */
  saveBonusDice?: string;
  /** Grants advantage on attacks (pseudo-conditions like Inspired, Helped). */
  selfAttackAdvantage?: boolean;
  /**
   * Per-ability save advantage/disadvantage. Hasted / Dodging grant
   * advantage on DEX saves; exhaustion L3 imposes disadvantage on all.
   */
  saveAdvantage?: Partial<Record<Ability, 'advantage' | 'disadvantage'>>;
  /**
   * Per-ability check advantage. Helped gives advantage on all, a few
   * rages grant advantage on STR checks.
   */
  checkAdvantage?: Partial<Record<Ability, 'advantage' | 'disadvantage'>>;
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
 * Pseudo-conditions the VTT tracks outside the 15 canonical 5e
 * conditions — buffs from spells, class features, per-action flags.
 * Same schema as CONDITION_EFFECTS so compute helpers can iterate
 * both maps transparently. Names here should match the strings the
 * rest of the codebase uses (lowercase, hyphenated).
 *
 * Source of truth: both client (roll-engine modifier computation,
 * TokenLayer badge colors, wiki glossary) and server (chat-command
 * validators, future server-side attack resolution) should read
 * from this map rather than hard-coding the lists inline.
 */
export const PSEUDO_CONDITION_EFFECTS: Record<string, ConditionEffect> = {
  // Spells / class-feature buffs that grant mechanical bonuses
  blessed: {
    name: 'blessed',
    attackBonusDice: '+1d4',
    saveBonusDice: '+1d4',
    notes: ['+1d4 to attacks + saves (Bless)'],
  },
  baned: {
    name: 'baned',
    attackBonusDice: '-1d4',
    saveBonusDice: '-1d4',
    notes: ['-1d4 to attacks + saves (Bane)'],
  },
  hasted: {
    name: 'hasted',
    acBonus: 2,
    saveAdvantage: { dex: 'advantage' },
    notes: ['+2 AC', 'advantage on DEX saves', 'speed doubled'],
  },
  slowed: {
    name: 'slowed',
    acBonus: -2,
    saveAdvantage: { dex: 'disadvantage' },
    notes: ['-2 AC', '-2 DEX saves', 'half speed'],
  },
  dodging: {
    name: 'dodging',
    attacksAgainst: 'disadvantage',
    saveAdvantage: { dex: 'advantage' },
    notes: ['attacks against have disadvantage', 'advantage on DEX saves'],
  },
  inspired: {
    name: 'inspired',
    selfAttackAdvantage: true,
    saveAdvantage: { str: 'advantage', dex: 'advantage', con: 'advantage', int: 'advantage', wis: 'advantage', cha: 'advantage' },
    checkAdvantage: { str: 'advantage', dex: 'advantage', con: 'advantage', int: 'advantage', wis: 'advantage', cha: 'advantage' },
    notes: ['Inspiration: advantage on attack, save, or check (spend to use)'],
  },
  helped: {
    name: 'helped',
    selfAttackAdvantage: true,
    checkAdvantage: { str: 'advantage', dex: 'advantage', con: 'advantage', int: 'advantage', wis: 'advantage', cha: 'advantage' },
    notes: ['Helped: advantage on attack + ability checks (spend to use)'],
  },
  outlined: {
    name: 'outlined',
    attacksAgainst: 'advantage',
    notes: ['Faerie Fire: attacks against have advantage'],
  },
  raging: {
    // Rage — damage bonus + resistance applied in the damage pipeline,
    // not via the roll-engine helpers. Metadata here for badge / glossary
    // consistency.
    name: 'raging',
    checkAdvantage: { str: 'advantage' },
    saveAdvantage: { str: 'advantage' },
    notes: ['Advantage on STR checks + saves', 'Resist bludgeoning / piercing / slashing', '+2/+3/+4 damage on STR melee'],
  },
  // AC floors from spells
  'mage-armored': {
    name: 'mage-armored',
    acFloor: 13,
    acFloorAddDex: true,
    notes: ['AC floor = 13 + DEX (Mage Armor)'],
  },
  barkskin: {
    name: 'barkskin',
    acFloor: 16,
    notes: ['AC floor = 16 (Barkskin)'],
  },
  // Flat AC bonuses
  shielded: {
    name: 'shielded',
    acBonus: 2,
    notes: ['+2 AC (Shield of Faith)'],
  },
  'shield-spell': {
    name: 'shield-spell',
    acBonus: 5,
    notes: ['+5 AC until next turn (Shield cantrip reaction)'],
  },
  'half-cover': {
    name: 'half-cover',
    acBonus: 2,
    saveAdvantage: {}, // +2 DEX saves actually flat — tracked separately
    notes: ['+2 AC + DEX saves (half cover)'],
  },
  'three-quarters-cover': {
    name: 'three-quarters-cover',
    acBonus: 5,
    notes: ['+5 AC + DEX saves (three-quarters cover)'],
  },
  'full-cover': {
    name: 'full-cover',
    notes: ['Cannot be targeted directly'],
  },
  'power-attack': {
    name: 'power-attack',
    notes: ['GWM / Sharpshooter: -5 to hit, +10 damage (heavy melee / ranged)'],
  },
  concentrating: {
    name: 'concentrating',
    notes: ['Maintaining a concentration spell'],
  },
  'bardic-inspired': {
    name: 'bardic-inspired',
    notes: ['Holds a Bardic Inspiration die (spend to add to attack / save / check)'],
  },
  protected: {
    // Protection fighting style: an ally within 5 ft used their
    // reaction + shield to impose disadvantage on attacks against
    // this creature. One-shot; the badge auto-expires next round.
    name: 'protected',
    attacksAgainst: 'disadvantage',
    notes: ['Attacks against have disadvantage (Protection fighting style)'],
  },
  hidden: {
    name: 'hidden',
    attacksAgainst: 'disadvantage',
    notes: ['Attacks against have disadvantage until spotted'],
  },
  disengaged: {
    name: 'disengaged',
    notes: ['Movement this turn doesn\'t provoke opportunity attacks'],
  },
  hexed: {
    // Hex spell — caster's attacks against target deal +1d6 necrotic.
    // Mechanical application lives in the attack resolver (checks
    // ConditionMetadata.casterTokenId matches the current attacker).
    name: 'hexed',
    notes: ['Caster\'s attacks against this target deal +1d6 necrotic', 'Target has disadvantage on caster\'s chosen ability checks'],
  },
  marked: {
    // Hunter's Mark — caster's weapon attacks deal +1d6 to target.
    name: 'marked',
    notes: ['Caster\'s weapon attacks against this target deal +1d6', 'Caster has adv on Perception / Survival checks to find target'],
  },
  stable: {
    name: 'stable',
    notes: ['No longer rolls death saves; HP stays at 0'],
  },
};

/**
 * Look up an effect for any condition name — iterates both the 5e
 * standard map and the pseudo-condition map. Returns `undefined` when
 * the name is unknown (a common outcome for transient flags that
 * aren't fully modeled, e.g. `stable`, `dead`).
 */
export function effectForCondition(name: string): ConditionEffect | undefined {
  const key = name.toLowerCase();
  return CONDITION_EFFECTS[key as Condition] ?? PSEUDO_CONDITION_EFFECTS[key];
}

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
    const eff = effectForCondition(String(c));
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
    if (effectForCondition(String(c))?.blocksActions) return true;
  }
  return false;
}

/** Returns true if ANY condition blocks reactions. */
export function blocksReactions(conditions: Iterable<Condition | string>): boolean {
  for (const c of conditions) {
    if (effectForCondition(String(c))?.blocksReactions) return true;
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
    const eff = effectForCondition(String(c));
    if (!eff) continue;
    if (eff.selfAttack === 'advantage' || eff.selfAttackAdvantage) {
      hasAdv = true;
      notes.push(`${eff.name}: advantage`);
    }
    if (eff.selfAttack === 'disadvantage') {
      hasDis = true;
      notes.push(`${eff.name}: disadvantage`);
    }
  }
  for (const c of targetConditions) {
    const eff = effectForCondition(String(c));
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
  /**
   * Optional race string (e.g. "Mountain Dwarf", "Hill Dwarf"). When
   * supplied we consult RACE_TRAITS.savesVs for advantage/disadvantage
   * on specific conditions — halfling Brave (frightened), dwarf
   * Resilience (poison), gnome Cunning (magic vs INT/WIS/CHA), elf
   * charm-resistance.
   *
   * Save category is inferred from `savingAgainst`: passing
   * 'frightened' as the label lets halflings get adv; 'poison' lets
   * dwarves. Callers that don't know the flavor can skip this.
   */
  race?: string | null,
  savingAgainst?: string | null,
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

  for (const c of targetConditions) {
    const eff = effectForCondition(String(c));
    if (!eff) continue;
    const adv = eff.saveAdvantage?.[ability];
    if (adv === 'advantage') {
      hasAdv = true;
      notes.push(`${eff.name}: advantage on ${ability.toUpperCase()} save`);
    } else if (adv === 'disadvantage') {
      hasDis = true;
      notes.push(`${eff.name}: disadvantage on ${ability.toUpperCase()} save`);
    }
  }

  // Exhaustion level 3 → disadvantage on ALL saves
  if (exhaustionLevel >= 3) {
    hasDis = true;
    notes.push(`exhaustion L${exhaustionLevel}: disadvantage on all saves`);
  }

  // Race traits: halfling Brave vs frightened, dwarf Resilience vs
  // poison, gnome Cunning vs magic (INT/WIS/CHA), elf charm-adv, etc.
  // Only fires when the caller supplies both the race and a label
  // describing what the save is against.
  if (race && savingAgainst) {
    const tag = savingAgainst.toLowerCase();
    // Re-import avoided: inline the lookup to keep this file self-contained.
    // Match the trait map directly via the caller-supplied labels.
    const raceLower = race.toLowerCase();
    const raceAdvantages: Record<string, Record<string, 'advantage' | 'disadvantage'>> = {
      halfling: { frightened: 'advantage' },
      dwarf: { poison: 'advantage' },
      gnome: { magic: 'advantage' },
      elf: { charmed: 'advantage', charm: 'advantage' },
      'half-elf': { charmed: 'advantage', charm: 'advantage' },
      drow: { charmed: 'advantage', charm: 'advantage' },
      aasimar: { necrotic: 'advantage', radiant: 'advantage' },
      tiefling: { fire: 'advantage' },
    };
    // Gnome Cunning specifically gates on INT/WIS/CHA for `magic`.
    // Other races apply regardless of ability.
    for (const [raceKey, bonuses] of Object.entries(raceAdvantages)) {
      if (!raceLower.includes(raceKey)) continue;
      const flag = bonuses[tag];
      if (!flag) continue;
      if (raceKey === 'gnome' && tag === 'magic') {
        if (!['int', 'wis', 'cha'].includes(ability)) continue;
      }
      if (flag === 'advantage') {
        hasAdv = true;
        notes.push(`${raceKey} trait: advantage on save vs ${tag}`);
      } else {
        hasDis = true;
        notes.push(`${raceKey} trait: disadvantage on save vs ${tag}`);
      }
    }
  }

  let effectiveAdvantage: 'advantage' | 'disadvantage' | 'normal' = 'normal';
  if (hasAdv && hasDis) effectiveAdvantage = 'normal';
  else if (hasAdv) effectiveAdvantage = 'advantage';
  else if (hasDis) effectiveAdvantage = 'disadvantage';

  return { effectiveAdvantage, autoFail, notes };
}

// --- Effective-stat helpers (AC, speed) — computed with notes ----------

export interface EffectiveStat {
  /** Final value after all modifiers */
  value: number;
  /** Base value before modifiers */
  base: number;
  /** Per-source notes for tooltip ("+2 Hasted", "-2 Slowed") */
  notes: string[];
}

/**
 * Compute effective AC. `baseAC` is the character's stored armor_class
 * (already includes worn armor, shield, DEX, magical bonuses, feats).
 * We then apply:
 *   1. AC floors (Mage Armor, Barkskin) — only lift if the floor is higher
 *   2. Flat bonuses / penalties (Hasted +2, Slowed -2, Shield of Faith +2,
 *      Shield spell +5, half cover +2, three-quarters cover +5)
 *
 * `dexMod` is needed for Mage Armor's 13 + DEX floor.
 */
export function computeEffectiveAC(
  baseAC: number,
  conditions: Iterable<Condition | string>,
  dexMod: number,
): EffectiveStat {
  const out: EffectiveStat = { value: baseAC, base: baseAC, notes: [] };
  // Two passes: first apply floors (Mage Armor, Barkskin) so additive
  // bonuses stack correctly; then apply acBonus deltas.
  for (const c of conditions) {
    const eff = effectForCondition(String(c));
    if (!eff) continue;
    if (eff.acFloor !== undefined) {
      const floor = eff.acFloor + (eff.acFloorAddDex ? dexMod : 0);
      if (floor > out.value) {
        const diff = floor - out.value;
        out.value = floor;
        out.notes.push(`+${diff} ${eff.name} (floor ${eff.acFloor}${eff.acFloorAddDex ? '+DEX' : ''})`);
      }
    }
  }
  for (const c of conditions) {
    const eff = effectForCondition(String(c));
    if (!eff) continue;
    if (eff.acBonus !== undefined && eff.acBonus !== 0) {
      out.value += eff.acBonus;
      const sign = eff.acBonus > 0 ? '+' : '';
      out.notes.push(`${sign}${eff.acBonus} ${eff.name}`);
    }
  }
  return out;
}

/**
 * Compute effective movement speed with per-source notes. Returns 0 for
 * any speed-0 condition (grappled / restrained / paralyzed / stunned /
 * petrified / unconscious). Prone halves speed (matches RAW — the cost
 * of crawling or standing). Hasted doubles, Slowed halves. Exhaustion
 * L2 halves, L5 zeros.
 */
export function computeEffectiveSpeed(
  baseSpeed: number,
  conditions: Iterable<Condition | string>,
  exhaustionLevel: number = 0,
): EffectiveStat {
  const out: EffectiveStat = { value: baseSpeed, base: baseSpeed, notes: [] };

  // Scan for speed-0 first (short-circuit). Hand-coded map so note text
  // matches the legacy client output verbatim.
  const ZERO_WORDS: Record<string, string> = {
    grappled: 'Grappled (speed 0)',
    restrained: 'Restrained (speed 0)',
    paralyzed: 'Paralyzed (speed 0)',
    stunned: 'Stunned (speed 0)',
    petrified: 'Petrified (speed 0)',
    unconscious: 'Unconscious (speed 0)',
  };
  for (const c of conditions) {
    const key = String(c).toLowerCase();
    if (key in ZERO_WORDS) {
      out.value = 0;
      out.notes.push(ZERO_WORDS[key]);
      return out;
    }
  }
  if (exhaustionLevel >= 5) {
    out.value = 0;
    out.notes.push(`Exhaustion L${exhaustionLevel} (speed 0)`);
    return out;
  }

  // Multipliers: hasted x2, slowed/prone/exhaustion-2 x0.5.
  const set = new Set<string>();
  for (const c of conditions) set.add(String(c).toLowerCase());
  if (set.has('hasted')) {
    out.value *= 2;
    out.notes.push('×2 Hasted');
  }
  if (set.has('slowed')) {
    out.value = Math.floor(out.value / 2);
    out.notes.push('÷2 Slowed');
  }
  if (set.has('prone')) {
    out.value = Math.floor(out.value / 2);
    out.notes.push('÷2 Prone (crawl)');
  }
  if (exhaustionLevel >= 2) {
    out.value = Math.floor(out.value / 2);
    out.notes.push(`÷2 Exhaustion L${exhaustionLevel}`);
  }

  return out;
}
