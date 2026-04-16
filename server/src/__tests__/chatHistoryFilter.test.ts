import { describe, it, expect } from 'vitest';
import { shouldDeliverChatRow, type StoredChatRow } from '../utils/chatHistoryFilter.js';

const SENDER = 'user-alice';
const TARGET = 'user-bob';
const THIRD = 'user-eve';
const DM_ID = 'user-dm';

function whisper(overrides: Partial<StoredChatRow> = {}): StoredChatRow {
  return {
    type: 'whisper',
    user_id: SENDER,
    whisper_to: TARGET,
    hidden: 0,
    ...overrides,
  };
}

describe('shouldDeliverChatRow — whispers', () => {
  it('delivers to the sender', () => {
    expect(shouldDeliverChatRow(whisper(), { userId: SENDER, isDM: false })).toBe(true);
  });

  it('delivers to the target', () => {
    expect(shouldDeliverChatRow(whisper(), { userId: TARGET, isDM: false })).toBe(true);
  });

  it('delivers to a DM (even if not sender/target)', () => {
    expect(shouldDeliverChatRow(whisper(), { userId: DM_ID, isDM: true })).toBe(true);
  });

  it('HIDES from a third-party player — the whole point of the privacy fix', () => {
    expect(shouldDeliverChatRow(whisper(), { userId: THIRD, isDM: false })).toBe(false);
  });
});

describe('shouldDeliverChatRow — hidden rolls (DM secret rolls)', () => {
  const hidden: StoredChatRow = { type: 'roll', user_id: DM_ID, whisper_to: null, hidden: 1 };

  it('delivers to DM', () => {
    expect(shouldDeliverChatRow(hidden, { userId: DM_ID, isDM: true })).toBe(true);
  });

  it('hides from players', () => {
    expect(shouldDeliverChatRow(hidden, { userId: TARGET, isDM: false })).toBe(false);
    expect(shouldDeliverChatRow(hidden, { userId: THIRD, isDM: false })).toBe(false);
  });

  it('hidden booleans (truthy) also gate the DM check', () => {
    const row: StoredChatRow = { ...hidden, hidden: true };
    expect(shouldDeliverChatRow(row, { userId: TARGET, isDM: false })).toBe(false);
  });
});

describe('shouldDeliverChatRow — public chat / rolls / system', () => {
  const publicChat: StoredChatRow = { type: 'chat', user_id: SENDER, whisper_to: null, hidden: 0 };
  const publicRoll: StoredChatRow = { type: 'roll', user_id: SENDER, whisper_to: null, hidden: 0 };
  const sysMsg:   StoredChatRow   = { type: 'system', user_id: 'system', whisper_to: null, hidden: 0 };

  it('delivers to anyone', () => {
    for (const msg of [publicChat, publicRoll, sysMsg]) {
      expect(shouldDeliverChatRow(msg, { userId: THIRD, isDM: false })).toBe(true);
      expect(shouldDeliverChatRow(msg, { userId: DM_ID, isDM: true })).toBe(true);
      expect(shouldDeliverChatRow(msg, { userId: SENDER, isDM: false })).toBe(true);
    }
  });
});
