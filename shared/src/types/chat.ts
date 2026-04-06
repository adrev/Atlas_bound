export type ChatMessageType = 'ic' | 'ooc' | 'whisper' | 'roll' | 'system';

export interface DiceRollData {
  notation: string;
  dice: { type: number; value: number }[];
  modifier: number;
  total: number;
  advantage: 'normal' | 'advantage' | 'disadvantage';
  reason?: string;
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
