import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import type { Token } from '@dnd-vtt/shared';
import type { WildShapeState } from '../utils/wildShapeState.js';
import type { ChatCommandContext, ChatCommandHandler } from '../services/ChatCommands.js';
import type { PlayerContext } from '../utils/roomState.js';
import {
  loadFeatureRuntime,
  runWithFeatureRuntime,
  saveFeatureRuntime,
  type CharacterFeatureState,
  type FeatureQuery,
  type SessionFeatureState,
} from '../utils/featureRuntime.js';

const { handlers, query, whisper, broadcast } = vi.hoisted(() => ({
  handlers: new Map<string, ChatCommandHandler>(),
  query: vi.fn<FeatureQuery>(),
  whisper: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({
  default: { query, connect: async () => ({ query, release: vi.fn() }) },
}));
vi.mock('../services/ChatCommands.js', () => ({
  registerChatCommand: (names: string | string[], handler: ChatCommandHandler) => {
    for (const name of Array.isArray(names) ? names : [names]) handlers.set(name, handler);
  },
  whisperToCaller: whisper,
  broadcastSystem: broadcast,
}));

import '../services/chatCommands/xpAndWildShapeHandler.js';
import '../services/chatCommands/subclassHandlers.js';
import '../services/chatCommands/subclassFeaturesHandler.js';
import '../services/chatCommands/subclassFeaturesTier11Handler.js';
import '../services/chatCommands/utilityHandlers.js';
import '../services/chatCommands/miscClassHandlers.js';
import '../services/chatCommands/encounterAndRestHandlers.js';
import '../services/chatCommands/environmentHandler.js';

function harness(seed: CharacterFeatureState = {}) {
  const characters = new Map<string, { version: number; namespaces: CharacterFeatureState }>([
    ['c', { version: 1, namespaces: structuredClone(seed) }],
  ]);
  const sessions = new Map<string, { version: number; namespaces: SessionFeatureState }>();
  const sheet: Record<string, unknown> = {
    experience: 100,
    version: 1,
    wild_shape: null,
    name: 'Hero',
    level: 10,
    class: 'Druid Wizard Fighter Echo Ranger Barbarian Zealot',
    race: 'Half-Orc',
    features: [{ name: 'Portent' }, { name: 'Colossus Slayer' }, { name: 'Grim Harvest' }],
    ability_scores: { int: 16, con: 16 },
    hit_points: 0,
    max_hit_points: 50,
  };
  query.mockImplementation(async (sql, values = []) => {
    if (sql.includes('_feature_runtime')) {
      const store = sql.includes('session_feature_runtime') ? sessions : characters;
      const id = String(values[0]);
      if (sql.startsWith('INSERT') && !store.has(id)) store.set(id, { version: 1, namespaces: {} });
      if (sql.startsWith('SELECT'))
        return { rows: [{ state: structuredClone(store.get(id)) }], rowCount: 1 };
      if (sql.startsWith('UPDATE')) store.set(id, JSON.parse(String(values[1])));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT')) return { rows: [structuredClone(sheet)], rowCount: 1 };
    if (sql.startsWith('UPDATE characters') && sql.includes('RETURNING version')) {
      for (const match of sql.matchAll(/(experience|features|wild_shape|hit_points) = \$(\d+)/g)) {
        const value = values[Number(match[2]) - 1];
        sheet[match[1]] =
          match[1] === 'features' ? (value === null ? null : JSON.parse(String(value))) : value;
      }
      sheet.version = Number(sheet.version) + 1;
      return { rows: [{ version: sheet.version }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  function commandContext(command: string, rest: string, sessionId: string): ChatCommandContext {
    const hero: Token = {
      id: 'hero',
      name: 'Hero',
      characterId: 'c',
      ownerUserId: 'user',
      createdAt: '2026-01-01',
      x: 1,
      y: 2,
      conditions: [],
      mapId: 'map',
      size: 1,
      imageUrl: null,
      color: '#000',
      layer: 'token',
      visible: true,
      hasLight: false,
      lightRadius: 0,
      lightDimRadius: 0,
      lightColor: '#fff',
    };
    (hero.conditions as string[]).push('raging');
    const horse: Token = {
      ...hero,
      id: 'horse',
      name: 'Horse',
      characterId: null,
      ownerUserId: null,
    };
    const ctx = {
      player: { userId: 'user', socketId: 'socket', role: 'dm', displayName: 'DM' },
      room: {
        sessionId,
        currentMapId: 'map',
        playerMapId: 'map',
        dmViewingMap: new Map(),
        players: new Map(),
        userSockets: new Map(),
        tokens: new Map([
          ['hero', hero],
          ['horse', horse],
        ]),
        actionEconomies: new Map(),
        combatState: { startedAt: 'combat-one', roundNumber: 1, currentTurnIndex: 0 },
      },
    } as unknown as PlayerContext;
    return {
      command,
      rest,
      raw: `!${command} ${rest}`,
      ctx,
      io: { to: () => ({ emit: vi.fn() }) } as unknown as Server,
    };
  }

  // Each command uses a fresh hydrated context, exactly as it would after eviction.
  async function execute(
    command: string,
    rest = '',
    sessionId = 'session',
    adjust?: (c: ChatCommandContext) => void
  ) {
    const runtime = await loadFeatureRuntime(query, sessionId, ['c']);
    const c = commandContext(command, rest, sessionId);
    adjust?.(c);
    await runWithFeatureRuntime(runtime, () => handlers.get(command)!(c));
    await saveFeatureRuntime(query, runtime);
  }

  return {
    execute,
    commandContext,
    sheet,
    character: () => characters.get('c')!.namespaces,
    session: (id = 'session') => sessions.get(id)!.namespaces,
  };
}

beforeEach(() => {
  query.mockReset();
  whisper.mockClear();
  broadcast.mockClear();
});

describe('feature handlers use durable scoped state', () => {
  it('keeps SQL XP authoritative across hydration despite a stale legacy namespace', async () => {
    const h = harness({ xp: 9000 });
    await h.execute('xp', 'Hero 20');
    await h.execute('xp', 'Hero 20', 'another-session');
    expect(h.sheet.experience).toBe(140);
    expect(h.character().xp).toBe(9000);
    await h.execute('xp', 'report');
    expect(whisper.mock.lastCall?.[2]).toContain('140 XP');
    await h.execute('xp', 'Hero 999', 'session', (c) => {
      c.ctx.player.role = 'player';
    });
    expect(h.sheet.experience).toBe(140);
  });

  it('uses SQL Wild Shape HP and never resurrects a stale runtime form', async () => {
    const legacy = { beastName: 'Wolf', beastHp: 11, beastMax: 11, beastAc: 13, beastSpeed: 40 };
    const h = harness({ wildShape: legacy });
    h.sheet.class = 'Druid';
    h.sheet.wild_shape = JSON.stringify({
      formSlug: 'wolf',
      formName: 'Wolf',
      formHp: 11,
      formMaxHp: 11,
      formAc: 13,
      formSpeed: { walk: 40 },
      formCr: 0.25,
      moon: false,
    } satisfies WildShapeState);
    await h.execute('beast', 'dmg 8', 'other');
    expect(JSON.parse(String(h.sheet.wild_shape)).formHp).toBe(3);
    await h.execute('beast', 'heal 2');
    expect(JSON.parse(String(h.sheet.wild_shape)).formHp).toBe(5);
    await h.execute('beast', 'dmg 5');
    expect(h.sheet.wild_shape).toBeNull();
    await h.execute('beast', 'status');
    expect(whisper.mock.lastCall?.[2]).toContain('not currently wild-shaped');
    expect(h.character().wildShape).toEqual(legacy);
  });

  it('does not refill SQL Lucky from the legacy runtime pool', async () => {
    const h = harness({ luckPoints: 3 });
    h.sheet.features = [
      {
        name: 'Lucky',
        sourceType: 'feat',
        usesTotal: 3,
        usesRemaining: 1,
        resetOn: 'long',
      },
    ];
    await h.execute('lucky', 'use');
    broadcast.mockClear();
    await h.execute('lucky', 'use', 'other');
    expect(broadcast).not.toHaveBeenCalled();
    expect(whisper.mock.lastCall?.[2]).toContain('no luck points remaining');
    expect(h.sheet.features).toMatchObject([{ usesRemaining: 0 }]);
    expect(h.character().luckPoints).toBe(3);
    await h.execute('lucky', 'reset');
    expect(h.sheet.features).toMatchObject([{ usesRemaining: 0 }]);
  });

  it('does not refill an exhausted ward after hydration or implicit damage', async () => {
    const h = harness();
    await h.execute('ward', 'dmg 4');
    expect(h.character().arcaneWard).toBeUndefined();
    await h.execute('ward', 'init');
    await h.execute('ward', 'dmg 999');
    expect(h.character().arcaneWard).toEqual({ current: 0, max: 23 });
    await h.execute('ward', 'status', 'other');
    expect(whisper.mock.lastCall?.[2]).toContain('0/23');
    await h.execute('ward', 'heal 4');
    expect(h.character().arcaneWard?.current).toBe(4);
    await h.execute('ward', 'reset');
    expect(h.character().arcaneWard).toBeUndefined();
  });

  it('preserves spent Portent dice, including an empty pool, without rerolling', async () => {
    const h = harness({ portentDice: [5, 5] });
    await h.execute('portent', 'use 5');
    expect(h.character().portentDice).toEqual([5]);
    await h.execute('portent', 'use 5', 'other');
    expect(h.character().portentDice).toEqual([]);
    const random = vi.spyOn(Math, 'random');
    await h.execute('portent', 'list');
    await h.execute('portent', 'use 5');
    expect(h.character().portentDice).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('does not refill missing or exhausted Endurance or Indomitable', async () => {
    const h = harness();
    await h.execute('endurance');
    await h.execute('indomitable');
    expect(h.character()).toEqual({});
    await h.execute('endurance', 'reset');
    await h.execute('endurance');
    await h.execute('indomitable', 'reset');
    await h.execute('indomitable');
    expect(h.character()).toMatchObject({ enduranceUsed: true, indomitableUsed: 1 });
    const before = structuredClone(h.character());
    broadcast.mockClear();
    await h.execute('endurance', '', 'other');
    await h.execute('indomitable', '', 'other');
    expect(h.character()).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(['colossus', 'divinefury', 'grimharvest'])(
    'preserves %s turn use through hydration without cross-session/combat collisions',
    async (command) => {
      const h = harness();
      const args = command === 'grimharvest' ? '1' : '';
      await h.execute(command, args);
      broadcast.mockClear();
      await h.execute(command, args);
      expect(broadcast).not.toHaveBeenCalled();
      expect(whisper.mock.lastCall?.[2]).toContain('already used this turn');
      await h.execute(command, args, 'other');
      expect(broadcast).toHaveBeenCalledTimes(1);
      await h.execute(command, args, 'session', (c) => {
        c.ctx.room.combatState!.startedAt = 'combat-two';
      });
      expect(broadcast).toHaveBeenCalledTimes(2);
      await h.execute(command, args, 'session', (c) => {
        c.ctx.room.combatState!.startedAt = 'combat-two';
        c.ctx.room.combatState!.currentTurnIndex = 1;
      });
      expect(broadcast).toHaveBeenCalledTimes(3);
    }
  );

  it('persists Echo position, round use and dismissal within its session', async () => {
    const h = harness();
    await h.execute('echo', 'summon 3 4');
    await h.execute('echo', 'unleash');
    expect(h.session().echoPositions).toEqual({ c: { x: 3, y: 4 } });
    broadcast.mockClear();
    await h.execute('echo', 'unleash');
    expect(broadcast).not.toHaveBeenCalled();
    expect(whisper.mock.lastCall?.[2]).toContain('already used this round');
    await h.execute('echo', 'unleash', 'other');
    expect(whisper.mock.lastCall?.[2]).toContain('no echo manifested');
    await h.execute('echo', 'swap');
    expect(h.session().echoPositions).toEqual({ c: { x: 1, y: 2 } });
    await h.execute('echo', 'dismiss');
    expect(h.session().echoPositions).toEqual({});
  });

  it('persists mounts and underwater independently by session', async () => {
    const h = harness();
    await h.execute('underwater', 'on');
    await h.execute('mount', 'Hero Horse independent');
    expect(h.session().underwater).toBe(true);
    expect(h.session().mountLinks).toEqual({ hero: { mountTokenId: 'horse', controlled: false } });
    await h.execute('underwater', '', 'other');
    expect(whisper.mock.lastCall?.[2]).toContain('inactive');
    expect(h.session('other').mountLinks).toBeUndefined();
    await h.execute('dismount', 'Hero');
    await h.execute('underwater', 'off');
    expect(h.session().mountLinks).toEqual({});
    expect(h.session().underwater).toBe(false);
  });

  it.each([
    ['endurance', '', { enduranceUsed: false }, 'UPDATE characters SET hit_points'],
    ['grimharvest', '1', {}, 'UPDATE characters SET hit_points'],
    ['mount', 'Hero Horse', {}, 'UPDATE tokens SET x'],
  ] as const)(
    'does not announce or save feature state if the associated %s write fails',
    async (command, args, seed, sqlPrefix) => {
      const h = harness(seed);
      h.sheet.level = 1;
      const implementation = query.getMockImplementation()!;
      query.mockImplementation(async (sql, values) => {
        if (sql.startsWith(sqlPrefix)) throw new Error('write failed');
        return implementation(sql, values);
      });
      await expect(h.execute(command, args)).rejects.toThrow('write failed');
      expect(h.character()).toEqual(seed);
      expect(broadcast).not.toHaveBeenCalled();
    }
  );

  it('does not provide a live process-global fallback outside a transaction', async () => {
    const h = harness({ portentDice: [2] });
    await expect(
      handlers.get('portent')!(h.commandContext('portent', 'list', 's'))
    ).rejects.toThrow(/transaction scope/);
    expect(h.character().portentDice).toEqual([2]);
  });
});
