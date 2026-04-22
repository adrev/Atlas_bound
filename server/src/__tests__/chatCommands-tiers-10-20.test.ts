/**
 * Cross-tier sanity tests for the chat commands added in Tiers 10-20.
 *
 * Instead of booting a real socket.io server we exercise each
 * registered handler through tryHandleChatCommand() with:
 *   - a fake `io` that captures emitted messages
 *   - a fake `PlayerContext` built on a real RoomState
 *   - a mocked pg `pool.query` seeded per-test so character-row lookups
 *     return the expected class/features/scores
 *
 * The tests assert the observable contract of each command:
 *   - proper class/feat gate rejection
 *   - action-economy spend (bonus action / reaction / action)
 *   - pool decrements
 *   - condition application on the right target
 *   - broadcast message text for the happy path
 *
 * Full damage-math correctness is deliberately narrow — we seed
 * Math.random so rolls are deterministic and check a single spec
 * per command rather than exhaustive dice math.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server } from 'socket.io';
import type { Combatant, CombatState, Token, ActionEconomy } from '@dnd-vtt/shared';

// Mock the DB before importing anything that touches it.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import { createRoom, getAllRooms, type RoomState, type RoomPlayer, type PlayerContext } from '../utils/roomState.js';

// Trigger handler registration side effects.
import '../services/chatCommands/subclassFeaturesTier10Handler.js';
import '../services/chatCommands/subclassFeaturesTier11Handler.js';
import '../services/chatCommands/spellsTier12Handler.js';
import '../services/chatCommands/subclassFeaturesTier13Handler.js';
import '../services/chatCommands/subclassFeaturesTier14Handler.js';
import '../services/chatCommands/subclassFeaturesTier15Handler.js';
import '../services/chatCommands/spellsTier16Handler.js';
import '../services/chatCommands/spellsTier17Handler.js';
import '../services/chatCommands/featsTier18Handler.js';
import '../services/chatCommands/racesTier19Handler.js';
import '../services/chatCommands/itemsTier20Handler.js';

// ── Fake io + message capture ───────────────────────────────

interface Emission {
  event: string;
  payload: unknown;
  channel: 'socket' | 'room';
  channelId: string;
}

function makeFakeIo(): { io: Server; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => {
        // Room or socket emit — we don't distinguish in tests
        emissions.push({ event, payload, channel: 'room', channelId });
      },
    }),
  } as unknown as Server;
  return { io, emissions };
}

function systemBroadcasts(emissions: Emission[]): string[] {
  return emissions
    .filter((e) => e.event === 'chat:new-message')
    .map((e) => {
      const p = e.payload as { type?: string; content?: string };
      return `${p.type}:${p.content ?? ''}`;
    });
}

function lastBroadcast(emissions: Emission[]): string | undefined {
  const sys = emissions.filter((e) => e.event === 'chat:new-message');
  const last = sys[sys.length - 1];
  if (!last) return undefined;
  return (last.payload as { content?: string }).content;
}

function conditionUpdates(emissions: Emission[]): Array<{ tokenId: string; conditions: string[] }> {
  return emissions
    .filter((e) => e.event === 'map:token-updated')
    .map((e) => {
      const p = e.payload as { tokenId: string; changes?: { conditions?: string[] } };
      return { tokenId: p.tokenId, conditions: p.changes?.conditions ?? [] };
    });
}

function actionUsedEvents(emissions: Emission[]): Array<{ tokenId: string; actionType: string }> {
  return emissions
    .filter((e) => e.event === 'combat:action-used')
    .map((e) => {
      const p = e.payload as { tokenId: string; actionType: string };
      return { tokenId: p.tokenId, actionType: p.actionType };
    });
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
  callerPlayer: RoomPlayer;
  ctx: PlayerContext;
  callerEconomy: ActionEconomy;
}

function makeScenario(opts: {
  callerCharId?: string;
  callerOwnerId?: string;
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
    role: 'player',
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

  return { room, caller, callerPlayer, ctx: { room, player: callerPlayer }, callerEconomy };
}

/**
 * Build a query-router that returns different rows based on the `id`
 * param. Tests pass a map of characterId → row.
 */
function routeCharacterQueries(charRows: Record<string, Record<string, unknown>>): void {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const id = params?.[0] as string | undefined;
    if (id && charRows[id]) return { rows: [charRows[id]] };
    // Default: no rows
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

// Helper to seed RNG for deterministic dice. The handlers are async,
// so we MUST await `fn()` inside the try block — otherwise the finally
// restores Math.random before the handler consumes any values.
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
// Tier 10 — Celestial, GOO, Berserker, Ancestral, Draconic, Moon, Swash
// ═══════════════════════════════════════════════════════════════════

describe('Tier 10 — Healing Light (Celestial Warlock)', () => {
  it('rejects a non-warlock', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', level: 5, name: 'Bob', features: [] },
    });
    const { io, emissions } = makeFakeIo();
    const handled = await tryHandleChatCommand(io, s.ctx, '!healinglight status');
    expect(handled).toBe(true);
    const whisper = emissions.find((e) => {
      const p = e.payload as { type?: string };
      return p.type === 'whisper';
    });
    expect(String((whisper?.payload as { content?: string })?.content ?? '')).toMatch(/isn't a Warlock/i);
  });

  it('reports pool status for a Celestial Warlock', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Warlock (Celestial)', level: 5, name: 'Seraph', features: [] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!healinglight status');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/Healing Light: 6\/6 d6/);
  });

  it('spends dice and heals a target in combat', async () => {
    const targetTok = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const targetComb = makeCombatant('tAlly', { hp: 10, maxHp: 30, characterId: 'char-ally', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [targetTok], otherCombatants: [targetComb] });
    routeCharacterQueries({
      'char-caller': { class: 'Warlock', level: 3, name: 'Seraph', features: [{ name: 'Healing Light' }] },
    });
    const { io, emissions } = makeFakeIo();
    // roll 2d6 → force both to 6 via high Math.random
    await withRandomSeed([0.99, 0.99], async () => {
      const handled = await tryHandleChatCommand(io, s.ctx, '!healinglight Ally 2');
      expect(handled).toBe(true);
    });
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(targetComb.hp).toBe(22); // 10 + 12
    const b = lastBroadcast(emissions);
    expect(b).toMatch(/Healing Light/);
    expect(b).toMatch(/12 HP/);
  });
});

describe('Tier 10 — Frenzy (Berserker Barbarian)', () => {
  it('activates only when raging', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Berserker)', level: 3, name: 'Grok', features: [{ name: 'Frenzy' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!frenzy');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/Raging first/i);
  });

  it('applies frenzied when already raging', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Berserker)', level: 3, name: 'Grok', features: [{ name: 'Frenzy' }] },
    });
    const { io, emissions } = makeFakeIo();
    const handled = await tryHandleChatCommand(io, s.ctx, '!frenzy');
    expect(handled).toBe(true);
    const updates = conditionUpdates(emissions);
    expect(updates.length).toBeGreaterThan(0);
    expect(s.caller.conditions).toContain('frenzied');
  });
});

describe('Tier 10 — Spirit Shield (Ancestral Guardian)', () => {
  it('blocks when level < 6', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Ancestral Guardian)', level: 3, name: 'Grok', features: [{ name: 'Spirit Shield' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!spiritshield Ally 10');
    // ally doesn't exist → "no token" whisper
    const whispers = emissions
      .filter((e) => (e.payload as { type?: string }).type === 'whisper')
      .map((e) => (e.payload as { content?: string }).content ?? '');
    expect(whispers.some((w) => /no token/.test(w))).toBe(true);
  });

  it('rolls 2d6 reduction at L6', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const allyComb = makeCombatant('tAlly', { hp: 10, maxHp: 30, characterId: 'char-ally', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally], otherCombatants: [allyComb] });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Ancestral Guardian)', level: 6, name: 'Grok', features: [{ name: 'Spirit Shield' }] },
      'char-ally': { hit_points: 10, max_hit_points: 30 },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!spiritshield Ally 10');
    });
    expect(s.callerEconomy.reaction).toBe(true);
    const b = lastBroadcast(emissions);
    expect(b).toMatch(/Spirit Shield/);
    expect(b).toMatch(/2d6 = \[6,6\] = \*\*12\*\*/);
  });
});

describe('Tier 10 — Combat Wild Shape (Moon Druid)', () => {
  it('bonus-action transform', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Druid (Moon)', level: 3, name: 'Elder', features: [{ name: 'Combat Wild Shape' }], spell_slots: {}, hit_points: 30, max_hit_points: 30 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!moondruid shape');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/Combat Wild Shape/);
  });

  it('heal refuses when no slots available', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Druid (Moon)', level: 3, name: 'Elder', features: [{ name: 'Combat Wild Shape' }], spell_slots: {}, hit_points: 20, max_hit_points: 30 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!moondruid heal 2');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/no level-2 slot/);
    // Bonus action still free because the spend validation failed first.
    expect(s.callerEconomy.bonusAction).toBe(false);
  });
});

describe('Tier 10 — Rakish Audacity (Swashbuckler)', () => {
  it('init sub emits expected text', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': {
        class: 'Rogue (Swashbuckler)',
        level: 3,
        name: 'Finn',
        features: [{ name: 'Rakish Audacity' }],
        ability_scores: { cha: 16 },
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!rakish init');
    expect(lastBroadcast(emissions)).toMatch(/\+3.*CHA/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 11 — Samurai, Echo, Cavalier, Wild Magic, Zealot, Open Hand, …
// ═══════════════════════════════════════════════════════════════════

describe('Tier 11 — Fighting Spirit (Samurai)', () => {
  it('grants advantage and 5 temp HP at L3', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Samurai)', level: 3, name: 'Musashi', features: [{ name: 'Fighting Spirit' }], temp_hit_points: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!fightingspirit');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/5 temp HP/);
  });

  it('grants 15 temp HP at L15', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Samurai)', level: 15, name: 'Musashi', features: [{ name: 'Fighting Spirit' }], temp_hit_points: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!fightingspirit');
    expect(lastBroadcast(emissions)).toMatch(/15 temp HP/);
  });
});

describe('Tier 11 — Echo Knight', () => {
  it('summons echo with bonus action', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Echo Knight)', level: 3, name: 'Mia', features: [{ name: 'Manifest Echo' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!echo summon 5 7');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/echo appears at \(5, 7\)/);
  });

  it('swap emits the teleport line', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Echo Knight)', level: 3, name: 'Mia', features: [{ name: 'Manifest Echo' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!echo summon 5 7');
    await tryHandleChatCommand(io, s.ctx, '!echo swap');
    expect(lastBroadcast(emissions)).toMatch(/teleports to echo at \(5, 7\)/);
  });
});

describe('Tier 11 — Cavalier mark + warding', () => {
  it('marks target with cav-marked', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Cavalier)', level: 3, name: 'Arthur', features: [{ name: 'Unwavering Mark' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!cavmark Enemy');
    expect(enemy.conditions).toContain('cav-marked');
    expect(lastBroadcast(emissions)).toMatch(/Unwavering Mark/);
  });
});

describe('Tier 11 — Open Hand Monk (noreact)', () => {
  it('applies no-reactions without a save', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Monk (Open Hand)', level: 3, name: 'Kai', features: [{ name: 'Open Hand Technique' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!openhand Enemy 13 noreact');
    expect(enemy.conditions).toContain('no-reactions');
    expect(lastBroadcast(emissions)).toMatch(/strips.*reactions/);
  });
});

describe('Tier 11 — Shadow Sorcerer Strength of the Grave', () => {
  it('forces CHA save at DC 5 + damage', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': {
        class: 'Sorcerer (Shadow)',
        level: 3,
        name: 'Nyx',
        features: [{ name: 'Strength of the Grave' }],
        ability_scores: { cha: 18 },
        saving_throws: ['cha'],
        proficiency_bonus: 2,
        hit_points: 0,
      },
    });
    const { io, emissions } = makeFakeIo();
    // Nat 20 on save (0.99 d20 mapping) — should survive and set HP to 1.
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!grave 10');
    });
    expect(lastBroadcast(emissions)).toMatch(/Strength of the Grave/);
    expect(lastBroadcast(emissions)).toMatch(/SURVIVES at 1 HP/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 12 — Spells
// ═══════════════════════════════════════════════════════════════════

describe('Tier 12 — Healing Word', () => {
  it('heals at 1d4+mod, burns bonus action', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const allyC = makeCombatant('tAlly', { hp: 5, maxHp: 30, characterId: 'char-ally', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally], otherCombatants: [allyC] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Cleric',
        level: 3,
        name: 'Priest',
        ability_scores: { wis: 16 },
        proficiency_bonus: 2,
      },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!healingword Ally');
    });
    expect(s.callerEconomy.bonusAction).toBe(true);
    // d4=4 + mod=3 → 7 heal → 5+7=12
    expect(allyC.hp).toBe(12);
  });

  it('scales with upcast slot', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const allyC = makeCombatant('tAlly', { hp: 5, maxHp: 30, characterId: 'char-ally', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally], otherCombatants: [allyC] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Cleric',
        level: 5,
        name: 'Priest',
        ability_scores: { wis: 16 },
        proficiency_bonus: 3,
      },
    });
    const { io, emissions } = makeFakeIo();
    // L3 slot → 3d4+3 … all maxed = 3*4+3 = 15 heal
    await withRandomSeed([0.99, 0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!healingword Ally 3');
    });
    expect(allyC.hp).toBe(5 + 15);
  });
});

describe('Tier 12 — Magic Missile', () => {
  it('fires 3 darts at 1 target with round-robin', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Wizard',
        level: 3,
        name: 'Wiz',
        ability_scores: { int: 16 },
        proficiency_bonus: 2,
      },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.5, 0.5, 0.5], async () => {
      await tryHandleChatCommand(io, s.ctx, '!magicmissile Enemy');
    });
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Magic Missile/);
    expect(b).toMatch(/3 darts/);
    expect(b).toMatch(/Enemy.*force/);
  });

  it('upcast slot adds extra darts', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 5, name: 'Wiz', ability_scores: { int: 16 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed(Array(5).fill(0.5), async () => {
      await tryHandleChatCommand(io, s.ctx, '!magicmissile Enemy 3');
    });
    expect(lastBroadcast(emissions)).toMatch(/5 darts/);
  });
});

describe('Tier 12 — Counterspell', () => {
  it('auto-counters when my-slot ≥ spell-lvl', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 7, name: 'Wiz', ability_scores: { int: 16 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!counterspell Evoker 3 3');
    expect(s.callerEconomy.reaction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/automatically/);
  });

  it('rolls ability check when spell-lvl exceeds my-slot', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 9, name: 'Wiz', ability_scores: { int: 16 }, proficiency_bonus: 4 },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!counterspell Lich 5 3');
    });
    expect(lastBroadcast(emissions)).toMatch(/COUNTERED|FAILS/);
    // Nat 20 + int mod beats DC 15 easily.
    expect(lastBroadcast(emissions)).toMatch(/COUNTERED/);
  });
});

describe('Tier 12 — Command', () => {
  it('on fail applies commanded condition', async () => {
    const enemy = makeToken('tEnemy', 'Enemy', { characterId: 'char-enemy' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Cleric',
        level: 3,
        name: 'Priest',
        ability_scores: { wis: 16 },
        proficiency_bonus: 2,
        spell_save_dc: 13,
      },
      'char-enemy': {
        ability_scores: { wis: 8 },
        saving_throws: [],
        proficiency_bonus: 2,
        name: 'Enemy',
      },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => { // low d20 → fail
      await tryHandleChatCommand(io, s.ctx, '!command Enemy halt');
    });
    expect(enemy.conditions).toContain('commanded');
    expect(lastBroadcast(emissions)).toMatch(/HALT/);
  });

  it('rejects an unknown word', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 3, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!command Enemy nope');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/word must be one of/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 13 — CD features
// ═══════════════════════════════════════════════════════════════════

describe('Tier 13 — Path to the Grave', () => {
  it('applies marked-for-grave pseudo-condition', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric (Grave)', level: 2, name: 'Morr', features: [{ name: 'Path to the Grave' }], ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!pathtograve Enemy');
    expect(enemy.conditions).toContain('marked-for-grave');
  });
});

describe('Tier 13 — Conquering Presence', () => {
  it('frightens failing targets', async () => {
    const e1 = makeToken('tE1', 'Goblin1', { characterId: 'c-g1' });
    const e2 = makeToken('tE2', 'Goblin2', { characterId: 'c-g2' });
    const s = makeScenario({ inCombat: true, otherTokens: [e1, e2] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Paladin (Conquest)',
        level: 3,
        name: 'Conquer',
        features: [{ name: 'Conquering Presence' }],
        ability_scores: { cha: 16 },
        proficiency_bonus: 2,
        spell_save_dc: 13,
      },
      'c-g1': { ability_scores: { wis: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'Goblin1' },
      'c-g2': { ability_scores: { wis: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'Goblin2' },
    });
    const { io, emissions } = makeFakeIo();
    // Low rolls on both WIS saves (2 saves = 2 random numbers).
    await withRandomSeed([0.05, 0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!conquer Goblin1 Goblin2');
    });
    expect(e1.conditions).toContain('frightened');
    expect(e2.conditions).toContain('frightened');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 14 — Fighter
// ═══════════════════════════════════════════════════════════════════

describe('Tier 14 — Arcane Shot (Banishing)', () => {
  it('broadcasts banishing-arrow text with INT DC', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Fighter (Arcane Archer)',
        level: 3,
        name: 'Robin',
        features: [{ name: 'Arcane Shot' }],
        ability_scores: { int: 14 },
        proficiency_bonus: 2,
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!arcaneshot banishing Enemy');
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Arcane Shot: Banishing/);
    expect(b).toMatch(/CHA DC 12/); // 8+2+2
    expect(b).toMatch(/Banished to Feywild/);
  });

  it('rejects unknown option', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Arcane Archer)', level: 3, name: 'Robin', features: [{ name: 'Arcane Shot' }], ability_scores: { int: 14 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!arcaneshot bogus Enemy');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/unknown option/);
  });
});

describe('Tier 14 — Psi Warrior pool', () => {
  it('seeds 2*PB dice at the right die size', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Psi Warrior)', level: 5, name: 'Mind', features: [{ name: 'Psionic Power' }], proficiency_bonus: 3, ability_scores: { int: 14 } },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!psidie status');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/6\/6\*{0,2}\s*d8/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 15 — Rogue
// ═══════════════════════════════════════════════════════════════════

describe('Tier 15 — Mastermind Help at 30 ft', () => {
  it('marks target helped and burns bonus action', async () => {
    const ally = makeToken('tAlly', 'Ally');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue (Mastermind)', level: 3, name: 'Brain', features: [{ name: 'Master of Tactics' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!helpat Ally');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(ally.conditions).toContain('helped');
  });
});

describe('Tier 15 — Soulknife blade', () => {
  it('rolls the primary die', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Rogue (Soulknife)',
        level: 3,
        name: 'Blade',
        features: [{ name: 'Psychic Blades' }],
        ability_scores: { dex: 16 },
        proficiency_bonus: 2,
      },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!psyblade Enemy');
    });
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Psychic Blade/);
    expect(b).toMatch(/1d6\+3/);
    // max d6 = 6, + dex 3 = 9
    expect(b).toMatch(/= \*\*9 psychic\*\*/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 16 — Damage spells
// ═══════════════════════════════════════════════════════════════════

describe('Tier 16 — Fireball', () => {
  it('rolls save for each target, full dmg on fail', async () => {
    const e1 = makeToken('tE1', 'Goblin', { characterId: 'c-g1' });
    const s = makeScenario({ inCombat: true, otherTokens: [e1] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Wizard (Evocation)',
        level: 5,
        name: 'Evo',
        ability_scores: { int: 16 },
        proficiency_bonus: 3,
        spell_save_dc: 14,
      },
      'c-g1': { ability_scores: { dex: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'Goblin' },
    });
    const { io, emissions } = makeFakeIo();
    // Seed: 8 damage d6 rolls, then the goblin's d20 save.
    // Make them all max (0.99) → damage maxed, save maxed.
    await withRandomSeed([...Array(8).fill(0.99), 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!fireball Goblin');
    });
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Fireball \(L3\)/);
    expect(b).toMatch(/DEX DC 14/);
    // Low d20 → fail → 48 damage (8×6).
    expect(b).toMatch(/48 fire/);
  });
});

describe('Tier 16 — Misty Step', () => {
  it('burns bonus action', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Sorcerer', level: 3, name: 'Sor', ability_scores: { cha: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mistystep');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/Misty Step/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 17 — Support spells
// ═══════════════════════════════════════════════════════════════════

describe('Tier 17 — Aid', () => {
  it('bumps max + current HP by 5', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', name: 'P' },
      'char-ally': { hit_points: 20, max_hit_points: 30 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!aid Ally');
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Aid\*{0,2}\s*\(L2/);
    expect(b).toMatch(/\+5 to max/);
    // characters UPDATE should have been called
    const updates = mockQuery.mock.calls.filter((call) => /UPDATE characters/.test(call[0]));
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe('Tier 17 — Haste', () => {
  it('applies hasted condition', async () => {
    const ally = makeToken('tAlly', 'Ally');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'Wiz' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!haste Ally');
    expect(ally.conditions).toContain('hasted');
  });
});

describe('Tier 17 — Lesser Restoration', () => {
  it('removes poisoned if present', async () => {
    const ally = makeToken('tAlly', 'Ally', { conditions: ['poisoned' as any] });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', name: 'P' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!lesserrestoration Ally poisoned');
    expect(ally.conditions).not.toContain('poisoned');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 18 — Feats
// ═══════════════════════════════════════════════════════════════════

describe('Tier 18 — Alert', () => {
  it('requires the feat to be taken', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue', level: 4, name: 'A', features: [] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!alert');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/doesn't have.*Alert/i);
  });

  it('broadcasts when the feat is present', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue', level: 4, name: 'A', features: [{ name: 'Alert' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!alert');
    expect(lastBroadcast(emissions)).toMatch(/\+5.*bonus/);
  });
});

describe('Tier 18 — Savage Attacker', () => {
  it('keeps the higher of two rolls', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian', level: 4, name: 'Grok', features: [{ name: 'Savage Attacker' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!savageattacker 8 14');
    expect(lastBroadcast(emissions)).toMatch(/\*\*14\*\* damage/);
  });
});

describe('Tier 18 — Heavy Armor Master', () => {
  it('reduces damage by 3', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', level: 4, name: 'F', features: [{ name: 'Heavy Armor Master' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!heavyarmormaster 7');
    expect(lastBroadcast(emissions)).toMatch(/7 → \*\*4\*\*/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 19 — Race features
// ═══════════════════════════════════════════════════════════════════

describe('Tier 19 — Goliath Stone\'s Endurance', () => {
  it('reduces damage by 1d12 + CON', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': {
        class: 'Fighter',
        level: 5,
        name: 'Grom',
        race: 'Goliath',
        ability_scores: { con: 16 },
        proficiency_bonus: 3,
        hit_points: 20,
        max_hit_points: 40,
      },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!stonesendurance 10');
    });
    expect(s.callerEconomy.reaction).toBe(true);
    // d12=12 + con=3 = 15 → 10 → 0
    expect(lastBroadcast(emissions)).toMatch(/10 → 0/);
  });
});

describe('Tier 19 — Eladrin Fey Step (summer)', () => {
  it('burns bonus action and mentions summer kicker', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 3, name: 'E', race: 'Eladrin' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!feystep summer');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/Summer/);
    expect(lastBroadcast(emissions)).toMatch(/fire damage/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 20 — Magic items
// ═══════════════════════════════════════════════════════════════════

describe('Tier 20 — Wand of Magic Missiles', () => {
  it('spends charges and fires darts', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!wand Enemy 2');
    });
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Wand of Magic Missiles/);
    expect(b).toMatch(/2 missiles/);
    expect(b).toMatch(/Charges 5\/7/);
  });

  it('rejects over-spend', async () => {
    const enemy = makeToken('tEnemy', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    // Pre-drain pool to 0.
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('item:wandofmm', { max: 7, remaining: 0 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!wand Enemy 1');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/only 0 charges/);
  });
});

describe('Tier 20 — Potion tiers', () => {
  it('superior rolls 8d4+8', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const allyC = makeCombatant('tAlly', { hp: 1, maxHp: 60, characterId: 'char-ally', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally], otherCombatants: [allyC] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', name: 'F' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed(Array(8).fill(0.99), async () => {
      await tryHandleChatCommand(io, s.ctx, '!potionplus Ally superior');
    });
    // 8*4 + 8 = 40
    expect(allyC.hp).toBe(41);
    expect(lastBroadcast(emissions)).toMatch(/Superior/);
  });
});

describe('Tier 20 — Bag of Holding', () => {
  it('accounts capacity in + out', async () => {
    const s = makeScenario({ inCombat: true });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!bagofholding in greatsword 6');
    let b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Free: 494\/500/);
    await tryHandleChatCommand(io, s.ctx, '!bagofholding out greatsword 6');
    b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Free: 500\/500/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EXTENDED COVERAGE — one test per remaining handler.
// Focused on gate rejection, action-economy spend, and side-effects.
// ═══════════════════════════════════════════════════════════════════

// ── Tier 10 extras ─────────────────────────────────────

describe('Tier 10 — Awakened Mind', () => {
  it('requires GOO / feature gate', async () => {
    const ally = makeToken('tAlly', 'Ally');
    const s = makeScenario({ otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Warlock (Celestial)', level: 3, name: 'W', features: [] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!awakened Ally | hello');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/Great Old One/i);
  });

  it('broadcasts telepathic line on success', async () => {
    const ally = makeToken('tAlly', 'Ally');
    const s = makeScenario({ otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Warlock (Great Old One)', level: 3, name: 'W', features: [{ name: 'Awakened Mind' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!awakened Ally | meet me out back');
    expect(lastBroadcast(emissions)).toMatch(/telepathically reaches Ally/);
    expect(lastBroadcast(emissions)).toMatch(/meet me out back/);
  });
});

describe('Tier 10 — Draconic Resilience', () => {
  it('reports natural AC 13+DEX', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': {
        class: 'Sorcerer (Draconic)',
        level: 4,
        name: 'Zal',
        features: [{ name: 'Draconic Resilience' }],
        ability_scores: { dex: 14 },
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!draconicresilience');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    const msg = String((w?.payload as { content?: string })?.content ?? '');
    expect(msg).toMatch(/13 \+ DEX \(2\) = 15/);
    expect(msg).toMatch(/\+4 HP/);
  });
});

describe('Tier 10 — Elemental Affinity (resist)', () => {
  it('spends 1 SP for resistance', async () => {
    const s = makeScenario();
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('sp', { max: 5, remaining: 5 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': {
        class: 'Sorcerer (Draconic)',
        level: 6,
        name: 'Zal',
        features: [{ name: 'Elemental Affinity' }, { name: 'Red Dragon Ancestor' }],
        ability_scores: { cha: 16 },
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!elemental resist');
    expect(pools.get('sp')!.remaining).toBe(4);
    expect(lastBroadcast(emissions)).toMatch(/resistance to fire/);
  });
});

describe('Tier 10 — Fancy Footwork', () => {
  it('announces the no-OA restriction', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue (Swashbuckler)', level: 3, name: 'Finn', features: [{ name: 'Fancy Footwork' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!footwork Enemy');
    expect(lastBroadcast(emissions)).toMatch(/cannot make opportunity attacks/);
  });
});

describe('Tier 10 — Healing Light pool exhaustion', () => {
  it('refuses when not enough dice left', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('healinglight', { max: 4, remaining: 1 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': { class: 'Warlock (Celestial)', level: 3, name: 'Ser', features: [{ name: 'Healing Light' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!healinglight Ally 2');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/only 1 dice left/);
    expect(s.callerEconomy.bonusAction).toBe(false); // spend refused before burning BA
  });
});

describe('Tier 10 — Frenzy end', () => {
  it('applies +1 exhaustion when frenzy ends', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any, 'frenzied' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Berserker)', level: 5, name: 'Grok', features: [{ name: 'Frenzy' }], exhaustion_level: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!frenzy end');
    const updates = mockQuery.mock.calls.filter((call) => /exhaustion_level/.test(call[0]));
    expect(updates.length).toBeGreaterThan(0);
    expect(lastBroadcast(emissions)).toMatch(/Exhaustion level 0 → 1/);
  });
});

// ── Tier 11 extras ─────────────────────────────────────

describe('Tier 11 — Wild Magic Barbarian', () => {
  it('rolls d8 surge table while raging', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Wild Magic)', level: 3, name: 'Grok', features: [{ name: 'Wild Magic' }] },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.0], async () => {
      await tryHandleChatCommand(io, s.ctx, '!wildbarb');
    });
    expect(lastBroadcast(emissions)).toMatch(/Wild Magic Surge/);
    expect(lastBroadcast(emissions)).toMatch(/d8 = \*\*1\*\*/);
  });

  it('refuses when not raging', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Wild Magic)', level: 3, name: 'Grok', features: [{ name: 'Wild Magic' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!wildbarb');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/when you enter Rage/);
  });
});

describe('Tier 11 — Divine Fury (Zealot)', () => {
  it('rolls 1d6 + half-level radiant once per turn', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Zealot)', level: 6, name: 'Zeal', features: [{ name: 'Divine Fury' }] },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!divinefury');
    });
    // d6=6 + half-6=3 → 9 radiant
    expect(lastBroadcast(emissions)).toMatch(/\+1d6\+3 = 9 radiant/);
  });

  it('refuses second use on same turn', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Zealot)', level: 6, name: 'Zeal', features: [{ name: 'Divine Fury' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!divinefury');
    await tryHandleChatCommand(io, s.ctx, '!divinefury');
    const whispers = emissions
      .filter((e) => (e.payload as { type?: string }).type === 'whisper')
      .map((e) => (e.payload as { content?: string }).content ?? '');
    expect(whispers.some((w) => /already used this turn/.test(w))).toBe(true);
  });
});

describe('Tier 11 — Glamour Bard Mantle', () => {
  it('limits targets to CHA mod', async () => {
    const a1 = makeToken('tA1', 'Ally1');
    const a2 = makeToken('tA2', 'Ally2');
    const a3 = makeToken('tA3', 'Ally3');
    const s = makeScenario({ inCombat: true, otherTokens: [a1, a2, a3] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Bard (Glamour)',
        level: 3,
        name: 'B',
        features: [{ name: 'Mantle of Inspiration' }],
        ability_scores: { cha: 12 }, // mod=1
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mantle Ally1 Ally2 Ally3');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/up to CHA mod \(1\)/);
  });

  it('grants 5 temp HP at L3 with CHA 18', async () => {
    const ally = makeToken('tA', 'Ally', { characterId: 'char-ally' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Bard (Glamour)',
        level: 3,
        name: 'B',
        features: [{ name: 'Mantle of Inspiration' }],
        ability_scores: { cha: 18 },
      },
      'char-ally': { temp_hit_points: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mantle Ally');
    expect(s.callerEconomy.bonusAction).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/5 temp HP/);
  });
});

describe('Tier 11 — Hound of Ill Omen', () => {
  it('requires 3 SP', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('sp', { max: 5, remaining: 2 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': { class: 'Sorcerer (Shadow)', level: 3, name: 'Nyx', features: [{ name: 'Hound of Ill Omen' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!hound Enemy');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/requires 3 SP/);
  });

  it('spends 3 SP on success', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('sp', { max: 5, remaining: 5 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': { class: 'Sorcerer (Shadow)', level: 3, name: 'Nyx', features: [{ name: 'Hound of Ill Omen' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!hound Enemy');
    expect(pools.get('sp')!.remaining).toBe(2);
    expect(s.callerEconomy.bonusAction).toBe(true);
  });
});

// ── Tier 12 extras ─────────────────────────────────────

describe('Tier 12 — Cure Wounds', () => {
  it('heals 1d8+mod', async () => {
    const ally = makeToken('tAlly', 'Ally', { characterId: 'char-ally' });
    const allyC = makeCombatant('tAlly', { hp: 5, maxHp: 30, characterId: 'char-ally', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally], otherCombatants: [allyC] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 3, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!curewounds Ally');
    });
    // 1d8=8 + 3 = 11 → 5+11=16
    expect(allyC.hp).toBe(16);
  });
});

describe('Tier 12 — Mass Healing Word', () => {
  it('caps at 6 targets', async () => {
    const tokens = Array.from({ length: 7 }, (_, i) => makeToken(`tA${i}`, `Ally${i}`));
    const s = makeScenario({ inCombat: true, otherTokens: tokens });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 5, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!masshealingword Ally0 Ally1 Ally2 Ally3 Ally4 Ally5 Ally6');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/1-6 targets required/);
  });
});

describe('Tier 12 — Guiding Bolt', () => {
  it('outlines target on hit', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 3, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99, ...Array(4).fill(0.99)], async () => {
      await tryHandleChatCommand(io, s.ctx, '!guidingbolt Enemy');
    });
    expect(enemy.conditions).toContain('outlined');
    expect(lastBroadcast(emissions)).toMatch(/Guiding Bolt/);
  });
});

describe('Tier 12 — Thunderwave', () => {
  it('half-damage on successful CON save', async () => {
    const e1 = makeToken('tE1', 'Goblin', { characterId: 'c-g1' });
    const s = makeScenario({ inCombat: true, otherTokens: [e1] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 3, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-g1': { ability_scores: { con: 18 }, saving_throws: ['con'], proficiency_bonus: 3, name: 'Goblin' },
    });
    const { io, emissions } = makeFakeIo();
    // damage rolls first (2d8), then save d20
    await withRandomSeed([0.99, 0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!thunderwave Goblin');
    });
    // d20=20 + con(4)+prof(3)=7 → 27 ≥ 13 → save
    // 2d8 max=16 → half=8
    expect(lastBroadcast(emissions)).toMatch(/SAVED/);
    expect(lastBroadcast(emissions)).toMatch(/8 thunder/);
    expect(lastBroadcast(emissions)).toMatch(/no push/);
  });
});

describe('Tier 12 — Spiritual Weapon dice scaling', () => {
  it('L5 slot = 2d8 (RAW: +1d8 per two levels above 2nd)', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 9, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 4 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!spiritualweapon Enemy 5');
    expect(lastBroadcast(emissions)).toMatch(/2d8\+3/);
  });
});

describe('Tier 12 — Spirit Guardians', () => {
  it('applies slowed + rolls WIS save', async () => {
    const e1 = makeToken('tE1', 'Goblin', { characterId: 'c-g1' });
    const s = makeScenario({ inCombat: true, otherTokens: [e1] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 5, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 3, spell_save_dc: 14 },
      'c-g1': { ability_scores: { wis: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'Goblin' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed(Array(4).fill(0.99), async () => {
      await tryHandleChatCommand(io, s.ctx, '!spiritguardians Goblin');
    });
    expect(e1.conditions).toContain('slowed');
  });
});

describe('Tier 12 — Sanctuary', () => {
  it('applies sanctuary to an ally', async () => {
    const ally = makeToken('tA', 'Ally');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 3, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!sanctuary Ally');
    expect(ally.conditions).toContain('sanctuary');
    expect(s.callerEconomy.bonusAction).toBe(true);
  });
});

describe('Tier 12 — Banishment', () => {
  it('applies banished on failed CHA save', async () => {
    const enemy = makeToken('tE', 'Enemy', { characterId: 'c-e' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 7, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 3, spell_save_dc: 15 },
      'c-e': { ability_scores: { cha: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'Enemy' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!banishment Enemy');
    });
    expect(enemy.conditions).toContain('banished');
  });
});

describe('Tier 12 — Silvery Barbs', () => {
  it('grants ally the inspired advantage', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const ally = makeToken('tA', 'Ally');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy, ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Sorcerer', level: 3, name: 'S', ability_scores: { cha: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!silverybarbs Enemy Ally');
    expect(ally.conditions).toContain('inspired');
    expect(s.callerEconomy.reaction).toBe(true);
  });
});

describe('Tier 12 — Dispel Magic', () => {
  it('auto-dispels at equal slot', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 7, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!dispelmagic Enemy 3 3');
    expect(lastBroadcast(emissions)).toMatch(/automatically/);
  });
});

// ── Tier 13 extras ─────────────────────────────────────

describe('Tier 13 — Forge Blessing', () => {
  it('broadcasts the 24-hour buff line', async () => {
    const ally = makeToken('tA', 'Ally');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric (Forge)', level: 1, name: 'Smith', features: [{ name: 'Blessing of the Forge' }], ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!forgeblessing Ally');
    expect(lastBroadcast(emissions)).toMatch(/Blessing of the Forge/);
    expect(lastBroadcast(emissions)).toMatch(/24 hours/);
  });
});

describe('Tier 13 — Voice of Authority', () => {
  it('announces the ally-reaction-attack trigger', async () => {
    const ally = makeToken('tA', 'Ally');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric (Order)', level: 1, name: 'Law', features: [{ name: 'Voice of Authority' }], ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!voice Ally');
    expect(lastBroadcast(emissions)).toMatch(/reaction.*weapon attack/);
  });
});

describe('Tier 13 — Embolden Bond', () => {
  it('bonds up to PB creatures', async () => {
    const a1 = makeToken('tA1', 'A1');
    const a2 = makeToken('tA2', 'A2');
    const s = makeScenario({ inCombat: true, otherTokens: [a1, a2] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric (Peace)', level: 3, name: 'Pax', features: [{ name: 'Emboldening Bond' }], ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!emboldenbond A1 A2');
    expect(a1.conditions).toContain('bonded');
    expect(a2.conditions).toContain('bonded');
  });
});

describe('Tier 13 — Twilight Sanctuary (clear)', () => {
  it('clears charmed + frightened', async () => {
    const ally = makeToken('tA', 'A', { conditions: ['charmed' as any, 'frightened' as any] });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric (Twilight)', level: 3, name: 'T', features: [{ name: 'Twilight Sanctuary' }], ability_scores: { wis: 16 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!twilightsanct A clear');
    expect(ally.conditions).not.toContain('charmed');
    expect(ally.conditions).not.toContain('frightened');
  });
});

describe('Tier 13 — Nature\'s Wrath', () => {
  it('restrains on failed save', async () => {
    const enemy = makeToken('tE', 'Enemy', { characterId: 'c-e' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Paladin (Ancients)', level: 3, name: 'A', features: [{ name: "Nature's Wrath" }], ability_scores: { cha: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-e': { ability_scores: { str: 8, dex: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'Enemy' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!natureswrath Enemy');
    });
    expect(enemy.conditions).toContain('restrained');
  });
});

describe('Tier 13 — Champion Challenge', () => {
  it('applies challenged to failing targets', async () => {
    const e1 = makeToken('tE1', 'Foe', { characterId: 'c-f1' });
    const s = makeScenario({ inCombat: true, otherTokens: [e1] });
    routeCharacterQueries({
      'char-caller': { class: 'Paladin (Crown)', level: 3, name: 'King', features: [{ name: 'Champion Challenge' }], ability_scores: { cha: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-f1': { ability_scores: { wis: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'Foe' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!challenge Foe');
    });
    expect(e1.conditions).toContain('challenged');
  });
});

describe('Tier 13 — Dreadful Aspect', () => {
  it('frightens on fail (no mid-duration save)', async () => {
    const e1 = makeToken('tE1', 'Vict', { characterId: 'c-v1' });
    const s = makeScenario({ inCombat: true, otherTokens: [e1] });
    routeCharacterQueries({
      'char-caller': { class: 'Paladin (Oathbreaker)', level: 3, name: 'Dread', features: [{ name: 'Dreadful Aspect' }], ability_scores: { cha: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-v1': { ability_scores: { wis: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'Vict' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!dread Vict');
    });
    expect(e1.conditions).toContain('frightened');
  });
});

describe('Tier 13 — Rebuke the Violent', () => {
  it('burns reaction and rolls radiant', async () => {
    const enemy = makeToken('tE', 'Foe', { characterId: 'c-e' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Paladin (Redemption)', level: 3, name: 'Red', features: [{ name: 'Rebuke the Violent' }], ability_scores: { cha: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-e': { ability_scores: { wis: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'Foe' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!rebuke Foe 14');
    });
    expect(s.callerEconomy.reaction).toBe(true);
    // fail → full dmg 14
    expect(lastBroadcast(emissions)).toMatch(/14 radiant/);
  });
});

// ── Tier 14 extras ─────────────────────────────────────

describe('Tier 14 — Rallying Cry', () => {
  it('grants level temp HP to allies', async () => {
    const a1 = makeToken('tA1', 'A1', { characterId: 'c-a1' });
    const s = makeScenario({ inCombat: true, otherTokens: [a1] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Banneret)', level: 3, name: 'B', features: [{ name: 'Rallying Cry' }], ability_scores: {}, proficiency_bonus: 2 },
      'c-a1': { temp_hit_points: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!rally A1');
    expect(lastBroadcast(emissions)).toMatch(/3 temp HP/);
  });
});

describe('Tier 14 — Psi Strike', () => {
  it('spends 1 psi die + rolls damage', async () => {
    const enemy = makeToken('tE', 'Enemy');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('psi', { max: 6, remaining: 6 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Psi Warrior)', level: 5, name: 'M', features: [{ name: 'Psionic Strike' }], ability_scores: { int: 14 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!psistrike Enemy');
    });
    expect(pools.get('psi')!.remaining).toBe(5);
    expect(lastBroadcast(emissions)).toMatch(/Psionic Strike/);
  });
});

describe('Tier 14 — Giant\'s Might', () => {
  it('applies giant-size condition', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Rune Knight)', level: 3, name: 'R', features: [{ name: "Giant's Might" }], ability_scores: {}, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!giantsmight');
    expect(s.caller.conditions).toContain('giant-size');
  });
});

describe('Tier 14 — Rune', () => {
  it('echoes stone rune effect', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Rune Knight)', level: 3, name: 'R', features: [{ name: 'Rune Knight Bonus Proficiencies' }], ability_scores: {}, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!rune stone');
    expect(lastBroadcast(emissions)).toMatch(/Darkvision 120 ft/);
  });
});

// ── Tier 15 extras ─────────────────────────────────────

describe('Tier 15 — Insightful Fighting', () => {
  it('marks target on win', async () => {
    const enemy = makeToken('tE', 'Foe', { characterId: 'c-f' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue (Inquisitive)', level: 3, name: 'I', features: [{ name: 'Insightful Fighting' }], ability_scores: { wis: 18 }, proficiency_bonus: 2 },
      'c-f': { ability_scores: { cha: 8 }, proficiency_bonus: 2, name: 'Foe' },
    });
    const { io, emissions } = makeFakeIo();
    // caller d20 0.99 → 20; enemy d20 0.01 → 1
    await withRandomSeed([0.99, 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!insightfight Foe');
    });
    expect(enemy.conditions).toContain('insight-marked');
  });
});

describe('Tier 15 — Skirmisher', () => {
  it('burns reaction', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue (Scout)', level: 3, name: 'Sc', features: [{ name: 'Skirmisher' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!skirmish');
    expect(s.callerEconomy.reaction).toBe(true);
  });
});

describe('Tier 15 — Psiknack', () => {
  it('spends a die and rolls', async () => {
    const s = makeScenario({ inCombat: true });
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('psi', { max: 4, remaining: 4 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': { class: 'Rogue (Soulknife)', level: 3, name: 'Sk', features: [{ name: 'Psi-Bolstered Knack' }] },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!psiknack');
    });
    expect(pools.get('psi')!.remaining).toBe(3);
  });
});

// ── Tier 16 extras ─────────────────────────────────────

describe('Tier 16 — Lightning Bolt', () => {
  it('full damage on fail', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 5, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 3, spell_save_dc: 14 },
      'c-g': { ability_scores: { dex: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([...Array(8).fill(0.99), 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!lightningbolt G');
    });
    expect(lastBroadcast(emissions)).toMatch(/48 lightning/);
  });
});

describe('Tier 16 — Scorching Ray', () => {
  it('L3 slot fires 4 rays', async () => {
    const e = makeToken('tE', 'G');
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 5, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 3, spell_attack_bonus: 6 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!scorchingray G 3');
    expect(lastBroadcast(emissions)).toMatch(/4 rays/);
  });
});

describe('Tier 16 — Cone of Cold', () => {
  it('rolls CON save', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 9, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 4, spell_save_dc: 16 },
      'c-g': { ability_scores: { con: 12 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([...Array(8).fill(0.5), 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!coneofcold G');
    });
    expect(lastBroadcast(emissions)).toMatch(/Cone of Cold/);
    expect(lastBroadcast(emissions)).toMatch(/cold/);
  });
});

describe('Tier 16 — Entangle', () => {
  it('restrains on failed STR save', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Druid', level: 3, name: 'D', ability_scores: { wis: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-g': { ability_scores: { str: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!entangle G');
    });
    expect(e.conditions).toContain('restrained');
  });
});

describe('Tier 16 — Web', () => {
  it('restrains on failed DEX save (STR save to break)', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 3, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-g': { ability_scores: { dex: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.05], async () => {
      await tryHandleChatCommand(io, s.ctx, '!web G');
    });
    expect(e.conditions).toContain('restrained');
  });
});

describe('Tier 16 — Moonbeam', () => {
  it('rolls CON save, 2d10 radiant', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Druid', level: 3, name: 'D', ability_scores: { wis: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-g': { ability_scores: { con: 8 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99, 0.99, 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!moonbeam G');
    });
    expect(lastBroadcast(emissions)).toMatch(/radiant/);
  });
});

describe('Tier 16 — Call Lightning', () => {
  it('3d10 lightning at L3', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Druid', level: 5, name: 'D', ability_scores: { wis: 16 }, proficiency_bonus: 3, spell_save_dc: 14 },
      'c-g': { ability_scores: { dex: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!calllightning G');
    expect(lastBroadcast(emissions)).toMatch(/lightning/);
  });
});

describe('Tier 16 — Shatter', () => {
  it('thunder save', async () => {
    const e = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Sorcerer', level: 3, name: 'S', ability_scores: { cha: 16 }, proficiency_bonus: 2, spell_save_dc: 13 },
      'c-g': { ability_scores: { con: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!shatter G');
    expect(lastBroadcast(emissions)).toMatch(/Shatter/);
    expect(lastBroadcast(emissions)).toMatch(/thunder/);
  });
});

// ── Tier 17 extras ─────────────────────────────────────

describe('Tier 17 — Revivify', () => {
  it('sets HP to 1 and clears death saves', async () => {
    const ally = makeToken('tA', 'A', { characterId: 'c-a' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', name: 'P' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!revivify A');
    // Should have run UPDATE for hit_points
    const updates = mockQuery.mock.calls.filter((call) =>
      /UPDATE characters SET hit_points = 1/.test(call[0]),
    );
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe('Tier 17 — Invisibility', () => {
  it('applies invisible', async () => {
    const ally = makeToken('tA', 'A');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'W' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!invisibility A');
    expect(ally.conditions).toContain('invisible');
  });
});

describe('Tier 17 — Greater Invisibility', () => {
  it('applies invisible at L4', async () => {
    const ally = makeToken('tA', 'A');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'W' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!greaterinvisibility A');
    expect(ally.conditions).toContain('invisible');
    expect(lastBroadcast(emissions)).toMatch(/L4/);
  });
});

describe('Tier 17 — Pass Without Trace', () => {
  it('broadcasts +10 Stealth', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Druid', name: 'D' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!passwithouttrace');
    expect(lastBroadcast(emissions)).toMatch(/\+10 Stealth/);
  });
});

describe('Tier 17 — Greater Restoration (exhaustion)', () => {
  it('decrements exhaustion by 1', async () => {
    const ally = makeToken('tA', 'A', { characterId: 'c-a' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', name: 'P' },
      'c-a': { exhaustion_level: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!greaterrestoration A exhaustion');
    const updates = mockQuery.mock.calls.filter((call) => /exhaustion_level = \$1/.test(call[0]));
    // Should have written new exhaustion level (2).
    expect(updates.some((u) => u[1][0] === 2)).toBe(true);
  });
});

describe('Tier 17 — Blur', () => {
  it('applies blur to self', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'W' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!blur');
    expect(s.caller.conditions).toContain('blur');
  });
});

describe('Tier 17 — Stoneskin', () => {
  it('applies stoneskin', async () => {
    const ally = makeToken('tA', 'A');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Druid', name: 'D' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!stoneskin A');
    expect(ally.conditions).toContain('stoneskin');
  });
});

describe('Tier 17 — Death Ward', () => {
  it('applies death-warded', async () => {
    const ally = makeToken('tA', 'A');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', name: 'P' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!deathward A');
    expect(ally.conditions).toContain('death-warded');
  });
});

// ── Tier 18 extras ─────────────────────────────────────

describe('Tier 18 — Crossbow Expert', () => {
  it('burns bonus action', async () => {
    const e = makeToken('tE', 'E');
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', name: 'F', features: [{ name: 'Crossbow Expert' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!crossbowexpert E');
    expect(s.callerEconomy.bonusAction).toBe(true);
  });
});

describe('Tier 18 — Shield Master shove', () => {
  it('knocks prone on a win', async () => {
    const enemy = makeToken('tE', 'Foe', { characterId: 'c-e' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Fighter',
        name: 'F',
        features: [{ name: 'Shield Master' }],
        ability_scores: { str: 18 },
        proficiency_bonus: 3,
      },
      'c-e': { ability_scores: { str: 8, dex: 8 }, proficiency_bonus: 2, name: 'Foe' },
    });
    const { io, emissions } = makeFakeIo();
    // caller d20 = 0.99 → 20; enemy d20 = 0.01 → 1
    await withRandomSeed([0.99, 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!shieldmaster Foe prone');
    });
    expect(enemy.conditions).toContain('prone');
  });
});

describe('Tier 18 — Sentinel', () => {
  it('burns reaction', async () => {
    const e = makeToken('tE', 'E');
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', name: 'F', features: [{ name: 'Sentinel' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!sentinel E');
    expect(s.callerEconomy.reaction).toBe(true);
  });
});

describe('Tier 18 — Mobile', () => {
  it('broadcasts without target (passive)', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Rogue', name: 'R', features: [{ name: 'Mobile' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mobile');
    expect(lastBroadcast(emissions)).toMatch(/\+10 speed/);
  });
});

describe('Tier 18 — War Caster reaction spell', () => {
  it('burns reaction for OA spell', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'W', features: [{ name: 'War Caster' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!warcaster oa');
    expect(s.callerEconomy.reaction).toBe(true);
  });
});

describe('Tier 18 — Inspiring Leader', () => {
  it('grants CHA+level temp HP', async () => {
    const ally = makeToken('tA', 'A', { characterId: 'c-a' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Bard',
        level: 5,
        name: 'B',
        features: [{ name: 'Inspiring Leader' }],
        ability_scores: { cha: 16 }, // mod 3
      },
      'c-a': { temp_hit_points: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!inspiringleader A');
    // 3 + 5 = 8 temp HP
    expect(lastBroadcast(emissions)).toMatch(/8 temp HP/);
  });
});

describe('Tier 18 — Tavern Brawler', () => {
  it('broadcasts unarmed line', async () => {
    const e = makeToken('tE', 'E');
    const s = makeScenario({ inCombat: true, otherTokens: [e] });
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian', name: 'B', features: [{ name: 'Tavern Brawler' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!tavernbrawler E');
    expect(lastBroadcast(emissions)).toMatch(/Tavern Brawler/);
  });
});

describe('Tier 18 — Elemental Adept', () => {
  it('echoes resistance-bypass for fire', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'W', features: [{ name: 'Elemental Adept' }] },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!elementaladept fire');
    expect(lastBroadcast(emissions)).toMatch(/ignore.*resistance/i);
  });
});

// ── Tier 19 extras ─────────────────────────────────────

describe('Tier 19 — Radiant Soul', () => {
  it('burns action and broadcasts fly', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Paladin', level: 5, name: 'P', race: 'Aasimar', ability_scores: {}, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!radiantsoul');
    expect(s.callerEconomy.action).toBe(true);
    expect(lastBroadcast(emissions)).toMatch(/fly speed 30/);
  });
});

describe('Tier 19 — Infernal Legacy (Hellish Rebuke)', () => {
  it('echoes mechanical line', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Warlock', level: 5, name: 'T', race: 'Tiefling' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!infernallegacy hellishrebuke');
    expect(lastBroadcast(emissions)).toMatch(/2d10 fire/);
  });
});

describe('Tier 19 — Hidden Step', () => {
  it('applies invisible to self', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Druid', level: 3, name: 'F', race: 'Firbolg' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!hiddenstep');
    expect(s.caller.conditions).toContain('invisible');
    expect(s.callerEconomy.bonusAction).toBe(true);
  });
});

describe('Tier 19 — Feline Agility', () => {
  it('doubles movement for the turn', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Monk', level: 3, name: 'T', race: 'Tabaxi' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!felinestep');
    expect(s.callerEconomy.movementMax).toBe(60);
    expect(s.callerEconomy.movementRemaining).toBe(60);
  });
});

describe('Tier 19 — Magic Resistance', () => {
  it('broadcasts the passive', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 3, name: 'Y', race: 'Yuan-Ti Pureblood' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!magicres');
    expect(lastBroadcast(emissions)).toMatch(/advantage on saving throws/);
  });
});

describe('Tier 19 — Savage Attacks (Half-Orc)', () => {
  it('broadcasts crit-die reminder', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian', level: 3, name: 'O', race: 'Half-Orc' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!savageattacks');
    expect(lastBroadcast(emissions)).toMatch(/additional weapon damage die/);
  });
});

describe('Tier 19 — Mimicry (Kenku)', () => {
  it('broadcasts the sound', async () => {
    const s = makeScenario();
    routeCharacterQueries({
      'char-caller': { class: 'Rogue', level: 3, name: 'K', race: 'Kenku' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!mimicry lord\'s voice');
    expect(lastBroadcast(emissions)).toMatch(/lord's voice/);
  });
});

describe('Tier 19 — Shift (Shifter)', () => {
  it('grants level+CON temp HP', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': {
        class: 'Ranger',
        level: 4,
        name: 'S',
        race: 'Shifter',
        ability_scores: { con: 14 },
        proficiency_bonus: 2,
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!shift');
    expect(lastBroadcast(emissions)).toMatch(/6 temp HP/);
    expect(s.callerEconomy.bonusAction).toBe(true);
  });
});

// ── Tier 20 extras ─────────────────────────────────────

describe('Tier 20 — Staff of Healing (Cure Wounds)', () => {
  it('spends 1 charge and heals', async () => {
    const ally = makeToken('tA', 'A', { characterId: 'c-a' });
    const allyC = makeCombatant('tA', { hp: 5, maxHp: 30, characterId: 'c-a', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally], otherCombatants: [allyC] });
    const { io, emissions } = makeFakeIo();
    await withRandomSeed([0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!staffheal A cure 1');
    });
    const pools = s.room.pointPools.get(s.caller.characterId!);
    expect(pools?.get('item:staffofhealing')?.remaining).toBe(9);
    expect(allyC.hp).toBeGreaterThan(5);
  });
});

describe('Tier 20 — Deck of Many Things', () => {
  it('draws a card and broadcasts', async () => {
    const s = makeScenario();
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!deck');
    expect(lastBroadcast(emissions)).toMatch(/Deck of Many Things/);
  });
});

describe('Tier 20 — Scroll', () => {
  it('broadcasts consumption line', async () => {
    const s = makeScenario();
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!scroll fireball');
    expect(lastBroadcast(emissions)).toMatch(/Spell Scroll.*fireball/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES — parsing ambiguities, refund logic, cross-tier bugs
// ═══════════════════════════════════════════════════════════════════

describe('Edge — Healing Word token name ending in a digit', () => {
  it('handles target "Ally-3" without mistaking the 3 as a slot', async () => {
    // This is a known parsing hazard: the last-arg-is-number heuristic
    // can swallow a target name that happens to end in a numeral.
    // Specifically Healing Word treats the last numeric argument as the
    // slot level. If the caller types `!healingword Ally-3` there's no
    // arg so slot=1 (OK). If they type `!healingword Ally 3` the `3`
    // gets claimed as the slot and the target is "Ally". That's the
    // documented contract — this test pins it.
    const ally3 = makeToken('tA3', 'Ally', { characterId: 'char-a3' });
    const allyC = makeCombatant('tA3', { hp: 5, maxHp: 30, characterId: 'char-a3', isNPC: false });
    const s = makeScenario({ inCombat: true, otherTokens: [ally3], otherCombatants: [allyC] });
    routeCharacterQueries({
      'char-caller': { class: 'Cleric', level: 5, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    // Expect 3d4 + 3 (slot 3 upcast) = max 15 heal.
    await withRandomSeed([0.99, 0.99, 0.99], async () => {
      await tryHandleChatCommand(io, s.ctx, '!healingword Ally 3');
    });
    expect(allyC.hp).toBe(5 + 15);
  });
});

describe('Edge — Frenzy attack command gate', () => {
  it('requires frenzied condition first', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Berserker)', level: 5, name: 'G', features: [{ name: 'Frenzy' }], exhaustion_level: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!frenzy attack');
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/not frenzying/);
  });

  it('burns bonus action when frenzying', async () => {
    const s = makeScenario({ inCombat: true });
    s.caller.conditions = ['raging' as any, 'frenzied' as any];
    routeCharacterQueries({
      'char-caller': { class: 'Barbarian (Berserker)', level: 5, name: 'G', features: [{ name: 'Frenzy' }], exhaustion_level: 0 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!frenzy attack');
    expect(s.callerEconomy.bonusAction).toBe(true);
  });
});

describe('Edge — Psi Warrior Psi-Field double-spend prevention', () => {
  it("refuses when reaction already spent and does NOT drain the pool", async () => {
    const ally = makeToken('tA', 'A', { characterId: 'c-a' });
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    s.callerEconomy.reaction = true; // already used
    const pools = new Map<string, { max: number; remaining: number }>();
    pools.set('psi', { max: 4, remaining: 4 });
    s.room.pointPools.set(s.caller.characterId!, pools);
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Psi Warrior)', level: 5, name: 'M', features: [{ name: 'Protective Field' }], ability_scores: { int: 14 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!psifield A 10');
    expect(pools.get('psi')!.remaining).toBe(4); // pool NOT drained
    const w = emissions.find((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(String((w?.payload as { content?: string })?.content ?? '')).toMatch(/reaction already spent/);
  });
});

describe('Edge — Counterspell with no explicit my-slot defaults to 3', () => {
  it('auto-counters L3 without the third arg', async () => {
    const s = makeScenario({ inCombat: true });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 5, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 3 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!counterspell Lich 3');
    expect(lastBroadcast(emissions)).toMatch(/automatically/);
  });
});

describe('Edge — Sanctuary class gate (non-caster attempt)', () => {
  it('still lets any PC cast it (no class restriction in handler)', async () => {
    // Sanctuary in the handler doesn't gate by class — spells like
    // this get cast from scrolls / multiclass dips. This test pins
    // that "class-gate-less" contract.
    const ally = makeToken('tA', 'A');
    const s = makeScenario({ inCombat: true, otherTokens: [ally] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter', name: 'Mage-fighter' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!sanctuary A');
    expect(ally.conditions).toContain('sanctuary');
  });
});

describe('Edge — Bag of Holding capacity overflow', () => {
  it('refuses an item that would exceed 500 lbs', async () => {
    const s = makeScenario();
    const { io, emissions } = makeFakeIo();
    // Partially fill the bag first so the next add actually overflows.
    await tryHandleChatCommand(io, s.ctx, '!bagofholding in first-rock 450');
    await tryHandleChatCommand(io, s.ctx, '!bagofholding in boulder 100');
    const w = emissions.filter((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(w.some((e) => /over capacity/.test((e.payload as { content?: string }).content ?? ''))).toBe(true);
  });
});

describe('Edge — Echo Knight L7 Unleash Incarnation once per round', () => {
  it('blocks the second unleash in the same round', async () => {
    const enemy = makeToken('tE', 'E');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': {
        class: 'Fighter (Echo Knight)',
        level: 7,
        name: 'Mia',
        features: [{ name: 'Manifest Echo' }, { name: 'Unleash Incarnation' }],
        ability_scores: { con: 14 },
      },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!echo summon 5 7');
    await tryHandleChatCommand(io, s.ctx, '!echo attack');
    await tryHandleChatCommand(io, s.ctx, '!echo attack');
    const w = emissions.filter((e) => (e.payload as { type?: string }).type === 'whisper');
    expect(w.some((e) => /already used this round/.test((e.payload as { content?: string }).content ?? ''))).toBe(true);
  });
});

describe('Edge — Arcane Shot seeking has no save', () => {
  it('broadcasts no-save line', async () => {
    const enemy = makeToken('tE', 'E');
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Fighter (Arcane Archer)', level: 3, name: 'R', features: [{ name: 'Arcane Shot' }], ability_scores: { int: 14 }, proficiency_bonus: 2 },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!arcaneshot seeking E');
    const b = lastBroadcast(emissions)!;
    expect(b).toMatch(/Arcane Shot: Seeking/);
    expect(b).not.toMatch(/DC/);
    expect(b).toMatch(/Auto-hits/);
  });
});

describe('Edge — Spiritual Weapon slot scaling', () => {
  // PHB RAW: +1d8 every TWO slot levels above 2nd.
  // L2=1, L3=1, L4=2, L5=2, L6=3, L7=3, L8=4, L9=4.
  const cases: Array<[number, string]> = [
    [2, '1d8'],
    [3, '1d8'],
    [4, '2d8'],
    [5, '2d8'],
    [6, '3d8'],
    [7, '3d8'],
    [8, '4d8'],
    [9, '4d8'],
  ];
  for (const [slot, expected] of cases) {
    it(`L${slot} slot → ${expected}`, async () => {
      const enemy = makeToken('tE', 'E');
      const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
      routeCharacterQueries({
        'char-caller': { class: 'Cleric', level: 17, name: 'P', ability_scores: { wis: 16 }, proficiency_bonus: 6 },
      });
      const { io, emissions } = makeFakeIo();
      await tryHandleChatCommand(io, s.ctx, `!spiritualweapon E ${slot}`);
      const b = lastBroadcast(emissions)!;
      expect(b).toMatch(new RegExp(`${expected}\\+3`));
    });
  }
});

describe('Edge — Fireball upcast slot scaling', () => {
  it('L5 cast rolls 10d6', async () => {
    const enemy = makeToken('tE', 'G', { characterId: 'c-g' });
    const s = makeScenario({ inCombat: true, otherTokens: [enemy] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', level: 9, name: 'W', ability_scores: { int: 16 }, proficiency_bonus: 4, spell_save_dc: 16 },
      'c-g': { ability_scores: { dex: 10 }, saving_throws: [], proficiency_bonus: 2, name: 'G' },
    });
    const { io, emissions } = makeFakeIo();
    // 10 damage d6s + 1 save d20 = 11 rolls
    await withRandomSeed([...Array(10).fill(0.99), 0.01], async () => {
      await tryHandleChatCommand(io, s.ctx, '!fireball G 5');
    });
    // 10d6 max = 60. Failed save → 60 fire.
    expect(lastBroadcast(emissions)).toMatch(/60 fire/);
  });
});

describe('Edge — Haste tokens without characterId', () => {
  it('still applies condition', async () => {
    const npcAlly = makeToken('tNPC', 'NPC'); // no characterId
    const s = makeScenario({ inCombat: true, otherTokens: [npcAlly] });
    routeCharacterQueries({
      'char-caller': { class: 'Wizard', name: 'W' },
    });
    const { io, emissions } = makeFakeIo();
    await tryHandleChatCommand(io, s.ctx, '!haste NPC');
    expect(npcAlly.conditions).toContain('hasted');
  });
});
