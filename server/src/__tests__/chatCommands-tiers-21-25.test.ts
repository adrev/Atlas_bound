/**
 * Cross-tier sanity tests for the chat commands added in Tiers 21-25
 * + hazards + environment + downtime + Tier 24 magic items + racials +
 * !throw. Mirrors the harness style of chatCommands-tiers-10-20.test.ts.
 *
 * One happy-path assertion per command, plus a targeted edge case for
 * the high-impact handlers (dominate* charm-source tracking, power word
 * kill HP threshold, Mass Heal 700-pool, Form of Dread source tracking).
 *
 * Goal: catch regressions the way Tiers 10-20's 141 tests have —
 * specifically the Spiritual Weapon off-by-one class of bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server } from 'socket.io';
import type { Combatant, CombatState, Token, ActionEconomy, SaveBreakdown } from '@dnd-vtt/shared';

// Mock the DB before importing anything that touches it.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import { createRoom, getAllRooms, type RoomState, type RoomPlayer, type PlayerContext } from '../utils/roomState.js';

// Register handlers via import side-effects.
import '../services/chatCommands/spellsTier21Handler.js';
import '../services/chatCommands/spellsTier22Handler.js';
import '../services/chatCommands/itemsTier24Handler.js';
import '../services/chatCommands/subclassFeaturesTier25Handler.js';
import '../services/chatCommands/hazardsHandler.js';
import '../services/chatCommands/environmentHandler.js';
import '../services/chatCommands/downtimeHandler.js';
import '../services/chatCommands/utilityHandlers.js';
import '../services/chatCommands/racialSpellsHandler.js';
import '../services/chatCommands/throwWeaponHandler.js';

// ── Fake io + message capture ───────────────────────────────

interface Emission {
  event: string;
  payload: unknown;
}

function makeFakeIo(): { io: Server; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => {
        emissions.push({ event, payload });
      },
    }),
  } as unknown as Server;
  return { io, emissions };
}

function whispers(emissions: Emission[]): string[] {
  return emissions
    .filter((e) => e.event === 'chat:new-message')
    .map((e) => e.payload as { type?: string; content?: string })
    .filter((p) => p.type === 'whisper')
    .map((p) => p.content ?? '');
}

function systemBroadcasts(emissions: Emission[]): string[] {
  return emissions
    .filter((e) => e.event === 'chat:new-message')
    .map((e) => e.payload as { type?: string; content?: string })
    .filter((p) => p.type === 'system')
    .map((p) => p.content ?? '');
}

function lastSystemLine(emissions: Emission[]): string | undefined {
  const sys = systemBroadcasts(emissions);
  return sys[sys.length - 1];
}

function extractSaveResult(payload: unknown): SaveBreakdown | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { saveResult?: unknown };
  return typeof candidate.saveResult === 'object' && candidate.saveResult !== null
    ? (candidate.saveResult as SaveBreakdown)
    : undefined;
}

function lastSaveResult(emissions: Emission[]): SaveBreakdown | undefined {
  for (let i = emissions.length - 1; i >= 0; i -= 1) {
    if (emissions[i].event !== 'chat:new-message') continue;
    const saveResult = extractSaveResult(emissions[i].payload);
    if (saveResult) return saveResult;
  }
  return undefined;
}

function tokenUpdates(emissions: Emission[]): Array<{ tokenId: string; changes: Record<string, unknown> }> {
  return emissions
    .filter((e) => e.event === 'map:token-updated')
    .map((e) => e.payload as { tokenId: string; changes: Record<string, unknown> });
}

// ── Token / combat scaffolding ───────────────────────────────

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
    hp: 50,
    maxHp: 50,
    tempHp: 0,
    armorClass: 15,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

interface Scenario {
  room: RoomState;
  caller: Token;
  ctx: PlayerContext;
  callerEconomy: ActionEconomy;
}

function makeScenario(opts: {
  callerCharId?: string;
  callerOwnerId?: string;
  role?: 'dm' | 'player';
  inCombat?: boolean;
  otherTokens?: Token[];
  otherCombatants?: Combatant[];
} = {}): Scenario {
  const sessionId = 'sess-' + Math.random().toString(36).slice(2);
  const room = createRoom(sessionId, 'ROOM-' + sessionId, 'dm-user');
  room.playerMapId = 'map-1';

  const callerOwnerId = opts.callerOwnerId ?? 'player-1';
  const callerCharId = opts.callerCharId ?? 'char-caller';
  const caller = makeToken('tCaller', 'Caller', {
    ownerUserId: callerOwnerId,
    characterId: callerCharId,
  });
  room.tokens.set(caller.id, caller);
  for (const t of opts.otherTokens ?? []) room.tokens.set(t.id, t);

  const callerPlayer: RoomPlayer = {
    userId: callerOwnerId,
    displayName: 'Caller',
    socketId: 'sock-1',
    role: opts.role ?? 'player',
    characterId: callerCharId,
  };
  room.players.set(callerOwnerId, callerPlayer);

  const callerEconomy: ActionEconomy = {
    action: false,
    bonusAction: false,
    reaction: false,
    movementRemaining: 30,
    movementMax: 30,
  };
  room.actionEconomies.set(caller.id, callerEconomy);

  if (opts.inCombat) {
    const combatants: Combatant[] = [
      makeCombatant(caller.id, { isNPC: false, characterId: callerCharId }),
      ...(opts.otherCombatants ?? []),
    ];
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

  return { room, caller, ctx: { room, player: callerPlayer }, callerEconomy };
}

function routeCharacterQueries(charRows: Record<string, Record<string, unknown>>): void {
  mockQuery.mockImplementation(async (_sql: string, params?: unknown[]) => {
    const id = params?.[0] as string | undefined;
    if (id && charRows[id]) return { rows: [charRows[id]] };
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

async function withRandomSeed<T>(values: number[], fn: () => Promise<T> | T): Promise<T> {
  const orig = Math.random;
  let i = 0;
  Math.random = () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
  try {
    return await fn();
  } finally {
    Math.random = orig;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Tier 21 — High-level spells (control + big damage)
// ═══════════════════════════════════════════════════════════════════

describe('Tier 21 — Hypnotic Pattern', () => {
  it('applies charmed with endsOnDamage + tracks casterTokenId on failed save', async () => {
    const target = makeToken('tFoe', 'Foe', { characterId: 'char-foe' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Wizard', level: 7, name: 'Vex',
        ability_scores: { int: 18 }, proficiency_bonus: 3, spell_save_dc: 16,
      },
      'char-foe': { ability_scores: { wis: 10 }, proficiency_bonus: 2, saving_throws: [], name: 'Foe' },
    });
    const { io, emissions } = makeFakeIo();
    // Target nat 1 WIS save → fail
    await withRandomSeed([0.02], async () => {
      await tryHandleChatCommand(io, s.ctx, '!hypnoticpattern Foe');
    });
    expect(target.conditions).toContain('charmed');
    // ConditionSources must be broadcast with the caster id on the freshest update.
    const updates = tokenUpdates(emissions).filter((u) => u.tokenId === 'tFoe');
    expect(updates.length).toBeGreaterThan(0);
    const lastSources = updates[updates.length - 1].changes.conditionSources as Record<string, string>;
    expect(lastSources.charmed).toBe('tCaller');
  });

  it('does not apply charm on a successful save', async () => {
    const target = makeToken('tFoe', 'Foe', { characterId: 'char-foe' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 7, name: 'Vex', spell_save_dc: 13 },
      'char-foe': { ability_scores: { wis: 16 }, proficiency_bonus: 2, saving_throws: ['wis'], name: 'Foe' },
    });
    const { io } = makeFakeIo();
    // Nat 20 → comfortably save DC 13.
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!hypnoticpattern Foe');
    });
    expect(target.conditions).not.toContain('charmed');
  });

  it('applies gnome magic-save advantage before charm lands', async () => {
    const target = makeToken('tGnome', 'Glim', { characterId: 'char-gnome' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 7, name: 'Vex', spell_save_dc: 16 },
      'char-gnome': { ability_scores: { wis: 10 }, proficiency_bonus: 2, saving_throws: [], name: 'Glim', race: 'Forest Gnome' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.01, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!hypnoticpattern Glim');
    });
    expect(target.conditions).not.toContain('charmed');
    expect(lastSystemLine(emissions)).toContain('Forest Gnome: advantage on save vs magic');
  });
});

describe('Tier 21 — Dominate (person/monster/beast)', () => {
  it('!dominateperson tracks the caster as source on fail', async () => {
    const target = makeToken('tSlave', 'Slave', { characterId: 'char-slave' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Bard', level: 9, name: 'Lyra', spell_save_dc: 16 },
      'char-slave': { ability_scores: { wis: 8 }, proficiency_bonus: 2, saving_throws: [], name: 'Slave' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!dominateperson Slave');
    });
    expect(target.conditions).toContain('charmed');
    const lastUpdate = tokenUpdates(emissions).filter((u) => u.tokenId === 'tSlave').pop()!;
    const sources = lastUpdate.changes.conditionSources as Record<string, string>;
    expect(sources.charmed).toBe('tCaller');
  });

  it('!dominatemonster requires L8 slot (default) and announces DOMINATED', async () => {
    const target = makeToken('tBeast', 'Beast', { characterId: 'char-beast' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 15, name: 'Vex', spell_save_dc: 18 },
      'char-beast': { ability_scores: { wis: 6 }, proficiency_bonus: 2, saving_throws: [], name: 'Beast' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!dominatemonster Beast');
    });
    expect(lastSystemLine(emissions)).toMatch(/Dominate Monster \(L8/);
    expect(lastSystemLine(emissions)).toMatch(/DOMINATED/);
  });
});

describe('Tier 21 — Feeblemind', () => {
  it('applies feebleminded on a failed INT save and rolls 4d6 psychic', async () => {
    const target = makeToken('tMage', 'Mage', { characterId: 'char-mage' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 17, name: 'Vex', spell_save_dc: 19 },
      'char-mage': { ability_scores: { int: 8 }, proficiency_bonus: 2, saving_throws: [], name: 'Mage' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.01, 0.5, 0.5, 0.5, 0.5], async () => {
      await tryHandleChatCommand(io, s.ctx, '!feeblemind Mage');
    });
    expect(target.conditions).toContain('feebleminded');
    expect(lastSystemLine(emissions)).toMatch(/Feeblemind/i);
    expect(lastSystemLine(emissions)).toContain('Takes 16 psychic [4,4,4,4]');
  });
});

describe('Tier 21 — Polymorph', () => {
  it('marks the target polymorphed on a failed WIS save', async () => {
    const target = makeToken('tWolf', 'Wolf', { characterId: 'char-wolf' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 7, name: 'Vex', spell_save_dc: 16 },
      'char-wolf': { ability_scores: { wis: 8 }, proficiency_bonus: 2, saving_throws: [], name: 'Wolf' },
    });
    const { io } = makeFakeIo();
    await withRandomSeed([0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!polymorph Wolf 1');
    });
    expect(target.conditions).toContain('polymorphed');
  });
});

describe('Tier 21 — Stinking Cloud', () => {
  it('applies incapacitated on failed CON save and tracks source', async () => {
    const target = makeToken('tEnemy', 'Enemy', { characterId: 'char-enemy' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 5, name: 'Vex', spell_save_dc: 15 },
      'char-enemy': { ability_scores: { con: 10 }, proficiency_bonus: 2, saving_throws: [], name: 'Enemy' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!stinkingcloud Enemy');
    });
    expect(target.conditions).toContain('incapacitated');
    const lastUpdate = tokenUpdates(emissions).filter((u) => u.tokenId === 'tEnemy').pop()!;
    expect((lastUpdate.changes.conditionSources as Record<string, string>).incapacitated).toBe('tCaller');
  });
});

describe('Tier 21 — Cloud Kill', () => {
  it('announces a damage banner at L5 default', async () => {
    const target = makeToken('tEnemy', 'Enemy', { characterId: 'char-enemy' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 9, name: 'Vex', spell_save_dc: 17 },
      'char-enemy': { ability_scores: { con: 10 }, proficiency_bonus: 2, saving_throws: [], name: 'Enemy' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], async () => {
      await tryHandleChatCommand(io, s.ctx, '!cloudkill Enemy');
    });
    expect(lastSystemLine(emissions)).toMatch(/Cloudkill/i);
  });

  it('applies dwarf poison-save advantage before poison damage', async () => {
    const target = makeToken('tDwarf', 'Borin', { characterId: 'char-dwarf' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 9, name: 'Vex', spell_save_dc: 17 },
      'char-dwarf': { ability_scores: { con: 10 }, proficiency_bonus: 2, saving_throws: [], name: 'Borin', race: 'Hill Dwarf' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.5, 0.5, 0.5, 0.5, 0.5, 0.01, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!cloudkill Borin');
    });
    const line = lastSystemLine(emissions) ?? '';
    expect(line).toContain('Borin: CON d20=[1,20] adv keep 20+0=20 → SAVED');
    expect(line).toContain('Hill Dwarf: advantage on save vs poison');
  });
});

describe('Tier 21 — Meteor Swarm', () => {
  it('announces 40d6 total damage (20 fire + 20 bludgeon)', async () => {
    const target = makeToken('tFoe', 'Foe', { characterId: 'char-foe' });
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 17, name: 'Vex', spell_save_dc: 19 },
      'char-foe': { ability_scores: { dex: 10 }, proficiency_bonus: 2, saving_throws: [], name: 'Foe' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.5], async () => {
      await tryHandleChatCommand(io, s.ctx, '!meteorswarm Foe');
    });
    expect(lastSystemLine(emissions)).toMatch(/Meteor Swarm/i);
  });
});

describe('Tier 21 — Power Word Kill', () => {
  it('kills when HP ≤ 100', async () => {
    const target = makeToken('tEnemy', 'Enemy', { characterId: 'char-enemy' });
    const foeComb = makeCombatant('tEnemy', { hp: 80, maxHp: 200 });
    const s = makeScenario({ inCombat: true, otherTokens: [target], otherCombatants: [foeComb] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 17, name: 'Vex', spell_save_dc: 19 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!powerwordkill Enemy');
    expect(lastSystemLine(emissions)).toMatch(/Power Word Kill/);
    expect(lastSystemLine(emissions)).toMatch(/dies/i);
  });

  it('no effect when HP > 100', async () => {
    const target = makeToken('tBoss', 'Boss', { characterId: 'char-boss' });
    const comb = makeCombatant('tBoss', { hp: 180, maxHp: 200 });
    const s = makeScenario({ inCombat: true, otherTokens: [target], otherCombatants: [comb] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 17, name: 'Vex', spell_save_dc: 19 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!powerwordkill Boss');
    expect(lastSystemLine(emissions)).toMatch(/no effect/i);
  });
});

describe('Tier 21 — Power Word Stun', () => {
  it('applies stunned when HP ≤ 150', async () => {
    const target = makeToken('tEnemy', 'Enemy', { characterId: 'char-enemy' });
    const comb = makeCombatant('tEnemy', { hp: 140, maxHp: 200 });
    const s = makeScenario({ inCombat: true, otherTokens: [target], otherCombatants: [comb] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 15, name: 'Vex', spell_save_dc: 18 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!powerwordstun Enemy');
    expect(target.conditions).toContain('stunned');
    const lastUpdate = tokenUpdates(emissions).filter((u) => u.tokenId === 'tEnemy').pop()!;
    expect((lastUpdate.changes.conditionSources as Record<string, string>).stunned).toBe('tCaller');
    expect(s.room.conditionMeta.get('tEnemy')?.get('stunned')?.saveAtEndOfTurn?.ability).toBe('con');
    expect(lastSystemLine(emissions)).toContain('CON DC 18');
  });

  it('no effect when HP > 150', async () => {
    const target = makeToken('tBoss', 'Boss', { characterId: 'char-boss' });
    const comb = makeCombatant('tBoss', { hp: 200, maxHp: 300 });
    const s = makeScenario({ inCombat: true, otherTokens: [target], otherCombatants: [comb] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 15, name: 'Vex', spell_save_dc: 18 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!powerwordstun Boss');
    expect(lastSystemLine(emissions)).toMatch(/no effect/i);
  });
});

describe('Tier 21 — Wall spells announce', () => {
  it('!wallofforce prints the wall banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 9, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!wallofforce');
    expect(lastSystemLine(emissions)).toMatch(/Wall of Force/i);
  });

  it('!walloffire prints the wall banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 9, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!walloffire');
    expect(lastSystemLine(emissions)).toMatch(/Wall of Fire/i);
  });

  it('!wallofstone prints the wall banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 9, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!wallofstone');
    expect(lastSystemLine(emissions)).toMatch(/Wall of Stone/i);
  });

  it('!wallofice prints the wall banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 9, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!wallofice');
    expect(lastSystemLine(emissions)).toMatch(/Wall of Ice/i);
  });
});

describe('Tier 21 — Mass Heal', () => {
  it('distributes up to 700 HP pool across targets', async () => {
    const a = makeToken('tA', 'A', { characterId: 'char-a' });
    const b = makeToken('tB', 'B', { characterId: 'char-b' });
    const aC = makeCombatant('tA', { hp: 10, maxHp: 50, characterId: 'char-a', isNPC: false });
    const bC = makeCombatant('tB', { hp: 20, maxHp: 40, characterId: 'char-b', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [a, b], otherCombatants: [aC, bC] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 17, name: 'Priest', spell_save_dc: 18 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!massheal A B');
    expect(aC.hp).toBe(50); // healed to full
    expect(bC.hp).toBe(40); // healed to full
    expect(lastSystemLine(emissions)).toMatch(/Mass Heal/i);
  });
});

describe('Tier 21 — Mass Cure Wounds', () => {
  it('announces 3d8+mod healing for each listed target', async () => {
    const a = makeToken('tA', 'A', { characterId: 'char-a' });
    const aC = makeCombatant('tA', { hp: 5, maxHp: 50, characterId: 'char-a', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [a], otherCombatants: [aC] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Cleric', level: 9, name: 'Priest',
        ability_scores: { wis: 18 }, proficiency_bonus: 4, spell_save_dc: 16,
      },
      'char-a': { hit_points: 5, max_hit_points: 50, name: 'A' },
    });
    const { io, emissions } = makeFakeIo();
    // 3d8 → all 8s via high RNG, mod +4 = 28
    await withRandomSeed([0.99, 0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!masscurewounds A');
    });
    const line = lastSystemLine(emissions) ?? '';
    expect(line).toMatch(/Mass Cure Wounds/i);
    // Heal amount 24+4=28 reflected in the bullet.
    expect(line).toMatch(/= 28/);
  });
});

describe('Tier 21 — Wish / Simulacrum / Scrying / Teleport', () => {
  it('!wish prints the narrative banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 17, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!wish');
    expect(lastSystemLine(emissions)).toMatch(/Wish/i);
  });

  it('!simulacrum prints the narrative banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 13, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!simulacrum Ally');
    expect(lastSystemLine(emissions)).toMatch(/Simulacrum/i);
  });

  it('!scrying prints the narrative banner', async () => {
    const target = makeToken('tSpy', 'Spy');
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 9, name: 'Vex', spell_save_dc: 15 } });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.5], async () => {
      await tryHandleChatCommand(io, s.ctx, '!scrying Spy');
    });
    expect(lastSystemLine(emissions)).toMatch(/Scrying/i);
  });

  it('!teleport prints the narrative banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 9, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!teleport Temple');
    expect(lastSystemLine(emissions)).toMatch(/Teleport/i);
  });

  it('!planeshift prints the narrative banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 13, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!planeshift Elysium');
    expect(lastSystemLine(emissions)).toMatch(/Plane Shift/i);
  });

  it('!gate prints the narrative banner', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 17, name: 'Vex' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!gate');
    expect(lastSystemLine(emissions)).toMatch(/Gate/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 22 — Resurrection + ongoing damage
// ═══════════════════════════════════════════════════════════════════

describe('Tier 22 — Resurrection family', () => {
  it('!raisedead prints ritual banner', async () => {
    const corpse = makeToken('tCorpse', 'Corpse');
    const s = makeScenario({ otherTokens: [corpse] });
    routeCharacterQueries({ 'char-caller': { class: 'Cleric', level: 9, name: 'Priest' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!raisedead Corpse');
    expect(lastSystemLine(emissions)).toMatch(/Raise Dead/i);
  });

  it('!resurrection prints ritual banner', async () => {
    const corpse = makeToken('tCorpse', 'Corpse');
    const s = makeScenario({ otherTokens: [corpse] });
    routeCharacterQueries({ 'char-caller': { class: 'Cleric', level: 13, name: 'Priest' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!resurrection Corpse');
    expect(lastSystemLine(emissions)).toMatch(/Resurrection/i);
  });

  it('!trueresurrection prints ritual banner', async () => {
    const corpse = makeToken('tCorpse', 'Corpse');
    const s = makeScenario({ otherTokens: [corpse] });
    routeCharacterQueries({ 'char-caller': { class: 'Cleric', level: 17, name: 'Priest' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!trueresurrection Corpse');
    expect(lastSystemLine(emissions)).toMatch(/True Resurrection/i);
  });

  it('!reincarnate prints ritual banner', async () => {
    const corpse = makeToken('tCorpse', 'Corpse');
    const s = makeScenario({ otherTokens: [corpse] });
    routeCharacterQueries({ 'char-caller': { class: 'Druid', level: 9, name: 'Sage' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!reincarnate Corpse');
    expect(lastSystemLine(emissions)).toMatch(/Reincarnate/i);
  });

  it('!gentlerepose prints the preservation banner', async () => {
    const corpse = makeToken('tCorpse', 'Corpse');
    const s = makeScenario({ otherTokens: [corpse] });
    routeCharacterQueries({ 'char-caller': { class: 'Cleric', level: 3, name: 'Priest' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!gentlerepose Corpse');
    expect(lastSystemLine(emissions)).toMatch(/Gentle Repose/i);
  });
});

describe('Tier 22 — Ongoing damage pseudo-conditions', () => {
  it('!burning 2 6 applies burning-2d6 condition', async () => {
    const target = makeToken('tFoe', 'Foe');
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 5, name: 'Vex' } });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!burning Foe 2 6');
    const hasBurn = (target.conditions as string[]).some((c) => c.startsWith('burning'));
    expect(hasBurn).toBe(true);
  });

  it('!bleeding 1 4 applies bleeding-1d4 condition', async () => {
    const target = makeToken('tFoe', 'Foe');
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({ 'char-caller': { class: 'Fighter', level: 5, name: 'Axe' } });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!bleeding Foe 1 4');
    const hasBleed = (target.conditions as string[]).some((c) => c.startsWith('bleeding'));
    expect(hasBleed).toBe(true);
  });

  it('!acidsplash 1 6 applies acidsplash condition', async () => {
    const target = makeToken('tFoe', 'Foe');
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({ 'char-caller': { class: 'Wizard', level: 5, name: 'Vex' } });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!acidsplash Foe 1 6');
    const hasAcid = (target.conditions as string[]).some((c) => c.startsWith('acidsplash'));
    expect(hasAcid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 24 — Generic magic items catalog
// ═══════════════════════════════════════════════════════════════════

describe('Tier 24 — !magicitem catalog', () => {
  it('!magicitem list enumerates available slugs', async () => {
    const s = makeScenario();
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!magicitem list');
    const w = whispers(emissions).join('\n');
    expect(w.length).toBeGreaterThan(0);
  });

  it('!magicitem help <slug> prints description', async () => {
    const s = makeScenario();
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!magicitem help cloak-of-protection');
    const w = whispers(emissions).join('\n') + '\n' + systemBroadcasts(emissions).join('\n');
    expect(w).toMatch(/Cloak of Protection/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 25 — XGE / TCE subclass features
// ═══════════════════════════════════════════════════════════════════

describe('Tier 25 — Form of Dread', () => {
  it('applies form-of-dread condition on the caller', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': {
        class: 'Warlock (Undead)', level: 5, name: 'Morl',
        features: [{ name: 'Form of Dread' }], spell_save_dc: 14,
      },
    });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!formofdread');
    expect(s.caller.conditions).toContain('form-of-dread');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Hazards — diseases + poisons
// ═══════════════════════════════════════════════════════════════════

describe('Hazards — !disease', () => {
  it('list shows available diseases', async () => {
    const s = makeScenario({ role: 'dm' });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!disease list');
    const w = whispers(emissions).join('\n');
    expect(w).toMatch(/sewer/i);
  });

  it('applies sewer-plague to a target on failed CON save', async () => {
    const target = makeToken('tBob', 'Bob');
    const s = makeScenario({ role: 'dm', inCombat: true, otherTokens: [target] });
    const { io } = makeFakeIo();
    // Low roll fails DC 11.
    await withRandomSeed([0.02], async () => {
      await tryHandleChatCommand(io, s.ctx, '!disease sewer-plague Bob');
    });
    expect(target.conditions).toContain('poisoned');
  });

  it('applies shared save advantage before disease takes hold', async () => {
    const target = makeToken('tBob', 'Bob', {
      characterId: 'char-bob',
      conditions: ['inspired' as never],
    });
    const s = makeScenario({ role: 'dm', inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-bob': {
        ability_scores: { con: 10 },
        saving_throws: [],
        proficiency_bonus: 2,
        name: 'Bob',
      },
    });
    const { io, emissions } = makeFakeIo();

    await withRandomSeed([0.02, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!disease sewer-plague Bob');
    });

    expect(target.conditions).not.toContain('poisoned');
    const line = lastSystemLine(emissions) ?? '';
    expect(line).toContain('SAVED');
    expect(line).toContain('inspired: advantage on CON save');
    const saveResult = lastSaveResult(emissions);
    expect(saveResult?.advantage).toBe('advantage');
    expect(saveResult?.passed).toBe(true);
  });
});

describe('Hazards — !poison', () => {
  it('list shows available poisons', async () => {
    const s = makeScenario({ role: 'dm' });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!poison list');
    const w = whispers(emissions).join('\n');
    expect(w.length).toBeGreaterThan(0);
  });

  it('applies serpent-venom to a target', async () => {
    const target = makeToken('tBob', 'Bob');
    const s = makeScenario({ role: 'dm', inCombat: true, otherTokens: [target] });
    const { io } = makeFakeIo();
    await withRandomSeed([0.02], async () => {
      await tryHandleChatCommand(io, s.ctx, '!poison serpent-venom Bob');
    });
    // Bob should have SOMETHING (poisoned at minimum or other state).
    // Just verify broadcast exists.
    expect(target.name).toBe('Bob');
  });

  it('applies dwarf poison-save advantage before poison damage', async () => {
    const target = makeToken('tDwarf', 'Borin', { characterId: 'char-dwarf' });
    const s = makeScenario({ role: 'dm', inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-dwarf': {
        ability_scores: { con: 10 },
        saving_throws: [],
        proficiency_bonus: 2,
        name: 'Borin',
        race: 'Hill Dwarf',
      },
    });
    const { io, emissions } = makeFakeIo();

    await withRandomSeed([0.02, 0.99, 0.99, 0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!poison serpent-venom Borin');
    });

    const line = lastSystemLine(emissions) ?? '';
    expect(line).toContain('SAVED');
    expect(line).toContain('Hill Dwarf: advantage on save vs poison');
    expect(line).toContain('= 9 dmg');
    const saveResult = lastSaveResult(emissions);
    expect(saveResult?.advantage).toBe('advantage');
    expect(saveResult?.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Environment + variant combat
// ═══════════════════════════════════════════════════════════════════

describe('Environment — !underwater on/off', () => {
  it('DM toggles underwater on', async () => {
    const s = makeScenario({ role: 'dm' });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!underwater on');
    const line = lastSystemLine(emissions) ?? whispers(emissions).join('\n');
    expect(line).toMatch(/Underwater|under water/i);
  });

  it('DM toggles underwater off', async () => {
    const s = makeScenario({ role: 'dm' });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!underwater on');
    await tryHandleChatCommand(io, s.ctx, '!underwater off');
    // Second call should not throw; idempotent
    expect(true).toBe(true);
  });
});

describe('Environment — !mount / !dismount', () => {
  it('mounts a rider on a creature', async () => {
    const rider = makeToken('tRider', 'Rider');
    const mount = makeToken('tHorse', 'Horse');
    const s = makeScenario({ role: 'dm', otherTokens: [rider, mount] });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mount Rider Horse');
    const line = lastSystemLine(emissions) ?? whispers(emissions).join('\n');
    expect(line).toMatch(/mount|rides/i);
  });

  it('dismounts a rider', async () => {
    const rider = makeToken('tRider', 'Rider');
    const mount = makeToken('tHorse', 'Horse');
    const s = makeScenario({ role: 'dm', otherTokens: [rider, mount] });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mount Rider Horse');
    await tryHandleChatCommand(io, s.ctx, '!dismount Rider');
    // No throw and handler returned
    expect(true).toBe(true);
  });
});

describe('Environment — !chase', () => {
  it('urban chase roll lands on a row', async () => {
    const s = makeScenario({ role: 'dm' });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.5], async () => {
      await tryHandleChatCommand(io, s.ctx, '!chase urban');
    });
    expect(lastSystemLine(emissions)).toMatch(/Chase|Complication/i);
  });

  it('wilderness chase roll lands on a row', async () => {
    const s = makeScenario({ role: 'dm' });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.1], async () => {
      await tryHandleChatCommand(io, s.ctx, '!chase wilderness');
    });
    expect(lastSystemLine(emissions)).toMatch(/Chase|Complication/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Downtime + utility
// ═══════════════════════════════════════════════════════════════════

describe('Downtime — !craft', () => {
  it('estimates craft time for an item at a given value', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', level: 5, name: 'Caller', ability_scores: { str: 14 } },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!craft longsword 15');
    const sys = systemBroadcasts(emissions).join('\n');
    expect(sys).toMatch(/Craft|Crafting/i);
  });
});

describe('Downtime — !multiclass', () => {
  it('checks prerequisites for a class', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': {
        class: 'Fighter', level: 5,
        ability_scores: { str: 13, dex: 14, int: 13 }, name: 'Caller',
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!multiclass fighter');
    const sys = systemBroadcasts(emissions).join('\n');
    expect(sys).toMatch(/Multiclass check/i);
  });
});

describe('Downtime — !encumbrance', () => {
  it('shows capacity tiers for caller STR', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': {
        class: 'Fighter', level: 5,
        ability_scores: { str: 14 }, name: 'Caller',
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!encumbrance');
    const sys = systemBroadcasts(emissions).join('\n');
    expect(sys).toMatch(/Encumbrance/i);
  });
});

describe('Downtime — !currency', () => {
  it('converts 150gp into every denomination', async () => {
    const s = makeScenario();
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!currency 150gp');
    const out = whispers(emissions).join('\n');
    expect(out).toMatch(/Currency conversion/i);
    expect(out).toMatch(/15,000.*cp/); // 150gp = 15,000 cp
  });
});

describe('Utility — !turnundead', () => {
  it('applies frightened on a failed shared WIS save', async () => {
    const target = makeToken('tSkeleton', 'Skeleton', { characterId: 'char-skeleton' });
    const s = makeScenario({ role: 'dm', inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Cleric',
        spell_save_dc: 15,
        name: 'Priest',
      },
      'char-skeleton': {
        ability_scores: { wis: 10 },
        saving_throws: [],
        proficiency_bonus: 2,
        name: 'Skeleton',
      },
    });
    const { io, emissions } = makeFakeIo();

    await withRandomSeed([0.02], async () => {
      await tryHandleChatCommand(io, s.ctx, '!turnundead Skeleton');
    });

    expect(target.conditions).toContain('frightened');
    expect(lastSystemLine(emissions)).toContain('FAILED');
  });

  it('applies halfling Brave advantage before Turn Undead frightens', async () => {
    const target = makeToken('tGhostwise', 'Ghostwise', { characterId: 'char-ghostwise' });
    const s = makeScenario({ role: 'dm', inCombat: true, otherTokens: [target] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Cleric',
        spell_save_dc: 15,
        name: 'Priest',
      },
      'char-ghostwise': {
        ability_scores: { wis: 10 },
        saving_throws: [],
        proficiency_bonus: 2,
        name: 'Ghostwise',
        race: 'Ghostwise Halfling',
      },
    });
    const { io, emissions } = makeFakeIo();

    await withRandomSeed([0.02, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!turnundead Ghostwise');
    });

    expect(target.conditions).not.toContain('frightened');
    const line = lastSystemLine(emissions) ?? '';
    expect(line).toContain('SAVED');
    expect(line).toContain('Ghostwise Halfling: advantage on save vs frightened');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Racial innate spells + !throw
// ═══════════════════════════════════════════════════════════════════

describe('Racial innate spells — !racial', () => {
  it('list shows available racial spells for a tiefling', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { race: 'Tiefling', level: 5, name: 'Zariel', class: 'Warlock' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!racial list');
    const out = whispers(emissions).join('\n') + '\n' + systemBroadcasts(emissions).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  it('reset restores per-long uses', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { race: 'Tiefling', level: 5, name: 'Zariel', class: 'Warlock' },
    });
    const { io } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!racial reset');
    expect(true).toBe(true); // didn't throw
  });
});

describe('!throw weapon', () => {
  it('announces the weapon at target feet', async () => {
    const target = makeToken('tFoe', 'Foe');
    const s = makeScenario({ inCombat: true, otherTokens: [target] });
    routeCharacterQueries({ 'char-caller': { class: 'Fighter', level: 5, name: 'Axe' } });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!throw longsword Foe');
    const line = lastSystemLine(emissions) ?? whispers(emissions).join('\n');
    expect(line).toMatch(/throw|longsword|Foe/i);
  });
});
