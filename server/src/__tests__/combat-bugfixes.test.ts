import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Combatant, CombatState, Condition, Token } from '@dnd-vtt/shared';

// Stub DB before importing the services that touch it.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import * as CombatService from '../services/CombatService.js';
import * as OAService from '../services/OpportunityAttackService.js';
import * as ConditionService from '../services/ConditionService.js';
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

// ---------------------------------------------------------------------------
// Faction-based OA detection
// ---------------------------------------------------------------------------

describe('Opportunity attacks honor token faction', () => {
  const GRID = 70;

  it('friendly moving away from hostile provokes OA', () => {
    const sessionId = 's-fac-move-hostile';
    const mover = makeToken('tMover', {
      x: 0, y: 0, faction: 'friendly',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID, y: 0, faction: 'hostile',
    });
    seedRoom(sessionId, [mover, enemy], [
      makeCombatant('tMover', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);

    const ops = OAService.detectOpportunityAttacks(
      sessionId, 'tMover', 0, 0, GRID * 5, 0,
    );
    expect(ops.length).toBe(1);
    expect(ops[0].attackerTokenId).toBe('tEnemy');
  });

  it('friendly moving away from neutral does NOT provoke OA', () => {
    const sessionId = 's-fac-move-neutral';
    const mover = makeToken('tMover', {
      x: 0, y: 0, faction: 'friendly',
    });
    const neutral = makeToken('tNeutral', {
      x: GRID, y: 0, faction: 'neutral',
    });
    seedRoom(sessionId, [mover, neutral], [
      makeCombatant('tMover', { isNPC: false }),
      makeCombatant('tNeutral'),
    ]);

    const ops = OAService.detectOpportunityAttacks(
      sessionId, 'tMover', 0, 0, GRID * 5, 0,
    );
    expect(ops).toEqual([]);
  });

  it('hostile casting spell near friendly provokes OA', () => {
    const sessionId = 's-fac-cast-hostile';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, faction: 'hostile',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID, y: 0, faction: 'friendly',
    });
    seedRoom(sessionId, [caster, enemy], [
      makeCombatant('tCaster'),
      makeCombatant('tEnemy', { isNPC: false }),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops.length).toBe(1);
    expect(ops[0].attackerTokenId).toBe('tEnemy');
  });

  it('friendly casting spell near hostile provokes OA', () => {
    const sessionId = 's-fac-cast-friendly';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, faction: 'friendly',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID, y: 0, faction: 'hostile',
    });
    seedRoom(sessionId, [caster, enemy], [
      makeCombatant('tCaster', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops.length).toBe(1);
    expect(ops[0].attackerTokenId).toBe('tEnemy');
  });

  it('friendly casting spell near friendly does NOT provoke OA', () => {
    const sessionId = 's-fac-cast-ally';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, faction: 'friendly',
    });
    const ally = makeToken('tAlly', {
      x: GRID, y: 0, faction: 'friendly',
    });
    seedRoom(sessionId, [caster, ally], [
      makeCombatant('tCaster', { isNPC: false }),
      makeCombatant('tAlly', { isNPC: false }),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops).toEqual([]);
  });

  it('hostile casting near neutral does NOT provoke OA', () => {
    const sessionId = 's-fac-cast-neutral';
    const caster = makeToken('tCaster', {
      x: 0, y: 0, faction: 'hostile',
    });
    const neutral = makeToken('tNeutral', {
      x: GRID, y: 0, faction: 'neutral',
    });
    seedRoom(sessionId, [caster, neutral], [
      makeCombatant('tCaster'),
      makeCombatant('tNeutral'),
    ]);

    const ops = OAService.detectSpellCastingOA(sessionId, 'tCaster');
    expect(ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mobile feat — OA detector skips enemies the mover melee-attacked
// this turn. Keyed on mobileMeleeTargets set populated via the
// combat:mobile-attacked socket handler.
// ---------------------------------------------------------------------------

describe('OpportunityAttackService.detectOpportunityAttacks — Mobile feat', () => {
  const GRID = 70;

  it('suppresses an OA from an enemy the mover melee-attacked this turn', async () => {
    const sessionId = 's-mobile';
    const mover = makeToken('tMover', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID, y: 0, ownerUserId: null,
    });
    seedRoom(sessionId, [mover, enemy], [
      makeCombatant('tMover', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);
    const { getRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId)!;
    room.mobileMeleeTargets.set('tMover', new Set(['tEnemy']));
    room.mapGridSizes.set('map-1', GRID);

    // Mover steps 2 cells east → was in reach, now isn't.
    const ops = OAService.detectOpportunityAttacks(
      sessionId, 'tMover', 0, 0, GRID * 3, 0,
    );
    expect(ops).toEqual([]);
  });

  it('still fires the OA for a separate enemy the mover never touched', async () => {
    const sessionId = 's-mobile-mixed';
    const mover = makeToken('tMover', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const attackedEnemy = makeToken('tEnemyA', {
      x: GRID, y: 0, ownerUserId: null,
    });
    const innocentEnemy = makeToken('tEnemyB', {
      x: -GRID, y: 0, ownerUserId: null,
    });
    seedRoom(sessionId, [mover, attackedEnemy, innocentEnemy], [
      makeCombatant('tMover', { isNPC: false }),
      makeCombatant('tEnemyA'),
      makeCombatant('tEnemyB'),
    ]);
    const { getRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId)!;
    // Only attacked tEnemyA — tEnemyB should still get their OA.
    room.mobileMeleeTargets.set('tMover', new Set(['tEnemyA']));
    room.mapGridSizes.set('map-1', GRID);

    const ops = OAService.detectOpportunityAttacks(
      sessionId, 'tMover', 0, 0, GRID * 3, 0,
    );
    expect(ops.length).toBe(1);
    expect(ops[0].attackerTokenId).toBe('tEnemyB');
  });
});

// ---------------------------------------------------------------------------
// tokenMeleeReach cache — sync OA detector reads reach-2 attackers
// (glaives, halberds) from the pre-populated map so a mover 10 ft
// away still triggers their OA on exit.
// ---------------------------------------------------------------------------

describe('OpportunityAttackService — reach cache', () => {
  const GRID = 70;

  it('fires OA from a reach-2 attacker 10 ft away', async () => {
    const sessionId = 's-reach-2';
    const mover = makeToken('tMover', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID * 2, y: 0, ownerUserId: null,
    });
    seedRoom(sessionId, [mover, enemy], [
      makeCombatant('tMover', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);
    const { getRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId)!;
    room.tokenMeleeReach.set('tEnemy', 2);
    room.mapGridSizes.set('map-1', GRID);

    // Mover was 10 ft east (in reach for a polearm) → now far east
    // so the edge distance exceeds the 2-cell reach (140 px). Landing
    // at x = 8 cells east gives ~350 px edge distance, well outside.
    const ops = OAService.detectOpportunityAttacks(
      sessionId, 'tMover', 0, 0, GRID * 8, 0,
    );
    expect(ops.length).toBe(1);
    expect(ops[0].attackerTokenId).toBe('tEnemy');
  });

  it('does not fire OA from a reach-1 attacker when mover was 10 ft away', async () => {
    const sessionId = 's-reach-1';
    const mover = makeToken('tMover', {
      x: 0, y: 0, ownerUserId: 'player-1',
    });
    const enemy = makeToken('tEnemy', {
      x: GRID * 2, y: 0, ownerUserId: null,
    });
    seedRoom(sessionId, [mover, enemy], [
      makeCombatant('tMover', { isNPC: false }),
      makeCombatant('tEnemy'),
    ]);
    const { getRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId)!;
    // Explicit reach-1 in the cache — standard short sword / rapier.
    room.tokenMeleeReach.set('tEnemy', 1);
    room.mapGridSizes.set('map-1', GRID);

    const ops = OAService.detectOpportunityAttacks(
      sessionId, 'tMover', 0, 0, GRID * 4, 0,
    );
    expect(ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Grapple auto-release — when a grappler becomes incapacitated, the
// grappled creature is immediately freed per RAW.
// ---------------------------------------------------------------------------

describe('ConditionService — grapple auto-release', () => {
  it('releases a grappled creature when the grappler gets stunned', async () => {
    const sessionId = 's-grapple-release';
    const grappler = makeToken('tGrappler');
    const victim = makeToken('tVictim', { conditions: ['grappled' as unknown as Condition] });
    seedRoom(sessionId, [grappler, victim], [
      makeCombatant('tGrappler'),
      makeCombatant('tVictim'),
    ]);
    const { getRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId)!;
    // Seed the grapple meta — casterTokenId points at grappler.
    room.conditionMeta.set('tVictim', new Map([
      ['grappled', {
        name: 'grappled',
        source: 'tGrappler (!grapple)',
        appliedRound: 1,
        casterTokenId: 'tGrappler',
      }],
    ]));

    const freed = ConditionService.applyConditionWithMeta(sessionId, 'tGrappler', {
      name: 'stunned',
      source: 'monster stun ray',
      appliedRound: 1,
    });

    expect(freed).toContain('tVictim');
    expect((victim.conditions as string[]).includes('grappled')).toBe(false);
  });

  it('does not release unrelated grapples when an innocent token gets stunned', async () => {
    const sessionId = 's-grapple-unrelated';
    const innocent = makeToken('tInnocent');
    const grappler = makeToken('tGrappler');
    const victim = makeToken('tVictim', { conditions: ['grappled' as unknown as Condition] });
    seedRoom(sessionId, [innocent, grappler, victim], [
      makeCombatant('tInnocent'),
      makeCombatant('tGrappler'),
      makeCombatant('tVictim'),
    ]);
    const { getRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId)!;
    room.conditionMeta.set('tVictim', new Map([
      ['grappled', {
        name: 'grappled',
        source: 'tGrappler (!grapple)',
        appliedRound: 1,
        casterTokenId: 'tGrappler', // NOT tInnocent
      }],
    ]));

    const freed = ConditionService.applyConditionWithMeta(sessionId, 'tInnocent', {
      name: 'stunned',
      source: 'monster stun ray',
      appliedRound: 1,
    });

    expect(freed).toEqual([]);
    expect((victim.conditions as string[]).includes('grappled')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combat start: Tough + Defense fighting style application for
// manually-created characters (ones with no dndbeyond_id). DDB imports
// skip both bonuses since their max_hit_points / armor_class rows
// already include them.
// ---------------------------------------------------------------------------

describe('CombatService.startCombatAsync — manual-character feat bonuses', () => {
  it('Tough adds 2*level HP and Defense adds 1 AC when no DDB id', async () => {
    const sessionId = 's-manual-bonuses';
    const tPC = makeToken('tPC', {
      characterId: 'char-pc', ownerUserId: 'user-pc',
    });
    seedRoom(sessionId, [tPC], []);

    // Mock the character load — no dndbeyond_id, features include
    // Tough + Defense, level 3, raw HP 20, AC 15.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return Promise.resolve({
          rows: [{
            hit_points: 20, max_hit_points: 20, temp_hit_points: 0,
            armor_class: 15, speed: 30,
            ability_scores: JSON.stringify({ str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }),
            saving_throws: JSON.stringify(['con']),
            proficiency_bonus: 2, level: 3,
            features: JSON.stringify([{ name: 'Tough' }, { name: 'Defense' }]),
            dndbeyond_id: null,
            user_id: 'user-pc',
            portrait_url: null,
            inventory: JSON.stringify([]),
            extras: JSON.stringify({}),
            initiative: 2,
            exhaustion_level: 0,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const state = await CombatService.startCombatAsync(sessionId, ['tPC']);
    const combatant = state.combatants[0];
    // Tough: +2 * level(3) = +6 HP → 26 max
    expect(combatant.maxHp).toBe(26);
    // Defense: +1 AC → 16
    expect(combatant.armorClass).toBe(16);
  });

  it('skips bonuses when the character has a dndbeyond_id', async () => {
    const sessionId = 's-ddb-char';
    const tPC = makeToken('tPC', {
      characterId: 'char-ddb', ownerUserId: 'user-pc',
    });
    seedRoom(sessionId, [tPC], []);

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return Promise.resolve({
          rows: [{
            hit_points: 40, max_hit_points: 40, temp_hit_points: 0,
            armor_class: 18, speed: 30,
            ability_scores: JSON.stringify({ str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }),
            saving_throws: JSON.stringify(['con']),
            proficiency_bonus: 2, level: 3,
            features: JSON.stringify([{ name: 'Tough' }, { name: 'Defense' }]),
            dndbeyond_id: 'beyond-42',
            user_id: 'user-pc',
            portrait_url: null,
            inventory: JSON.stringify([]),
            extras: JSON.stringify({}),
            initiative: 2,
            exhaustion_level: 0,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const state = await CombatService.startCombatAsync(sessionId, ['tPC']);
    const combatant = state.combatants[0];
    // DDB already baked the bonuses — combat should honour the
    // stored values verbatim.
    expect(combatant.maxHp).toBe(40);
    expect(combatant.armorClass).toBe(18);
  });
});
