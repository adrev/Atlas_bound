/**
 * CombatService.sortInitiative / lockInitiative — turn-anchor correctness.
 *
 * Bug: sortInitiative re-sorted the combatants array in place but never
 * re-anchored currentTurnIndex, so a DM initiative correction or reroll
 * mid-combat silently handed the turn to whatever creature landed at the
 * old index. Duplicate names (Goblin ×3) made a name-based anchor useless.
 *
 * First fix inferred "review phase" from (roundNumber === 1 &&
 * currentTurnIndex === 0) and reset the pointer to the sorted top in that
 * state. But that exact state is ALSO the opener's real live turn right
 * after combat:lock-initiative, so an initiative correction during the
 * round-1 opener could still jump the turn.
 *
 * Final fix: sortInitiative ALWAYS anchors the turn to the current
 * combatant by stable tokenId — including the round-1 opener. The single
 * place review→live is known — lockInitiative(), called from the
 * combat:lock-initiative handler — re-sorts authoritatively and snaps the
 * opener to the highest final initiative (index 0). Nothing else has to
 * guess review-vs-live from ambiguous state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CombatState, Combatant } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import * as CombatService from '../services/CombatService.js';
import { createRoom, getAllRooms, deleteRoom } from '../utils/roomState.js';

const SESSION = 's-init-anchor';

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

function seed(combatants: Combatant[], roundNumber: number, currentTurnIndex: number) {
  const room = createRoom(SESSION, 'ROOM-IA', 'dm-user');
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber,
    currentTurnIndex,
    combatants,
    startedAt: new Date().toISOString(),
  } as CombatState;
  return room;
}

/** tokenId at the current turn pointer after a re-sort. */
function currentTokenId(room: ReturnType<typeof seed>): string | undefined {
  const s = room.combatState!;
  return s.combatants[s.currentTurnIndex]?.tokenId;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('sortInitiative — mid-combat re-anchor', () => {
  it('keeps the turn on the same combatant when a slower creature rerolls to the top', () => {
    // Round 2, it is "boss" (init 12, idx 1)'s turn.
    const room = seed(
      [combatant('hero', { initiative: 18 }), combatant('boss', { initiative: 12 })],
      2,
      1
    );
    expect(currentTokenId(room)).toBe('boss');

    // DM corrects "hero" downward AND boss is untouched, but a re-sort runs.
    // Simulate a reroll: hero drops to 5, so order flips to [boss, hero].
    room.combatState!.combatants.find((c) => c.tokenId === 'hero')!.initiative = 5;
    CombatService.sortInitiative(SESSION);

    // boss floated to index 0, but the turn must still be boss's.
    expect(room.combatState!.combatants[0].tokenId).toBe('boss');
    expect(currentTokenId(room)).toBe('boss');
  });

  it('follows the current combatant when THEIR OWN initiative is corrected downward', () => {
    // Round 3, "rogue" (idx 0) is acting; DM realizes their init was wrong.
    const room = seed(
      [
        combatant('rogue', { initiative: 20 }),
        combatant('orc', { initiative: 14 }),
        combatant('mage', { initiative: 8 }),
      ],
      3,
      0
    );
    expect(currentTokenId(room)).toBe('rogue');

    // Correct rogue down to 10 → new order [orc(14), mage(8)? no, rogue(10)] =>
    // [orc(14), rogue(10), mage(8)]. The turn must travel WITH rogue to idx 1.
    room.combatState!.combatants.find((c) => c.tokenId === 'rogue')!.initiative = 10;
    CombatService.sortInitiative(SESSION);

    expect(room.combatState!.combatants.map((c) => c.tokenId)).toEqual(['orc', 'rogue', 'mage']);
    expect(currentTokenId(room)).toBe('rogue');
    expect(room.combatState!.currentTurnIndex).toBe(1);
  });

  it('anchors by tokenId, NOT name, when combatants share a duplicate name', () => {
    // Three identically-named goblins; it is the SECOND goblin's turn.
    const room = seed(
      [
        combatant('gob-1', { name: 'Goblin', initiative: 17 }),
        combatant('gob-2', { name: 'Goblin', initiative: 15 }),
        combatant('gob-3', { name: 'Goblin', initiative: 9 }),
      ],
      4,
      1
    );
    expect(currentTokenId(room)).toBe('gob-2');

    // gob-3 rerolls to 20 and jumps to the front. A name-based anchor would
    // land on gob-1 (the first "Goblin"); tokenId anchoring must stay gob-2.
    room.combatState!.combatants.find((c) => c.tokenId === 'gob-3')!.initiative = 20;
    CombatService.sortInitiative(SESSION);

    expect(room.combatState!.combatants.map((c) => c.tokenId)).toEqual(['gob-3', 'gob-1', 'gob-2']);
    expect(currentTokenId(room)).toBe('gob-2');
  });

  it('keeps the turn on the current combatant in round 1 with an advanced pointer', () => {
    // Still round 1, but a turn has been taken → currentTurnIndex 1.
    const room = seed(
      [combatant('a', { initiative: 20 }), combatant('b', { initiative: 15 })],
      1,
      1
    );
    expect(currentTokenId(room)).toBe('b');

    // b rerolls to 25 and moves to the front; the turn must stay with b.
    room.combatState!.combatants.find((c) => c.tokenId === 'b')!.initiative = 25;
    CombatService.sortInitiative(SESSION);

    expect(room.combatState!.combatants[0].tokenId).toBe('b');
    expect(currentTokenId(room)).toBe('b');
    expect(room.combatState!.currentTurnIndex).toBe(0);
  });
});

describe('sortInitiative — round-1 live opener', () => {
  it('preserves the round-1 opener by tokenId when a correction reorders the list', () => {
    // After combat:lock-initiative the opener's real live turn is round 1,
    // index 0 — indistinguishable from the review state. A DM initiative
    // correction here must anchor to the opener, NOT reset to the new top.
    const room = seed(
      [combatant('alice', { initiative: 20 }), combatant('bob', { initiative: 15 })],
      1,
      0
    );
    expect(currentTokenId(room)).toBe('alice'); // alice is taking the opener

    // DM realises bob's roll was wrong and bumps him to 25; the order flips
    // to [bob, alice], but the turn must stay with alice (now index 1).
    room.combatState!.combatants.find((c) => c.tokenId === 'bob')!.initiative = 25;
    CombatService.sortInitiative(SESSION);

    expect(room.combatState!.combatants.map((c) => c.tokenId)).toEqual(['bob', 'alice']);
    expect(currentTokenId(room)).toBe('alice');
    expect(room.combatState!.currentTurnIndex).toBe(1);
  });

  it('anchors the round-1 opener by tokenId across duplicate names', () => {
    // Opener is the SECOND goblin; a reroll must not slide the turn onto a
    // same-named goblin.
    const room = seed(
      [
        combatant('gob-a', { name: 'Goblin', initiative: 18 }),
        combatant('gob-b', { name: 'Goblin', initiative: 14 }),
      ],
      1,
      0
    );
    // gob-b is the live opener (idx 0 after a hypothetical prior sort).
    room.combatState!.currentTurnIndex = 0;
    room.combatState!.combatants = [
      room.combatState!.combatants[1],
      room.combatState!.combatants[0],
    ];
    expect(currentTokenId(room)).toBe('gob-b');

    // gob-a rerolls to 25 and jumps ahead; a name anchor would land on the
    // wrong "Goblin" — tokenId anchoring keeps the turn on gob-b.
    room.combatState!.combatants.find((c) => c.tokenId === 'gob-a')!.initiative = 25;
    CombatService.sortInitiative(SESSION);

    expect(room.combatState!.combatants.map((c) => c.tokenId)).toEqual(['gob-a', 'gob-b']);
    expect(currentTokenId(room)).toBe('gob-b');
  });

  it('keeps the top at index 0 on a plain (already-sorted) start sort', () => {
    const room = seed(
      [combatant('top', { initiative: 19 }), combatant('mid', { initiative: 12 })],
      1,
      0
    );
    CombatService.sortInitiative(SESSION);
    expect(room.combatState!.currentTurnIndex).toBe(0);
    expect(currentTokenId(room)).toBe('top');
  });
});

describe('lockInitiative — review→live transition', () => {
  it('starts live combat at the highest final initiative after a review edit', () => {
    // Review phase (round 1, index 0). alice leads the sorted order.
    const room = seed(
      [combatant('alice', { initiative: 20 }), combatant('bob', { initiative: 15 })],
      1,
      0
    );

    // DM hand-edits bob up to 25 during review. sortInitiative (the review
    // edit path) now anchors to alice, so the pointer DRIFTS off the top —
    // that is fine while still in review.
    room.combatState!.combatants.find((c) => c.tokenId === 'bob')!.initiative = 25;
    CombatService.sortInitiative(SESSION);
    expect(currentTokenId(room)).toBe('alice'); // pointer drifted to index 1

    // Locking initiative snaps the opener to the highest final roll.
    const opener = CombatService.lockInitiative(SESSION);
    expect(opener?.tokenId).toBe('bob');
    expect(room.combatState!.combatants[0].tokenId).toBe('bob');
    expect(room.combatState!.currentTurnIndex).toBe(0);
    expect(currentTokenId(room)).toBe('bob');
  });

  it('resolves the highest-initiative opener across duplicate names', () => {
    const room = seed(
      [
        combatant('gob-1', { name: 'Goblin', initiative: 12 }),
        combatant('gob-2', { name: 'Goblin', initiative: 19 }),
        combatant('gob-3', { name: 'Goblin', initiative: 9 }),
      ],
      1,
      0
    );
    const opener = CombatService.lockInitiative(SESSION);
    expect(opener?.tokenId).toBe('gob-2'); // highest roll, by tokenId
    expect(room.combatState!.combatants.map((c) => c.tokenId)).toEqual(['gob-2', 'gob-1', 'gob-3']);
    expect(room.combatState!.currentTurnIndex).toBe(0);
  });

  it('returns null when there is no active combat', () => {
    createRoom(SESSION, 'ROOM-IA', 'dm-user');
    expect(CombatService.lockInitiative(SESSION)).toBeNull();
  });
});

describe('sortInitiative — guards', () => {
  it('returns an empty list when there is no active combat', () => {
    createRoom(SESSION, 'ROOM-IA', 'dm-user');
    expect(CombatService.sortInitiative(SESSION)).toEqual([]);
  });

  it('breaks initiative ties by initiativeBonus (higher goes first)', () => {
    const room = seed(
      [
        combatant('low-bonus', { initiative: 15, initiativeBonus: 1 }),
        combatant('high-bonus', { initiative: 15, initiativeBonus: 4 }),
      ],
      1,
      0
    );
    CombatService.sortInitiative(SESSION);
    expect(room.combatState!.combatants.map((c) => c.tokenId)).toEqual(['high-bonus', 'low-bonus']);
  });
});
