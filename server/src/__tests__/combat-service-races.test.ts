/**
 * CombatService correctness cluster (audit #14, #16, #18).
 *
 *  #18 nextTurn on an empty initiative list threw 'reading tokenId' after
 *      already bumping the round — turns could never advance again.
 *  #16 Dash added the raw base speed even when a condition capped the
 *      creature's speed to 0 (grappled/restrained), letting it escape.
 *  #14 startCombatAsync's 'already active' guard was TOCTOU across the
 *      awaited character load, so two concurrent starts both ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token, CombatState, Combatant } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import * as CombatService from '../services/CombatService.js';
import { createRoom, getAllRooms, deleteRoom, getRoom } from '../utils/roomState.js';

const SESSION = 's-combat-races';

function tok(id: string, conditions: string[] = []): Token {
  return {
    id,
    mapId: 'm1',
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
    conditions: conditions as never,
    ownerUserId: null,
    createdAt: new Date().toISOString(),
  } as Token;
}

function combatant(tokenId: string, over: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: null,
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    exhaustionLevel: 0,
    ...over,
  } as unknown as Combatant;
}

function seed(combatants: Combatant[], tokens: Token[]) {
  const room = createRoom(SESSION, 'ROOM-CR', 'dm-user');
  for (const t of tokens) room.tokens.set(t.id, t);
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 3,
    currentTurnIndex: 0,
    combatants,
    startedAt: new Date().toISOString(),
  } as CombatState;
  return room;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('nextTurn — empty initiative list (audit #18)', () => {
  it('throws a clear error WITHOUT drifting the round or crashing', () => {
    const room = seed([], []); // no combatants left
    const roundBefore = room.combatState!.roundNumber;
    expect(() => CombatService.nextTurn(SESSION)).toThrow(/no combatants remain/i);
    // The round must NOT have advanced (no silent drift).
    expect(room.combatState!.roundNumber).toBe(roundBefore);
  });

  it('still advances normally with combatants present', () => {
    seed([combatant('a'), combatant('b')], [tok('a'), tok('b')]);
    const res = CombatService.nextTurn(SESSION);
    expect(res.currentCombatant.tokenId).toBe('b'); // 0 -> 1
  });
});

describe('useDash — condition-capped speed (audit #16)', () => {
  it('adds 0 movement when the current combatant is restrained (speed 0)', () => {
    seed([combatant('grappled')], [tok('grappled', ['restrained'])]);
    // Turn start sets the (capped) economy.
    CombatService.nextTurn(SESSION); // wraps to round 4, current = grappled at idx 0
    const eco = CombatService.useDash(SESSION);
    expect(eco).not.toBeNull();
    expect(eco!.movementRemaining).toBe(0); // Dash grants nothing while restrained
    expect(eco!.movementMax).toBe(0);
  });

  it('doubles movement for an unhindered combatant', () => {
    seed([combatant('free', { speed: 30 })], [tok('free')]);
    CombatService.nextTurn(SESSION);
    const eco = CombatService.useDash(SESSION);
    expect(eco!.movementMax).toBe(60); // 30 base + 30 dash
    expect(eco!.movementRemaining).toBe(60);
  });
});

describe('startCombatAsync — concurrent-start guard (audit #14)', () => {
  it('rejects a second start while the first is still building', async () => {
    const room = createRoom(SESSION, 'ROOM-CR2', 'dm-user');
    room.tokens.set('pc', tok('pc'));
    // Slow the character-load query so the two starts overlap.
    mockQuery.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { rows: [] };
    });

    const [a, b] = await Promise.allSettled([
      CombatService.startCombatAsync(SESSION, ['pc']),
      CombatService.startCombatAsync(SESSION, ['pc']),
    ]);

    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']); // exactly one wins
    const rejected = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already active/i);
    // The flag is cleared so a later legitimate start isn't wedged.
    expect(getRoom(SESSION)!.combatStarting).toBe(false);
  });
});
