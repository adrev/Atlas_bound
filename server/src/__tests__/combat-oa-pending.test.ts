/**
 * Server-authoritative pending-opportunity gate for opportunity attacks.
 *
 * `executeOpportunityAttack` used to trust whatever attacker/mover pair
 * the client handed it: it only re-checked "does the attacker still have
 * a reaction". That let a malicious or buggy client (a) manufacture an OA
 * against ANY token by crafting an `oa-execute` payload, and (b) execute
 * the same prompt twice — the reaction was only marked spent AFTER the
 * `await`s in the resolver, so two concurrent executes both slipped past
 * the reaction check before either consumed it.
 *
 * The fix binds execution to a one-shot, server-issued record. The
 * detectors register a `PendingOpportunity` for every OA they detect;
 * execution atomically claims (and deletes) the matching record before
 * doing anything, and revalidates active combat / token existence /
 * hostility. These tests pin that gate:
 *
 *   • a fabricated pair (no record) is rejected — no damage, no reaction;
 *   • duplicate + concurrent executes resolve at most once;
 *   • a declined or aged-out (TTL) prompt is rejected;
 *   • a genuine, freshly-detected OA resolves once, applies damage via
 *     the authoritative `CombatService.applyDamage`, consumes the
 *     reaction, and consumes the pending record.
 *
 * We stub the DB and `CombatService.applyDamage` so we exercise ONLY the
 * gate + reaction bookkeeping; the damage math itself is covered
 * elsewhere. The attacker has no `characterId`, so the resolver falls
 * back to an unarmed strike (no DB hop needed for the attack itself).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery, mockApplyDamage } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockApplyDamage: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../services/CombatService.js', () => ({ applyDamage: mockApplyDamage }));

import * as OAService from '../services/OpportunityAttackService.js';
import { createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

const GRID = 70;

function makeToken(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCombatant(tokenId: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: null,
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 20,
    maxHp: 20,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

/**
 * A friendly mover adjacent to a hostile enemy, both in active combat.
 * Returns the room so tests can inspect `pendingOpportunities` and the
 * attacker's action economy directly.
 */
function seedRoom(sessionId: string): RoomState {
  const room = createRoom(sessionId, 'ROOM', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  const mover = makeToken('tMover', { x: 0, y: 0, faction: 'friendly' });
  const enemy = makeToken('tEnemy', { x: GRID, y: 0, faction: 'hostile', name: 'Guard' });
  room.tokens.set(mover.id, mover);
  room.tokens.set(enemy.id, enemy);
  room.combatState = {
    sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [makeCombatant('tMover', { isNPC: false }), makeCombatant('tEnemy')],
    startedAt: new Date().toISOString(),
  } satisfies CombatState;
  return room;
}

/** Fire the movement detector so the server issues a real pending OA. */
function detectMoveAway(sessionId: string): OAService.OAOpportunity[] {
  return OAService.detectOpportunityAttacks(sessionId, 'tMover', 0, 0, GRID * 5, 0);
}

/**
 * Fire the detector and return the single server-issued opportunityId for
 * the tEnemy -> tMover pair. Tests thread this back into execute/decline
 * exactly as the real client echoes the id from the prompt.
 */
function issueOAId(sessionId: string): string {
  const [opp] = detectMoveAway(sessionId);
  return opp.opportunityId;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockApplyDamage.mockReset();
  mockApplyDamage.mockResolvedValue({
    hp: 19,
    tempHp: 0,
    change: -1,
    appliedAmount: 1,
    damageAdjustmentNote: undefined,
    characterId: null,
  });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OA pending-opportunity gate — fabricated pair', () => {
  it('rejects an execute for a pair the server never issued (no damage, no reaction spent)', async () => {
    const sessionId = 's-oa-fab';
    const room = seedRoom(sessionId);
    // NOTE: we deliberately do NOT run the detector — nothing is pending.
    expect(room.pendingOpportunities.size).toBe(0);

    const result = await OAService.executeOpportunityAttack(
      sessionId,
      'tEnemy',
      'tMover',
      'fabricated-id'
    );

    expect(result.success).toBe(false);
    expect(result.messages.join(' ')).toMatch(/no pending opportunity/i);
    expect(mockApplyDamage).not.toHaveBeenCalled();
    // The attacker's reaction must remain available — a rejected fake OA
    // cannot burn the victim-adjacent token's reaction.
    expect(room.actionEconomies.get('tEnemy')?.reaction ?? false).toBe(false);
  });

  it('rejects an execute against a bystander when only a different pair was issued', async () => {
    const sessionId = 's-oa-fab2';
    const room = seedRoom(sessionId);
    // Add a second hostile that never provoked anything.
    room.tokens.set('tOther', makeToken('tOther', { x: 400, y: 0, faction: 'hostile' }));
    const oppId = issueOAId(sessionId); // issues tEnemy -> tMover only

    const result = await OAService.executeOpportunityAttack(sessionId, 'tOther', 'tMover', oppId);

    expect(result.success).toBe(false);
    expect(mockApplyDamage).not.toHaveBeenCalled();
    // The legitimate tEnemy -> tMover opportunity is untouched.
    expect(room.pendingOpportunities.has('tEnemy::tMover')).toBe(true);
  });
});

describe('OA pending-opportunity gate — duplicate / concurrent execution', () => {
  it('resolves a sequential duplicate execute at most once', async () => {
    const sessionId = 's-oa-dup';
    seedRoom(sessionId);
    const oppId = issueOAId(sessionId);

    const first = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);
    const second = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.messages.join(' ')).toMatch(/no pending opportunity/i);
  });

  it('resolves concurrent executes exactly once (one-shot claim beats the race)', async () => {
    const sessionId = 's-oa-race';
    seedRoom(sessionId);
    // Force the winning roll to hit so the damage side-effect is
    // deterministic; the race outcome itself is independent of the roll.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const oppId = issueOAId(sessionId);

    // Kick off both before awaiting either — mirrors two sockets firing
    // the same prompt. The synchronous claim-and-delete guarantees the
    // second call finds no record.
    const [a, b] = await Promise.all([
      OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId),
      OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId),
    ]);

    const successes = [a, b].filter((r) => r.success).length;
    expect(successes).toBe(1);
    // Damage side-effect ran for exactly the one that won.
    expect(mockApplyDamage).toHaveBeenCalledTimes(1);
  });
});

describe('OA pending-opportunity gate — stale / declined', () => {
  it('rejects an execute after the prompt was declined', async () => {
    const sessionId = 's-oa-decline';
    const room = seedRoom(sessionId);
    const oppId = issueOAId(sessionId);
    expect(room.pendingOpportunities.has('tEnemy::tMover')).toBe(true);

    OAService.declinePendingOpportunity(room, 'tEnemy', 'tMover', oppId);
    expect(room.pendingOpportunities.has('tEnemy::tMover')).toBe(false);

    const result = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);
    expect(result.success).toBe(false);
    expect(mockApplyDamage).not.toHaveBeenCalled();
  });

  it('rejects an execute for an opportunity that has aged past the TTL', async () => {
    const sessionId = 's-oa-stale';
    const room = seedRoom(sessionId);
    const oppId = issueOAId(sessionId);

    // Backdate the issue time well beyond the staleness window.
    const rec = room.pendingOpportunities.get('tEnemy::tMover')!;
    rec.issuedAtMs -= 10 * 60_000;

    const result = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);
    expect(result.success).toBe(false);
    expect(mockApplyDamage).not.toHaveBeenCalled();
    // Even though stale, the record is consumed so a retry can't find it.
    expect(room.pendingOpportunities.has('tEnemy::tMover')).toBe(false);
  });

  it('rejects an execute once combat has ended, even with a live record', async () => {
    const sessionId = 's-oa-nocombat';
    const room = seedRoom(sessionId);
    const oppId = issueOAId(sessionId);
    room.combatState!.active = false;

    const result = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);
    expect(result.success).toBe(false);
    expect(result.messages.join(' ')).toMatch(/combat is not active/i);
    expect(mockApplyDamage).not.toHaveBeenCalled();
  });
});

describe('OA pending-opportunity gate — valid execution', () => {
  it('resolves a genuine detected OA, applies damage, and consumes reaction + record', async () => {
    const sessionId = 's-oa-valid';
    const room = seedRoom(sessionId);
    // Force a hit so the authoritative damage path runs deterministically
    // (d20 = 20 → crit, always hits the mover's AC).
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const oppId = issueOAId(sessionId);
    expect(room.pendingOpportunities.has('tEnemy::tMover')).toBe(true);

    const result = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);

    expect(result.success).toBe(true);
    // Authoritative damage pipeline was invoked against the mover.
    expect(mockApplyDamage).toHaveBeenCalledTimes(1);
    expect(mockApplyDamage.mock.calls[0][0]).toBe(sessionId);
    expect(mockApplyDamage.mock.calls[0][1]).toBe('tMover');
    // Reaction consumed and the one-shot record removed.
    expect(room.actionEconomies.get('tEnemy')?.reaction).toBe(true);
    expect(room.pendingOpportunities.has('tEnemy::tMover')).toBe(false);
  });

  it('propagates the authoritative character version returned by OA damage', async () => {
    const sessionId = 's-oa-version';
    seedRoom(sessionId);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    mockApplyDamage.mockResolvedValueOnce({
      hp: 12,
      tempHp: 0,
      change: -8,
      appliedAmount: 8,
      characterId: 'char-mover',
      version: 14,
    });

    const result = await OAService.executeOpportunityAttack(
      sessionId,
      'tEnemy',
      'tMover',
      issueOAId(sessionId)
    );

    expect(result.characterHpUpdated).toEqual({
      characterId: 'char-mover',
      hp: 12,
      tempHp: 0,
      version: 14,
    });
  });

  it('rejects a repeat even if a fresh record exists, because the reaction is spent', async () => {
    const sessionId = 's-oa-valid-then-dup';
    const room = seedRoom(sessionId);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const oppId = issueOAId(sessionId);

    const first = await OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover', oppId);
    // The detector won't re-issue once the reaction is spent, so plant a
    // fresh record by hand — this proves the reaction check is a distinct
    // second layer that stops a repeat even with a live pending record.
    room.pendingOpportunities.set('tEnemy::tMover', {
      opportunityId: 'replanted',
      attackerTokenId: 'tEnemy',
      attackerOwnerUserId: null,
      moverTokenId: 'tMover',
      trigger: 'movement',
      issuedAtMs: Date.now(),
    });
    const second = await OAService.executeOpportunityAttack(
      sessionId,
      'tEnemy',
      'tMover',
      'replanted'
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.messages.join(' ')).toMatch(/already spent their reaction/i);
    expect(room.actionEconomies.get('tEnemy')?.reaction).toBe(true);
  });
});

describe('OA pending-opportunity gate — opportunityId binding', () => {
  it('rejects a stale execute after a newer opportunity replaced it for the same pair', async () => {
    const sessionId = 's-oa-oldid-exec';
    const room = seedRoom(sessionId);
    const [oppA] = detectMoveAway(sessionId);
    // Re-detecting the same pair issues a fresh id and overwrites the record.
    const [oppB] = detectMoveAway(sessionId);
    expect(oppA.opportunityId).not.toBe(oppB.opportunityId);
    expect(room.pendingOpportunities.get('tEnemy::tMover')!.opportunityId).toBe(oppB.opportunityId);

    // The old prompt fires. It must not resolve, and must not consume the
    // fresher opportunity's claim.
    const stale = await OAService.executeOpportunityAttack(
      sessionId,
      'tEnemy',
      'tMover',
      oppA.opportunityId
    );
    expect(stale.success).toBe(false);
    expect(stale.messages.join(' ')).toMatch(/no pending opportunity/i);
    expect(mockApplyDamage).not.toHaveBeenCalled();
    expect(room.pendingOpportunities.get('tEnemy::tMover')?.opportunityId).toBe(oppB.opportunityId);

    // The current opportunity still resolves once.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const fresh = await OAService.executeOpportunityAttack(
      sessionId,
      'tEnemy',
      'tMover',
      oppB.opportunityId
    );
    expect(fresh.success).toBe(true);
    expect(mockApplyDamage).toHaveBeenCalledTimes(1);
  });

  it('a stale decline does not cancel the newer opportunity for the same pair', async () => {
    const sessionId = 's-oa-oldid-decline';
    const room = seedRoom(sessionId);
    const [oppA] = detectMoveAway(sessionId);
    const [oppB] = detectMoveAway(sessionId);

    // Dismissing with the OLD id must leave the fresher opportunity intact.
    OAService.declinePendingOpportunity(room, 'tEnemy', 'tMover', oppA.opportunityId);
    expect(room.pendingOpportunities.get('tEnemy::tMover')?.opportunityId).toBe(oppB.opportunityId);

    // ...and it can still be executed.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const result = await OAService.executeOpportunityAttack(
      sessionId,
      'tEnemy',
      'tMover',
      oppB.opportunityId
    );
    expect(result.success).toBe(true);
    expect(mockApplyDamage).toHaveBeenCalledTimes(1);
  });

  it('one attacker with two pending OAs vs different movers resolves at most one (concurrent)', async () => {
    const sessionId = 's-oa-cross-target';
    const room = createRoom(sessionId, 'ROOM', 'dm-user');
    room.currentMapId = 'map-1';
    room.playerMapId = 'map-1';
    const enemy = makeToken('tEnemy', { x: GRID, y: 0, faction: 'hostile', name: 'Guard' });
    const mover1 = makeToken('tMover1', { x: 0, y: 0, faction: 'friendly' });
    const mover2 = makeToken('tMover2', { x: 0, y: GRID, faction: 'friendly' });
    room.tokens.set(enemy.id, enemy);
    room.tokens.set(mover1.id, mover1);
    room.tokens.set(mover2.id, mover2);
    room.combatState = {
      sessionId,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [
        makeCombatant('tMover1', { isNPC: false }),
        makeCombatant('tMover2', { isNPC: false }),
        makeCombatant('tEnemy'),
      ],
      startedAt: new Date().toISOString(),
    } satisfies CombatState;

    // Two separate movements each provoke the SAME attacker → two live
    // pending records under different pair keys.
    const [oppM1] = OAService.detectOpportunityAttacks(sessionId, 'tMover1', 0, 0, GRID * 5, 0);
    const [oppM2] = OAService.detectOpportunityAttacks(sessionId, 'tMover2', 0, GRID, 0, GRID * 5);
    expect(room.pendingOpportunities.has('tEnemy::tMover1')).toBe(true);
    expect(room.pendingOpportunities.has('tEnemy::tMover2')).toBe(true);

    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    // Both fire before either awaits. The reaction is reserved synchronously
    // before the first await, so the second execute sees it already spent —
    // one reaction, one attack, even against distinct targets.
    const [a, b] = await Promise.all([
      OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover1', oppM1.opportunityId),
      OAService.executeOpportunityAttack(sessionId, 'tEnemy', 'tMover2', oppM2.opportunityId),
    ]);

    const successes = [a, b].filter((r) => r.success).length;
    expect(successes).toBe(1);
    expect(mockApplyDamage).toHaveBeenCalledTimes(1);
    expect(room.actionEconomies.get('tEnemy')?.reaction).toBe(true);
  });
});
