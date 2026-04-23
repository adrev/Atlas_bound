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
   * Optional structured attack breakdown. Populated by the attack
   * resolver; rendered as a card with per-source modifier lines so the
   * DM can verify the math without parsing bracketed tags. Mutually
   * exclusive with `rollData` in practice — an attack is one card, not
   * a generic dice roll.
   */
  attackResult?: AttackBreakdown | null;
  hidden?: boolean;
  createdAt: string;
}
