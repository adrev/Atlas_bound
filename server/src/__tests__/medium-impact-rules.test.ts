/**
 * Tests for the "medium-impact" rules shipped alongside Tiers 21-25:
 *
 *   • Unarmored Defense   — CombatService.startCombatAsync AC formula
 *                           for Barb / Monk / Draconic Sorc when no
 *                           equipped armor is present AND no DDB id.
 *                           DDB imports should skip the formula since
 *                           the sheet already baked it.
 *   • Surprise            — setSurprise flags combatants, Alert feat
 *                           makes a token immune, nextTurn skips
 *                           flagged combatants in round 1, flags clear
 *                           at round rollover.
 *   • Condition sources   — !fear applies frightened with caster tokenId
 *                           carried through the map:token-updated
 *                           broadcast in conditionSources.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Combatant, CombatState, Token, ActionEconomy } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import * as CombatService from '../services/CombatService.js';
import { tryHandleChatCommand } from '../services/ChatCommands.js';
import { createRoom, getAllRooms, type RoomState, type RoomPlayer, type PlayerContext } from '../utils/roomState.js';

// Register the handler we test through the chat layer.
import '../services/chatCommands/spellHandlers.js';

// ── shared scaffolding ───────────────────────────────────────────

function makeToken(id: string, name: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name,
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

function seedRoom(
  sessionId: string,
  tokens: Token[],
  combatants: Combatant[] = [],
): RoomState {
  const room = createRoom(sessionId, 'ROOM-' + sessionId, 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const t of tokens) room.tokens.set(t.id, t);
  if (combatants.length > 0) {
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
  return room;
}

function fakeIo() {
  const emissions: Array<{ event: string; payload: unknown }> = [];
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => emissions.push({ event, payload }),
    }),
  };
  return { io: io as never, emissions };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

// ═══════════════════════════════════════════════════════════════════
// Unarmored Defense — Barb / Monk / Draconic Sorc AC
// ═══════════════════════════════════════════════════════════════════

function mockManualCharacter(overrides: Record<string, unknown>) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('SELECT * FROM characters')) {
      return Promise.resolve({
        rows: [{
          hit_points: 20, max_hit_points: 20, temp_hit_points: 0,
          armor_class: 10, speed: 30,
          ability_scores: JSON.stringify({ str: 10, dex: 16, con: 16, int: 10, wis: 14, cha: 10 }),
          saving_throws: JSON.stringify([]),
          proficiency_bonus: 2, level: 3,
          features: JSON.stringify([]),
          dndbeyond_id: null,
          user_id: 'user-pc',
          portrait_url: null,
          inventory: JSON.stringify([]),
          extras: JSON.stringify({}),
          initiative: 3,
          exhaustion_level: 0,
          ...overrides,
        }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('Unarmored Defense — Barbarian', () => {
  it('sets AC to 10 + DEX + CON when no armor equipped (no DDB)', async () => {
    const sessionId = 's-barb';
    seedRoom(sessionId, [makeToken('tBarb', 'Grog', { characterId: 'char-barb' })]);
    mockManualCharacter({ class: 'Barbarian' });
    const state = await CombatService.startCombatAsync(sessionId, ['tBarb']);
    // DEX +3, CON +3 → 10 + 3 + 3 = 16 (overrides the 10 baseline)
    expect(state.combatants[0].armorClass).toBe(16);
  });

  it('adds +2 when shield detected in inventory', async () => {
    const sessionId = 's-barb-shield';
    seedRoom(sessionId, [makeToken('tBarb', 'Grog', { characterId: 'char-barb' })]);
    mockManualCharacter({
      class: 'Barbarian',
      inventory: JSON.stringify([
        { name: 'Shield', category: 'shield', equipped: true },
      ]),
    });
    const state = await CombatService.startCombatAsync(sessionId, ['tBarb']);
    expect(state.combatants[0].armorClass).toBe(18); // 16 + 2 shield
  });

  it('keeps higher stored AC when Barbarian has armor', async () => {
    const sessionId = 's-barb-armored';
    seedRoom(sessionId, [makeToken('tBarb', 'Grog', { characterId: 'char-barb' })]);
    mockManualCharacter({
      class: 'Barbarian',
      armor_class: 17, // a heavier armor → 17
      inventory: JSON.stringify([
        { name: 'Half-plate', category: 'armor', equipped: true },
      ]),
    });
    const state = await CombatService.startCombatAsync(sessionId, ['tBarb']);
    // Formula suppressed because hasArmor detected.
    expect(state.combatants[0].armorClass).toBe(17);
  });
});

describe('Unarmored Defense — Monk', () => {
  it('sets AC to 10 + DEX + WIS when no armor and no shield', async () => {
    const sessionId = 's-monk';
    seedRoom(sessionId, [makeToken('tMonk', 'Kai', { characterId: 'char-monk' })]);
    mockManualCharacter({ class: 'Monk' });
    const state = await CombatService.startCombatAsync(sessionId, ['tMonk']);
    // DEX +3, WIS +2 → 10 + 3 + 2 = 15
    expect(state.combatants[0].armorClass).toBe(15);
  });

  it('suppresses monk unarmored defense when a shield is equipped', async () => {
    const sessionId = 's-monk-shield';
    seedRoom(sessionId, [makeToken('tMonk', 'Kai', { characterId: 'char-monk' })]);
    mockManualCharacter({
      class: 'Monk',
      inventory: JSON.stringify([
        { name: 'Shield', category: 'shield', equipped: true },
      ]),
    });
    const state = await CombatService.startCombatAsync(sessionId, ['tMonk']);
    // Monk formula blocked by shield — falls back to stored 10.
    expect(state.combatants[0].armorClass).toBe(10);
  });
});

describe('Unarmored Defense — Draconic Sorcerer', () => {
  it('sets AC to 13 + DEX when no armor equipped', async () => {
    const sessionId = 's-drac';
    seedRoom(sessionId, [makeToken('tDrac', 'Pyre', { characterId: 'char-drac' })]);
    mockManualCharacter({ class: 'Sorcerer (Draconic)' });
    const state = await CombatService.startCombatAsync(sessionId, ['tDrac']);
    // DEX +3 → 13 + 3 = 16
    expect(state.combatants[0].armorClass).toBe(16);
  });
});

describe('Unarmored Defense — DDB import bypasses the formula', () => {
  it('honours the stored AC verbatim when dndbeyond_id is set', async () => {
    const sessionId = 's-ddb-barb';
    seedRoom(sessionId, [makeToken('tDdb', 'Grog', { characterId: 'char-ddb' })]);
    mockManualCharacter({
      class: 'Barbarian', dndbeyond_id: 'beyond-42', armor_class: 14,
    });
    const state = await CombatService.startCombatAsync(sessionId, ['tDdb']);
    expect(state.combatants[0].armorClass).toBe(14);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Surprise — setSurprise + Alert immunity + skip-in-round-1
// ═══════════════════════════════════════════════════════════════════

describe('Surprise — setSurprise', () => {
  it('flags a regular combatant as surprised', () => {
    const sessionId = 's-surprise';
    seedRoom(sessionId,
      [makeToken('tA', 'A'), makeToken('tB', 'B')],
      [makeCombatant('tA'), makeCombatant('tB')],
    );
    const result = CombatService.setSurprise(sessionId, 'tA', true);
    expect(result).not.toBeNull();
    const room = getAllRooms().get(sessionId)!;
    expect(room.combatState!.combatants.find((c) => c.tokenId === 'tA')?.surprised).toBe(true);
  });

  it('refuses to flag a combatant with the Alert feat', () => {
    const sessionId = 's-alert';
    seedRoom(sessionId,
      [makeToken('tA', 'A')],
      [makeCombatant('tA', { hasAlert: true })],
    );
    const result = CombatService.setSurprise(sessionId, 'tA', true);
    expect(result).toBeNull();
    const room = getAllRooms().get(sessionId)!;
    expect(room.combatState!.combatants[0].surprised).toBeFalsy();
  });
});

describe('Surprise — nextTurn round-1 skip', () => {
  it('skips a surprised combatant on its round-1 turn', () => {
    const sessionId = 's-skip-r1';
    seedRoom(sessionId,
      [makeToken('tA', 'A'), makeToken('tB', 'B')],
      [
        makeCombatant('tA', { initiative: 20 }), // goes first
        makeCombatant('tB', { initiative: 10, surprised: true }),
      ],
    );
    const room = getAllRooms().get(sessionId)!;
    room.combatState!.currentTurnIndex = 0; // on A's turn
    const result = CombatService.nextTurn(sessionId);
    // Should wrap back around past the surprised B to A again (or
    // advance to round 2 and land on A at the top of the new round).
    expect(result.currentCombatant.tokenId).toBe('tA');
    // Round MUST have advanced since we looped past B.
    expect(result.roundNumber).toBe(2);
  });

  it('clears all surprised flags when the round advances', () => {
    const sessionId = 's-clear-r2';
    seedRoom(sessionId,
      [makeToken('tA', 'A'), makeToken('tB', 'B')],
      [
        makeCombatant('tA', { initiative: 20 }),
        makeCombatant('tB', { initiative: 10, surprised: true }),
      ],
    );
    const room = getAllRooms().get(sessionId)!;
    room.combatState!.currentTurnIndex = 0;
    CombatService.nextTurn(sessionId);
    // After round advanced, B's flag clears.
    expect(room.combatState!.combatants.find((c) => c.tokenId === 'tB')?.surprised).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Condition sources — frightened source tracked on !fear broadcast
// ═══════════════════════════════════════════════════════════════════

describe('Condition sources on map:token-updated', () => {
  it('!holdperson broadcast carries casterTokenId in conditionSources', async () => {
    const sessionId = 's-holdperson';
    const caller = makeToken('tPC', 'PC', {
      characterId: 'char-pc', ownerUserId: 'user-pc',
    });
    const target = makeToken('tFoe', 'Foe', { characterId: 'char-foe' });
    const room = seedRoom(sessionId, [caller, target],
      [makeCombatant('tPC'), makeCombatant('tFoe')],
    );
    const player: RoomPlayer = {
      userId: 'user-pc', displayName: 'PC',
      socketId: 'sock-pc', role: 'player', characterId: 'char-pc',
    };
    room.players.set('user-pc', player);
    const economy: ActionEconomy = {
      action: false, bonusAction: false, reaction: false,
      movementRemaining: 30, movementMax: 30,
    };
    room.actionEconomies.set(caller.id, economy);

    mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
      const id = params?.[0] as string | undefined;
      if (id === 'char-foe') {
        return { rows: [{
          ability_scores: { wis: 10 }, proficiency_bonus: 2,
          saving_throws: [], name: 'Foe',
        }] };
      }
      return { rows: [] };
    });

    const { io, emissions } = fakeIo();
    const ctx: PlayerContext = { room, player };
    // Nat 1 forces save fail regardless of mods.
    const orig = Math.random;
    Math.random = () => 0.02;
    try {
      await tryHandleChatCommand(io, ctx, '!holdperson Foe 14');
    } finally {
      Math.random = orig;
    }

    const updates = emissions
      .filter((e) => e.event === 'map:token-updated')
      .map((e) => e.payload as { tokenId: string; changes: Record<string, unknown> })
      .filter((p) => p.tokenId === 'tFoe');
    expect(updates.length).toBeGreaterThan(0);
    const sources = updates[updates.length - 1].changes.conditionSources as Record<string, string>;
    expect(sources.paralyzed).toBe('tPC');
  });
});
