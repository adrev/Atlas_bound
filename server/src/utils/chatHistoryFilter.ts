/**
 * Decides whether a given stored chat row should be delivered to a
 * specific user during session-join history hydration.
 *
 * The default is "yes" — public chat + public rolls are visible to
 * anyone in the session. Two exceptions:
 *
 *   • Hidden rolls (DM "rolled in secret")  → DM only.
 *   • Whispers                              → sender, target, or DM.
 *
 * Before this module existed, both filters were inline conditionals in
 * sessionEvents.ts and the whisper branch was missing entirely — which
 * meant every whisper ever sent in a session was replayed to every
 * joining player. Pulling it out also makes it trivially unit-testable.
 */
export interface StoredChatRow {
  type: string;                     // 'chat' | 'roll' | 'whisper' | 'system' | …
  user_id: string;                  // sender
  whisper_to: string | null;
  hidden: number | boolean | null;  // normalised from `(m.hidden as number) === 1`
}

export interface HistoryRecipient {
  userId: string;
  isDM: boolean;
}

export function shouldDeliverChatRow(row: StoredChatRow, r: HistoryRecipient): boolean {
  if (row.hidden && !r.isDM) return false;
  if (row.type === 'whisper') {
    if (r.isDM) return true;
    return r.userId === row.user_id || r.userId === row.whisper_to;
  }
  return true;
}
