export type ChatMessageType = 'ic' | 'ooc' | 'whisper' | 'roll' | 'system';

/**
 * Roll20-style roll templates. Structured metadata attached to a roll
 * so the chat card can render attack/save/check/damage/spell rolls
 * with the right chrome (AC target + hit/miss chip, DC + pass/fail,
 * damage-type chip, skill name, spell level). Free-form rolls leave
 * `template` undefined and the card falls back to its keyword-based
 * layout.
 */
export type RollTemplate =
  | { kind: 'attack'; target?: string; ac?: number; crit?: boolean; fumble?: boolean }
  | { kind: 'save'; ability: string; dc?: number; target?: string }
  | { kind: 'check'; skill?: string; ability: string }
  | { kind: 'damage'; damageType: string; target?: string; critical?: boolean }
  | { kind: 'spell'; spellName: string; spellLevel: number };

export interface DiceRollData {
  notation: string;
  dice: { type: number; value: number }[];
  modifier: number;
  total: number;
  advantage: 'normal' | 'advantage' | 'disadvantage';
  reason?: string;
  /**
   * True when the total was reported by the client's 3D dice instead of
   * being rolled server-side. The server sanity-checks that each die
   * value fits its declared sides and that sum(dice)+modifier equals
   * total, but it cannot prove the RNG was fair. Displayed to the DM
   * as a subtle marker ("reported") so suspicious rolls can be
   * double-checked; server-side rolls (NPC actions, saves, auto-rolls)
   * leave this flag unset/false.
   */
  clientReported?: boolean;
  /** Optional structured template. See `RollTemplate` for semantics. */
  template?: RollTemplate;
}

/**
 * Structured breakdown of a weapon / creature-action attack. Built by
 * the attack resolver on the client and attached to the resulting
 * chat message so the chat card can show every factor that went into
 * the number: which ability modifier, which proficiency, which feat
 * or fighting style, which target condition, each damage bonus source
 * and its resisted amount. Gives the DM + players a way to verify
 * "did the math actually do X?" instead of trusting a crammed
 * bracketed-tag sentence.
 *
 * The plain-text `content` on the surrounding ChatMessage remains as a
 * fallback for clients that haven't loaded the new card component
 * (old tabs, older API consumers, chat history backfill).
 */
export interface AttackBreakdownModifier {
  /** Human label shown to the user ("STR", "Prof", "Bless 1d4", "Archery"). */
  label: string;
  /** Signed integer the modifier contributed. Fractional dice are
   *  rendered via the label; the summed numeric effect lands here. */
  value: number;
  /** Optional category hint for grouping — 'ability' / 'proficiency'
   *  / 'feat' / 'fighting-style' / 'condition' / 'magic' / 'other'. */
  source?: 'ability' | 'proficiency' | 'feat' | 'fighting-style' | 'condition' | 'magic' | 'other';
}

export interface AttackBreakdownDamageSource {
  /** Label shown before the amount: "Slashing (1d8)", "Rage", "Sneak 2d6", "Hex 1d6 necrotic". */
  label: string;
  /** Raw rolled amount BEFORE target defenses applied. */
  amount: number;
  /** D&D damage type — drives resistance / immunity / vulnerability math. */
  damageType: string;
  /** Amount that actually landed after resistances. Undefined when
   *  defenses were a no-op (i.e. resisted === amount). */
  resisted?: number;
  /** Short source tag explaining why the resisted number differs. */
  resistanceNote?: string;
}

export interface AttackBreakdown {
  attacker: { name: string; tokenId?: string };
  target: {
    name: string;
    tokenId?: string;
    /** Effective AC after Shield / Haste / Mage Armor etc. */
    ac: number;
    /** Base armor_class + human-readable modifier notes ("+2 Hasted"). */
    baseAc?: number;
    acNotes?: string[];
  };
  weapon: { name: string; damageType: string };

  attackRoll: {
    /** Kept d20 face value. */
    d20: number;
    /** Both d20 faces when the roll was made with adv / disadv. */
    d20Rolls?: number[];
    advantage: 'normal' | 'advantage' | 'disadvantage';
    /** Per-source modifiers (Prof, ability mod, Bless die, Archery). */
    modifiers: AttackBreakdownModifier[];
    /** Final attack total (d20 + sum of modifiers). */
    total: number;
    isCrit: boolean;
    isFumble: boolean;
  };

  hitResult: 'hit' | 'miss' | 'crit' | 'fumble';

  damage?: {
    /** Base weapon dice notation ("1d8+3", "2d6"). */
    dice: string;
    /** Raw die faces from the base weapon damage roll. */
    diceRolls: number[];
    /** Base weapon damage amount (dice sum + ability mod). */
    mainRoll: number;
    /** Additional damage sources (Rage, Sneak, Hex, Smite, etc.). */
    bonuses: AttackBreakdownDamageSource[];
    /** Final damage after resistances across ALL sources combined. */
    finalDamage: number;
    /** Target HP before this attack landed. */
    targetHpBefore: number;
    /** Target HP after final damage applied. */
    targetHpAfter: number;
  };

  /** Extra human notes — "Advantage from target prone", "Bless active",
   *  "Power Attack -5/+10", "Sharpshooter ignores 2 cover AC". */
  notes: string[];

  /** Target reacted with Shield — 'miss' means Shield caused the hit to
   *  miss; 'still-hit' means Shield +5 wasn't enough. Omitted when
   *  Shield wasn't cast. */
  shieldSpell?: 'miss' | 'still-hit';
}

/**
 * Per-target outcome inside a spell cast. One SpellCastBreakdown can
 * carry many of these (Fireball hits 6 creatures, Eldritch Blast fires
 * 3 beams, Hypnotic Pattern affects everyone in a cube). Each entry's
 * `kind` discriminator drives which sub-fields are populated.
 */
export interface SpellTargetOutcome {
  name: string;
  tokenId?: string;
  kind: 'attack' | 'save' | 'heal' | 'damage-flat' | 'buff' | 'utility';

  /** Populated when kind === 'attack' (spell attack vs AC). */
  attack?: {
    d20: number;
    d20Rolls?: number[];
    advantage: 'normal' | 'advantage' | 'disadvantage';
    /** Attack bonus sources (spell attack bonus, Bless die, etc.). */
    modifiers: AttackBreakdownModifier[];
    total: number;
    targetAc: number;
    baseAc?: number;
    acNotes?: string[];
    hitResult: 'hit' | 'miss' | 'crit' | 'fumble';
  };

  /** Populated when kind === 'save' (target rolls a save). */
  save?: {
    d20: number;
    d20Rolls?: number[];
    advantage: 'normal' | 'advantage' | 'disadvantage';
    ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    /** Save bonus sources (save mod, Magic Resistance, race traits, etc.). */
    modifiers: AttackBreakdownModifier[];
    total: number;
    dc: number;
    saved: boolean;
    autoFailed?: boolean;
    autoSucceeded?: boolean;
  };

  /** Damage applied (any kind — on hit, on failed save, on save-for-half). */
  damage?: {
    dice: string;
    diceRolls: number[];
    mainRoll: number;
    bonuses: AttackBreakdownDamageSource[];
    /** True when half damage applied (save-for-half passed). */
    halfDamage?: boolean;
    finalDamage: number;
    targetHpBefore: number;
    targetHpAfter: number;
  };

  /** Healing applied. */
  healing?: {
    dice: string;
    diceRolls: number[];
    mainRoll: number;
    targetHpBefore: number;
    targetHpAfter: number;
  };

  /** Buffs / debuffs / conditions applied to this target. */
  conditionsApplied?: string[];

  /** Per-target situational notes (Magic Resistance, paralyzed auto-fail, etc.). */
  notes?: string[];
}

/**
 * Structured breakdown for a spell cast. Built by the spell resolver
 * on the client and attached to the resulting chat message so the
 * SpellCastCard can show every caster-side modifier, per-target roll,
 * damage source, and resistance — the same transparency contract as
 * AttackBreakdown but extended to multi-target spells (Fireball,
 * Eldritch Blast, Hypnotic Pattern).
 */
export interface SpellCastBreakdown {
  caster: { name: string; tokenId?: string };
  spell: {
    name: string;
    /** 0 = cantrip. */
    level: number;
    /**
     * 'attack' — spell attack roll (Fire Bolt, Eldritch Blast)
     * 'save' — targets save (Fireball, Hold Person, Hypnotic Pattern)
     * 'auto-damage' — no save, no attack (Magic Missile)
     * 'heal' — restores HP
     * 'utility' — buff / transform / narrative
     */
    kind: 'attack' | 'save' | 'auto-damage' | 'heal' | 'utility';
    /** Damage type when relevant (fire, necrotic, slashing, force, ...). */
    damageType?: string;
    /** Set for save-based spells. */
    saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    /** Spell save DC shown on every save-target row. */
    saveDc?: number;
    /** True when a passed save halves damage. Fireball, Cone of Cold, etc. */
    halfOnSave?: boolean;
    /** Spell attack bonus for 'attack' kind — the total used on the d20. */
    spellAttackBonus?: number;
  };
  /** Caster-side notes shared across all targets (concentration dropped, cast at higher level, etc.). */
  notes: string[];
  targets: SpellTargetOutcome[];
}

/**
 * Structured breakdown for a single d20 save roll. Covers:
 *   • Concentration saves on incoming damage (fires automatically in
 *     `ConditionService.processDamageSideEffects`; DC = max(10, dmg/2))
 *   • Death saves at 0 HP (DC 10, flat, crit rules on nat 20 / nat 1)
 *   • Standalone `!save` chat-command saves
 *   • Saving throws from server-side spell effects (Hideous Laughter
 *     retry at end of turn, end-of-turn Hold Person retry, etc.)
 *
 * A spell cast's per-target saves live on SpellCastBreakdown instead
 * (one message per cast, one row per target). This type is for the
 * one-off save that resolves in its own chat event.
 */
export interface SaveBreakdown {
  roller: { name: string; tokenId?: string; characterId?: string };
  /** Human context — "Concentration on Fireball", "Death save",
   *  "Hideous Laughter retry", "WIS save vs Fear". */
  context: string;
  /** Which save was rolled. `'death'` = 5e death save (flat d20). */
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha' | 'death';
  d20: number;
  d20Rolls?: number[];
  advantage: 'normal' | 'advantage' | 'disadvantage';
  modifiers: AttackBreakdownModifier[];
  total: number;
  /** Target DC. Absent for death saves (implied 10) or rolls without
   *  a DC target (e.g. shown for the record only). */
  dc?: number;
  passed: boolean;
  notes?: string[];
  /** Death-save-specific fields. Omit for other save kinds. */
  deathSave?: {
    successes: number;
    failures: number;
    stabilized?: boolean;
    dead?: boolean;
    /** Nat 20 restores 1 HP. */
    critSuccess?: boolean;
    /** Nat 1 counts as two failures. */
    critFailure?: boolean;
  };
  /** Concentration-save-specific fields. Omit for other save kinds. */
  concentration?: {
    spellName: string;
    damageAmount: number;
    /** True when the save failed and the spell was dropped. */
    dropped: boolean;
    /** War Caster feat grants advantage on concentration CON saves. */
    warCaster?: boolean;
  };
}

/**
 * Structured breakdown for non-dice actions — legendary actions, lair
 * actions, magic-item activations, downtime moves. Captures WHAT was
 * done and WHO it affected without needing the attack/save/damage
 * machinery. Renders as a compact card so players can scan what
 * happened mechanically without parsing paragraph descriptions.
 */
export interface ActionBreakdown {
  actor: { name: string; tokenId?: string };
  action: {
    name: string;
    category:
      | 'legendary'
      | 'lair'
      | 'magic-item'
      | 'class-feature'
      | 'racial'
      | 'environment'
      | 'downtime'
      | 'chase'
      | 'other';
    /** Optional emoji / icon shown in the header. */
    icon?: string;
    /** Optional cost — legendary actions cost 1/2/3 points; magic
     *  items may list charges used. */
    cost?: string;
  };
  /** One-liner effect description — "1d10 fire damage in 30-ft cone",
   *  "charmed for 1 minute", "teleport to unoccupied space". */
  effect: string;
  /** Per-target notes when the action hits multiple creatures. */
  targets?: Array<{
    name: string;
    tokenId?: string;
    effect?: string;
    conditionsApplied?: string[];
    damage?: { amount: number; damageType: string; hpBefore?: number; hpAfter?: number };
    healing?: { amount: number; hpBefore?: number; hpAfter?: number };
  }>;
  /** Extra situational notes. */
  notes?: string[];
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  displayName: string;
  type: ChatMessageType;
  content: string;
  characterName: string | null;
  whisperTo: string | null;
  rollData: DiceRollData | null;
  /**
   * Optional structured attack breakdown. Populated by the weapon /
   * creature-action resolver; rendered as a card with per-source
   * modifier lines so the DM can verify the math without parsing
   * bracketed tags.
   */
  attackResult?: AttackBreakdown | null;
  /**
   * Optional structured spell cast breakdown. Populated by the spell
   * resolver; rendered as a card with per-target outcome rows
   * (attack/save/heal/damage) so save DCs, advantage sources, and
   * damage riders all show transparently.
   */
  spellResult?: SpellCastBreakdown | null;
  /**
   * Optional save breakdown — single d20 save with full modifier list.
   * Used for concentration saves on damage, death saves, and standalone
   * save rolls (!save). Spell per-target saves live on SpellCastBreakdown
   * instead.
   */
  saveResult?: SaveBreakdown | null;
  /**
   * Optional non-dice action breakdown — legendary/lair actions,
   * magic-item activations, downtime moves. Renders a compact card
   * when no d20 math is involved but the event still deserves structure.
   */
  actionResult?: ActionBreakdown | null;
  hidden?: boolean;
  createdAt: string;
}
