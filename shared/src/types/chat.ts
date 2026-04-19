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
  hidden?: boolean;
  createdAt: string;
}
