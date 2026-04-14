import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Combatant, CombatState, Condition, Token } from '@dnd-vtt/shared';

// Stub DB before importing the services that touch it.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import * as CombatService from '../services/CombatService.js';
import * as OAService from '../services/OpportunityAttackService.js';
import { createRoom, getAllRooms } from '../utils/roomState.js';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  // Wipe any rooms left over from previous tests.
  for (const id of Array.from(getAllRooms().keys())) {
    getAllRooms().delete(id);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function seedRoom(sessionId: string, tokens: Token[], combatants: Combatant[]): void {
  const room = createRoom(sessionId, 'ROOM', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const t of tokens) room.tokens.set(t.id, t);
  const state: CombatState = {
    sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants,
    startedAt: new Date().toISOString(),
  };
  room.combatState = state;
}

// ---------------------------------------------------------------------------
// Bug 1 — Turn advance skips dead combatants
// ---------------------------------------------------------------------------

describe('CombatService.nextTurn — skips downed combatants', () => {
  it('skips an NPC whose hp is 0', () => {
    const sessionId = 's1';
    const tA = makeToken('tA');
    const tB = makeToken('tB');
    const tC = makeToken('tC');
    const combatants = [
      makeCombatant('tA', { hp: 20 }),
      makeCombatant('tB', { hp: 0 }), // dead NPC
      makeCombatant('tC', { hp: 20 }),
    ];
    seedRoom(sessionId, [tA, tB, tC], combatants);

    const result = CombatService.nextTurn(sessionId);
    // Starting at 0 (tA), next should be tC (index 2), having skipped tB.
    expect(result.currentCombatant.tokenId).toBe('tC');
    expect(result.skippedTokenIds).toContain('tB');
  });

  it('skips a token with the "dead" condition even if hp > 0', () => {
    const sessionId = 's-dead-cond';
    const tA = makeToken('tA');
    const tB = makeToken('tB', { conditions: ['dead' as unknown as Condition] });
    const tC = makeToken('tC');
    const combatants = [
      makeCombatant('tA'),
      makeCombatant('tB', { hp: 5 }), // hp > 0 but marked dead
      makeCombatant('tC'),
    ];
    seedRoom(sessionId, [tA, tB, tC], combatants);

    const result = CombatService.nextTurn(sessionId);
    expect(result.currentCombatant.tokenId).toBe('tC');
    expect(result.skippedTokenIds).toContain('tB');
  });

  it('does not loop forever when every combatant is down', () => {
    const sessionId = 's-all-dead';
    const tA = makeToken('tA');
    const tB = makeToken('tB');
    const combatants = [
      makeCombatant('tA', { hp: 0 }),
      makeCombatant('tB', { hp: 0 }),
    ];
    seedRoom(sessionId, [tA, tB], combatants);

    // Must return within a finite amount of time — the implementation
    // guards against infinite loops with a safety counter.
    const result = CombatService.nextTurn(sessionId);
    // Both were tried and skipped; whatever index it landed on the
    // call itself must have terminated.
    expect(result.skippedTokenIds.length).toBeGreaterThan(0);
  });

  it('gives a downed PC a turn so they can roll death saves', () => {
    const sessionId = 's-pc-down';
    const tA = makeToken('tA');
    const tPC = makeToken('tPC', { ownerUserId: 'player-1' });
    const combatants = [
      makeCombatant('tA'),
      makeCombatant('tPC', { hp: 0, isNPC: false }),
    ];
    seedRoom(sessionId, [tA, tPC], combatants);

    const result = CombatService.nextTurn(sessionId);
    // PC at 0 HP with no death saves yet — they DO get their turn
    // (to roll). The per-action handlers block other actions.
    expect(result.currentCombatant.tokenId).toBe('tPC');
    expect(result.skippedTokenIds).not.toContain('tPC');
  });

  it('skips a PC who has already failed 3 death saves (fully dead)', () => {
    const sessionId = 's-pc-dead';
    const tA = makeToken('tA');
    const tPC = makeToken('tPC', { ownerUserId: 'player-1' });
    const tC = makeToken('tC');
    const combatants = [
      makeCombatant('tA'),
      makeCombatant('tPC', {
        hp: 0, isNPC: false,
        deathSaves: { successes: 0, failures: 3 },
      }),
      makeCombatant('tC'),
    ];
    seedRoom(sessionId, [tA, tPC, tC], combatants);

    const result = CombatService.nextTurn(sessionId);
    expect(result.currentCombatant.tokenId).toBe('tC');
    expect(result.skippedTokenIds).toContain('tPC');
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — Spell casting triggers OA from adjacent hostiles
// ---------------------------------------------------------------------------

describe('OpportunityAttackService.detectSpellCastingOA', () => {
  const GRID = 70; // matches server's default

  it('emits an OA for a hostile (different owner) within 5 feet of the caster', () => {
    const sessionId = 's-oa-adj';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const enemy = makeToken('tEnemy', {
      // 1 grid square east of the caster — within reach.
      x: GRID, y: 0, ownerUserId: null,
    });
    seedRoom(sessionId, [caster, enemy], [
      makeCombatant('tCaster', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops.length).toBe(1);
    expect(ops[0].attackerTokenId).toBe('tEnemy');
    expect(ops[0].moverTokenId).toBe('tCaster');
  });

  it('does not emit an OA when no hostile is adjacent', () => {
    const sessionId = 's-oa-empty';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const farEnemy = makeToken('tFar', {
      // 5 grid squares away — way outside melee reach.
      x: GRID * 5, y: 0, ownerUserId: null,
    });
    seedRoom(sessionId, [caster, farEnemy], [
      makeCombatant('tCaster', { isNPC: false }),
      makeCombatant('tFar'),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops).toEqual([]);
  });

  it('does not emit an OA from an allied (same side) adjacent token', () => {
    const sessionId = 's-oa-ally';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const ally = makeToken('tAlly', {
      x: GRID, y: 0, ownerUserId: 'player-2', // Also a PC → same side
    });
    seedRoom(sessionId, [caster, ally], [
      makeCombatant('tCaster', { isNPC: false }),
      makeCombatant('tAlly', { isNPC: false }),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops).toEqual([]);
  });

  it('does not emit an OA when the enemy is incapacitated (unconscious)', () => {
    const sessionId = 's-oa-uncon';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID, y: 0, ownerUserId: null,
      conditions: ['unconscious'],
    });
    seedRoom(sessionId, [caster, enemy], [
      makeCombatant('tCaster', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops).toEqual([]);
  });
});
