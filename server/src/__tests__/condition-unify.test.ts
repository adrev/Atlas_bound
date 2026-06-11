/**
 * Condition split-brain unification (audit #9).
 *
 * Two divergent removeCondition implementations each cleaned a different
 * subset of state:
 *   • CombatService.removeCondition (DM tracker remove) updated the
 *     combatant + token but NOT room.conditionMeta — so clearing Hold
 *     Person left stale meta rolling phantom end-of-turn saves in chat
 *     every round, forever.
 *   • ConditionService.removeCondition (tick/auto removals) updated the
 *     token + meta but NOT combatant.conditions — stuck tracker badges.
 *   • applyConditionWithMeta never set combatant.conditions at all.
 *
 * Now ConditionService.removeCondition is the canonical single mutation
 * path (token + tokens row + meta + combatant) and CombatService
 * delegates to it, keeping its combat guards + persistence + return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token, CombatState, Combatant, Condition } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import * as CombatService from '../services/CombatService.js';
import {
  applyConditionWithMeta,
  removeCondition as conditionServiceRemove,
  tickEndOfTurnConditions,
} from '../services/ConditionService.js';
import { createRoom, getAllRooms, addPlayerToRoom, deleteRoom } from '../utils/roomState.js';

const SESSION = 's-cond-unify';

function tok(id: string, conditions: string[] = []): Token {
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
    conditions: conditions as never,
    ownerUserId: null,
    createdAt: new Date().toISOString(),
  };
}

function combatant(tokenId: string, conditions: string[] = []): Combatant {
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
    conditions: conditions as never,
    deathSaves: { successes: 0, failures: 0 },
  } as unknown as Combatant;
}

function seedCombatRoom(conditions: string[]) {
  const room = createRoom(SESSION, 'ROOM-CU', 'dm-user');
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  room.tokens.set('pc', tok('pc', [...conditions]));
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 2,
    currentTurnIndex: 0,
    combatants: [combatant('pc', [...conditions])],
    startedAt: new Date().toISOString(),
  } as CombatState;
  return room;
}

const holdPersonMeta = {
  name: 'restrained',
  source: 'Hold Person',
  appliedRound: 1,
  saveAtEndOfTurn: { ability: 'wis' as const, dc: 14 },
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('CombatService.removeCondition (DM tracker remove)', () => {
  it('clears the conditionMeta too — no phantom end-of-turn saves afterward', async () => {
    const room = seedCombatRoom([]);
    applyConditionWithMeta(SESSION, 'pc', holdPersonMeta);
    expect(room.conditionMeta.get('pc')?.has('restrained')).toBe(true);

    const remaining = CombatService.removeCondition(SESSION, 'pc', 'restrained' as Condition);

    expect(remaining).not.toContain('restrained');
    expect(room.tokens.get('pc')!.conditions).not.toContain('restrained');
    expect(room.combatState!.combatants[0].conditions).not.toContain('restrained');
    // THE fix: stale meta used to survive a tracker remove.
    expect(room.conditionMeta.get('pc')?.has('restrained') ?? false).toBe(false);

    // And the end-of-turn tick no longer rolls a phantom save.
    const tick = await tickEndOfTurnConditions(SESSION, 'pc', 2);
    expect(tick.messages).toHaveLength(0);
    expect(tick.removed).toHaveLength(0);
  });

  it('still throws outside active combat / for unknown combatants', () => {
    const room = seedCombatRoom([]);
    room.combatState = null;
    expect(() => CombatService.removeCondition(SESSION, 'pc', 'prone' as Condition)).toThrow(
      'No active combat'
    );
  });
});

describe('ConditionService.removeCondition (canonical path)', () => {
  it('syncs the combatant entry so tracker badges clear on tick removals', () => {
    const room = seedCombatRoom(['restrained']);
    applyConditionWithMeta(SESSION, 'pc', holdPersonMeta);

    conditionServiceRemove(SESSION, 'pc', 'Restrained'); // case-insensitive

    expect(room.tokens.get('pc')!.conditions).not.toContain('restrained');
    expect(room.combatState!.combatants[0].conditions).not.toContain('restrained');
    expect(room.conditionMeta.get('pc')?.has('restrained') ?? false).toBe(false);
  });

  it('works outside combat (token + meta only, no combatant to sync)', () => {
    const room = seedCombatRoom(['poisoned']);
    room.combatState = null;
    conditionServiceRemove(SESSION, 'pc', 'poisoned');
    expect(room.tokens.get('pc')!.conditions).not.toContain('poisoned');
  });
});

describe('applyConditionWithMeta', () => {
  it('sets the combatant entry in active combat (tracker shows the badge)', () => {
    const room = seedCombatRoom([]);
    applyConditionWithMeta(SESSION, 'pc', holdPersonMeta);
    expect(room.tokens.get('pc')!.conditions).toContain('restrained');
    expect(room.combatState!.combatants[0].conditions).toContain('restrained');
  });

  it('does not duplicate an existing combatant condition', () => {
    const room = seedCombatRoom(['restrained']);
    applyConditionWithMeta(SESSION, 'pc', holdPersonMeta);
    const conds = room.combatState!.combatants[0].conditions as string[];
    expect(conds.filter((c) => c === 'restrained')).toHaveLength(1);
  });
});
