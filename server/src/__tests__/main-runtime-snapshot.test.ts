import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoom, deleteRoom } from '../utils/roomState.js';
import { restoreRoom, snapshotRoom } from '../utils/roomSnapshot.js';

vi.mock('../db/connection.js', () => ({ default: { query: vi.fn() } }));
import { claimPendingOpportunity } from '../services/OpportunityAttackService.js';

afterEach(() => deleteRoom('main-snapshot'));

describe('main fields through a durable room snapshot', () => {
  it('retains exact OA identity/deadline, spends once and does not extend expiry', () => {
    const room = createRoom('main-snapshot', 'MAIN', 'dm');
    room.pendingOpportunities.set('attacker::mover', {
      opportunityId: 'claim',
      attackerTokenId: 'attacker',
      moverTokenId: 'mover',
      attackerOwnerUserId: 'owner',
      trigger: 'movement',
      issuedAtMs: 1_000,
    });
    const saved = snapshotRoom(room);
    room.pendingOpportunities.clear();
    restoreRoom(room, saved);
    expect(claimPendingOpportunity(room, 'attacker', 'mover', 'wrong', 2_000)).toBeNull();
    expect(claimPendingOpportunity(room, 'attacker', 'mover', 'claim', 2_000)).toMatchObject({
      opportunityId: 'claim',
      issuedAtMs: 1_000,
    });
    restoreRoom(room, snapshotRoom(room));
    expect(claimPendingOpportunity(room, 'attacker', 'mover', 'claim', 2_001)).toBeNull();
    restoreRoom(room, saved);
    expect(claimPendingOpportunity(room, 'attacker', 'mover', 'claim', 91_001)).toBeNull();
  });

  it('reads production format-1 snapshots without fabricating OA claims', () => {
    const room = createRoom('main-snapshot', 'MAIN', 'dm');
    const saved = snapshotRoom(room);
    delete saved.values.pendingOpportunities;
    restoreRoom(room, saved);
    expect(room.pendingOpportunities.size).toBe(0);
    saved.values.pendingOpportunities = [['bad', {}]];
    expect(() => restoreRoom(room, saved)).toThrow();
  });

  it('retains main event-log redaction metadata rather than leaking raw replay payloads', () => {
    const room = createRoom('main-snapshot', 'MAIN', 'dm');
    room.eventLog = [
      {
        id: 1,
        ts: 1,
        kind: 'combat:hp-changed',
        payload: { hp: 9 },
        statTokenId: 'token',
        statCharacterId: 'character',
        redactedPayload: { hp: null },
      },
    ];
    const saved = snapshotRoom(room);
    room.eventLog = [];
    restoreRoom(room, saved);
    expect(room.eventLog[0]).toMatchObject({
      statTokenId: 'token',
      statCharacterId: 'character',
      redactedPayload: { hp: null },
    });
  });
});
