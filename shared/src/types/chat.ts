export type ChatMessageType = 'ic' | 'ooc' | 'whisper' | 'roll' | 'system';

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
