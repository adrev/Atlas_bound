import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery, connect: vi.fn() } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import * as CombatService from '../services/CombatService.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getPlayerBySocketId,
  getRoom,
} from '../utils/roomState.js';
import { readWildShapeColumn } from '../utils/wildShapeState.js';
import '../services/chatCommands/xpAndWildShapeHandler.js';
import '../services/chatCommands/hpHandlers.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'ws-session';
const DRUID = 'druid-character';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function token(id: string, overrides: Partial<Token>): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible: true,
    conditions: [],
    ownerUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'WILD', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'druid-token',
    token('druid-token', { characterId: DRUID, ownerUserId: 'druid-user', name: 'Mielikki' })
  );
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['druid-user', 'druid-1', 'player', DRUID],
    ['bystander-user', 'bystander-1', 'player', null],
  ] as const) {
    addPlayerToRoom(SESSION, {
      userId: player[0],
      displayName: player[0],
      socketId: player[1],
      role: player[2],
      characterId: player[3],
    });
  }
  return room;
}

function druidRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Mielikki',
    class: 'Druid',
    level: 2,
    hit_points: 18,
    max_hit_points: 18,
    temp_hit_points: 0,
    features: '[]',
    wild_shape: null,
    version: 5,
    ...overrides,
  };
}

const WOLF = {
  slug: 'wolf',
  name: 'Wolf',
  type: 'Beast',
  armor_class: 13,
  hit_points: 11,
  speed: '{"walk":40}',
  cr_numeric: 0.25,
};

const ACTIVE_WOLF = JSON.stringify({
  formSlug: 'wolf',
  formName: 'Wolf',
  formHp: 11,
  formMaxHp: 11,
  formAc: 13,
  formSpeed: { walk: 40 },
  formCr: 0.25,
  moon: false,
});

/** SELECTs answer from `character` / `beast`; guarded UPDATEs from `update`. */
function arrange(
  options: {
    character?: Record<string, unknown> | null;
    beast?: Record<string, unknown> | null;
    update?: Array<Record<string, unknown>> | Error;
  } = {}
) {
  const character = options.character === undefined ? druidRow() : options.character;
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM compendium_monsters')) {
      return { rows: options.beast ? [options.beast] : [] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM characters')) {
      return { rows: character ? [character] : [] };
    }
    if (sql.startsWith('UPDATE characters')) {
      if (options.update instanceof Error) throw options.update;
      if (options.update) return { rows: options.update };
      return { rows: [{ version: 6 }] };
    }
    return { rows: [] };
  });
}

function updates(): Array<[string, unknown[]]> {
  return mockQuery.mock.calls
    .filter((call) => String(call[0]).startsWith('UPDATE characters'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
}

function publicLines(emissions: Emission[]): string[] {
  return emissions
    .filter(
      (e) => e.event === 'chat:new-message' && (e.payload as { type?: string }).type === 'system'
    )
    .map((e) => String((e.payload as { content?: unknown }).content));
}

function whispersTo(emissions: Emission[], socketId: string): string[] {
  return emissions
    .filter((e) => e.channelId === socketId && e.event === 'chat:new-message')
    .map((e) => String((e.payload as { content?: unknown }).content));
}

async function run(emissions: Emission[], socketId: string, raw: string) {
  return tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId(socketId)!, raw);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  deleteRoom(SESSION);
  seedRoom();
});

describe('!wildshape authoritative gating', () => {
  it('rejects client-declared form statistics without any query or write', async () => {
    arrange({ beast: WOLF });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!wildshape wolf 99 22 80');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/no longer typed in/);
  });

  it('rejects non-druids and level-1 druids without a write', async () => {
    const emissions: Emission[] = [];
    arrange({ character: druidRow({ class: 'Fighter' }), beast: WOLF });
    await run(emissions, 'druid-1', '!wildshape wolf');
    arrange({ character: druidRow({ level: 1 }), beast: WOLF });
    await run(emissions, 'druid-1', '!wildshape wolf');
    expect(updates()).toHaveLength(0);
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(
      /isn't a Druid|requires Druid level 2/
    );
  });

  it('only trusts compendium beasts: unknown and non-beast forms are refused', async () => {
    const emissions: Emission[] = [];
    arrange({ beast: null });
    await run(emissions, 'druid-1', '!wildshape tarrasque');
    arrange({ beast: { ...WOLF, type: 'Humanoid' } });
    await run(emissions, 'druid-1', '!wildshape wolf');
    expect(updates()).toHaveLength(0);
    const text = whispersTo(emissions, 'druid-1').join(' ');
    expect(text).toMatch(/trusted compendium/);
    expect(text).toMatch(/isn't a beast/);
  });

  it('applies 2014 CR and movement gates for standard druids', async () => {
    const emissions: Emission[] = [];
    // L2 vs CR 1/2 → reject.
    arrange({ beast: { ...WOLF, cr_numeric: 0.5 } });
    await run(emissions, 'druid-1', '!wildshape reef-shark');
    // L2 vs swim speed → reject even at legal CR.
    arrange({ beast: { ...WOLF, speed: '{"walk":20,"swim":30}' } });
    await run(emissions, 'druid-1', '!wildshape crab');
    // L4 vs fly → reject.
    arrange({ character: druidRow({ level: 4 }), beast: { ...WOLF, speed: '{"fly":60}' } });
    await run(emissions, 'druid-1', '!wildshape eagle');
    expect(updates()).toHaveLength(0);
    const text = whispersTo(emissions, 'druid-1').join(' ');
    expect(text).toMatch(/maximum is CR 1\/4/);
    expect(text).toMatch(/swimming speed.*Druid level 4/);
    expect(text).toMatch(/flying speed.*Druid level 8/);
  });

  it('lets Circle of the Moon reach CR 1 at L2 and floor(level/3) at L6+, movement gates intact', async () => {
    const emissions: Emission[] = [];
    // Moon L2 + CR 1 → allowed.
    arrange({
      character: druidRow({ class: 'Druid (Circle of the Moon)' }),
      beast: { ...WOLF, cr_numeric: 1 },
    });
    await run(emissions, 'druid-1', '!wildshape dire-wolf');
    expect(updates()).toHaveLength(1);
    // Moon L6 + CR 2 → allowed; CR 3 → rejected; fly at L6 → rejected.
    arrange({
      character: druidRow({ class: 'Druid (Circle of the Moon)', level: 6 }),
      beast: { ...WOLF, cr_numeric: 3 },
    });
    await run(emissions, 'druid-1', '!wildshape killer-whale');
    arrange({
      character: druidRow({ class: 'Druid (Circle of the Moon)', level: 6 }),
      beast: { ...WOLF, cr_numeric: 2, speed: '{"fly":60}' },
    });
    await run(emissions, 'druid-1', '!wildshape quetzalcoatlus');
    const text = whispersTo(emissions, 'druid-1').join(' ');
    expect(text).toMatch(/maximum is CR 2/);
    expect(text).toMatch(/flying speed.*Druid level 8/);
  });

  it('spends one of two short-rest uses via a version-guarded write and keeps exact stats private', async () => {
    arrange({ beast: WOLF });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!wildshape wolf');
    const [sql, params] = updates()[0];
    expect(sql).toMatch(/WHERE id = \$\d+ AND version = \$\d+ RETURNING version/);
    expect(params).toContain(5);
    const features = JSON.parse(String(params[1])) as Array<Record<string, unknown>>;
    expect(features[0]).toMatchObject({
      name: 'Wild Shape',
      usesTotal: 2,
      usesRemaining: 1,
      resetOn: 'short',
    });
    const stored = readWildShapeColumn(String(params[0]));
    expect(stored).toMatchObject({
      status: 'active',
      state: { formHp: 11, formMaxHp: 11, formCr: 0.25 },
    });
    // Public line: name + CR only, no HP/uses totals.
    const pub = publicLines(emissions).join(' ');
    expect(pub).toMatch(/Wild Shapes into a \*\*Wolf\*\*/);
    expect(pub).not.toMatch(/11/);
    expect(pub).not.toMatch(/uses/i);
    // Exact numbers only in the caller whisper + character:updated (dispatcher-scoped).
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/form HP 11\/11.*1\/2/);
    const update = emissions.find((e) => e.event === 'character:updated');
    expect(update?.payload).toMatchObject({ characterId: DRUID, changes: { version: 6 } });
  });

  it('caps imported uses metadata at the official two and refuses an exhausted pool', async () => {
    const emissions: Emission[] = [];
    arrange({
      character: druidRow({
        features: JSON.stringify([{ name: 'Wild Shape', usesTotal: 9, usesRemaining: 9 }]),
      }),
      beast: WOLF,
    });
    await run(emissions, 'druid-1', '!wildshape wolf');
    const features = JSON.parse(String(updates()[0][1][1])) as Array<Record<string, unknown>>;
    expect(features[0]).toMatchObject({ usesTotal: 2, usesRemaining: 1 });
    arrange({
      character: druidRow({
        features: JSON.stringify([{ name: 'Wild Shape', usesTotal: 2, usesRemaining: 0 }]),
      }),
      beast: WOLF,
    });
    await run(emissions, 'druid-1', '!wildshape wolf');
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/no uses remaining/);
  });

  it('fails closed on write conflict / DB error: no fanout, no public success, no announce', async () => {
    for (const update of [[], new Error('db down')] as const) {
      mockQuery.mockReset();
      arrange({ beast: WOLF, update: update as never });
      const emissions: Emission[] = [];
      await run(emissions, 'druid-1', '!wildshape wolf');
      expect(publicLines(emissions)).toHaveLength(0);
      expect(emissions.filter((e) => e.event === 'character:updated')).toHaveLength(0);
      expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/nothing was changed/i);
    }
  });

  it('rejects double-transform and enforces turn/action economy in combat', async () => {
    const emissions: Emission[] = [];
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }), beast: WOLF });
    await run(emissions, 'druid-1', '!wildshape wolf');
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/already transformed/);

    const room = getRoom(SESSION)!;
    const combatState = {
      active: true,
      currentTurnIndex: 0,
      combatants: [
        { tokenId: 'other-token', characterId: null, hp: 10, maxHp: 10, tempHp: 0 },
        { tokenId: 'druid-token', characterId: DRUID, hp: 18, maxHp: 18, tempHp: 0 },
      ],
    };
    room.combatState = combatState as never;
    // Not the druid's turn → rejected before any write.
    arrange({ beast: WOLF });
    await run(emissions, 'druid-1', '!wildshape wolf');
    expect(updates()).toHaveLength(0);
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/only on your own turn/);
    // Their turn but action spent → rejected. Free action → spent after commit.
    combatState.currentTurnIndex = 1;
    room.actionEconomies.set('druid-token', {
      action: true,
      bonusAction: false,
      reaction: false,
      movementRemaining: 30,
      movementMax: 30,
    } as never);
    arrange({ beast: WOLF });
    await run(emissions, 'druid-1', '!wildshape wolf');
    expect(updates()).toHaveLength(0);
    const economy = room.actionEconomies.get('druid-token')! as { action: boolean };
    economy.action = false;
    arrange({ beast: WOLF });
    const emissions2: Emission[] = [];
    await run(emissions2, 'druid-1', '!wildshape wolf');
    expect(economy.action).toBe(true);
    expect(emissions2.some((e) => e.event === 'combat:action-used')).toBe(true);
  });
});

describe('!beast / !revert persisted state', () => {
  it('status is a private whisper from persisted state; bystanders see nothing', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!beast status');
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/Wolf: form HP 11\/11/);
    expect(publicLines(emissions)).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it('partial damage updates only the persisted form; public line has no totals', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!beast dmg 4');
    const [, params] = updates()[0];
    expect(readWildShapeColumn(String(params[0]))).toMatchObject({
      status: 'active',
      state: { formHp: 7 },
    });
    expect(publicLines(emissions).join(' ')).not.toMatch(/7|11/);
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/form HP 7\/11/);
  });

  it('excess damage ends the form and carries into druid HP in ONE guarded update', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!beast dmg 15');
    const all = updates();
    expect(all).toHaveLength(1);
    const [sql, params] = all[0];
    expect(sql).toMatch(/wild_shape = \$1.*hit_points = \$2.*AND version = /s);
    expect(params[0]).toBeNull();
    expect(params[1]).toBe(14); // 18 - (15 - 11)
    expect(publicLines(emissions).join(' ')).toMatch(/drops.*reverts/);
  });

  it('rejects malformed amounts and unreadable stored state without writes', async () => {
    const emissions: Emission[] = [];
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    await run(emissions, 'druid-1', '!beast dmg -5');
    await run(emissions, 'druid-1', '!beast dmg 1e3');
    arrange({ character: druidRow({ wild_shape: '{"formHp":"NaN"' }) });
    await run(emissions, 'druid-1', '!beast dmg 3');
    expect(updates()).toHaveLength(0);
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/unreadable/);
  });

  it('!revert clears the form (guarded), leaves druid HP alone, and can clear corrupt state', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!revert');
    const [sql, params] = updates()[0];
    expect(params[0]).toBeNull();
    expect(sql).not.toMatch(/hit_points/);
    arrange({ character: druidRow({ wild_shape: 'garbage{' }) });
    await run(emissions, 'druid-1', '!revert');
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/cleared an unreadable/);
  });
});

describe('CombatService Wild Shape integration', () => {
  function seedCombat(wildShape: string | null) {
    const room = getRoom(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      round: 1,
      currentTurnIndex: 0,
      combatants: [
        {
          tokenId: 'druid-token',
          characterId: DRUID,
          name: 'Mielikki',
          hp: 18,
          maxHp: 18,
          tempHp: 0,
          isNPC: false,
          deathSaves: { successes: 0, failures: 0 },
          conditions: [],
        },
      ],
    } as never;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT wild_shape')) {
        return { rows: [{ wild_shape: wildShape, version: 5 }] };
      }
      if (sql.startsWith('UPDATE characters')) return { rows: [{ version: 6 }] };
      return { rows: [] };
    });
    return room;
  }

  it('routes combat damage through the form first; excess carries over and ends the form atomically', async () => {
    const room = seedCombat(ACTIVE_WOLF);
    const result = await CombatService.applyDamage(SESSION, 'druid-token', 15);
    expect(result.wildShape).toMatchObject({ formName: 'Wolf', absorbed: 11, ended: true });
    expect(result.hp).toBe(14);
    const update = mockQuery.mock.calls.find((c) => String(c[0]).startsWith('UPDATE characters'))!;
    expect(String(update[0])).toMatch(/wild_shape = \$4 WHERE id = \$5 AND version = \$6/);
    expect(update[1][0]).toBe(14);
    expect(update[1][3]).toBeNull();
    expect(room.combatState!.combatants[0].hp).toBe(14);
  });

  it('form fully absorbs smaller hits — druid HP and conditions untouched', async () => {
    seedCombat(ACTIVE_WOLF);
    const result = await CombatService.applyDamage(SESSION, 'druid-token', 6);
    expect(result.hp).toBe(18);
    expect(result.wildShape).toMatchObject({ absorbed: 6, ended: false });
    const update = mockQuery.mock.calls.find((c) => String(c[0]).startsWith('UPDATE characters'))!;
    expect(readWildShapeColumn(String(update[1][3]))).toMatchObject({
      status: 'active',
      state: { formHp: 5 },
    });
  });

  it('fails closed on version conflict: combatant restored, error thrown', async () => {
    const room = seedCombat(ACTIVE_WOLF);
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT wild_shape'))
        return { rows: [{ wild_shape: ACTIVE_WOLF, version: 5 }] };
      if (sql.startsWith('UPDATE characters')) return { rows: [] };
      return { rows: [] };
    });
    await expect(CombatService.applyDamage(SESSION, 'druid-token', 15)).rejects.toThrow(
      /not applied/
    );
    expect(room.combatState!.combatants[0].hp).toBe(18);
  });

  it('fails closed on unreadable persisted state', async () => {
    seedCombat('not-json{');
    await expect(CombatService.applyDamage(SESSION, 'druid-token', 5)).rejects.toThrow(
      /unreadable/
    );
  });

  it('heals the form (bounded at form max) instead of druid HP while transformed', async () => {
    seedCombat(JSON.stringify({ ...JSON.parse(ACTIVE_WOLF), formHp: 4 }));
    const result = await CombatService.applyHeal(SESSION, 'druid-token', 20);
    expect(result.hp).toBe(18);
    expect(result.wildShape).toMatchObject({ formName: 'Wolf', healed: 7 });
    const update = mockQuery.mock.calls.find((c) => String(c[0]).startsWith('UPDATE characters'))!;
    expect(readWildShapeColumn(String(update[1][0]))).toMatchObject({
      status: 'active',
      state: { formHp: 11 },
    });
  });

  it('untransformed characters keep the existing unguarded damage path', async () => {
    seedCombat(null);
    const result = await CombatService.applyDamage(SESSION, 'druid-token', 5);
    expect(result.hp).toBe(13);
    expect(result.wildShape).toBeUndefined();
    const update = mockQuery.mock.calls.find((c) => String(c[0]).startsWith('UPDATE characters'))!;
    expect(String(update[0])).not.toMatch(/wild_shape/);
  });
});

describe('optimistic-lock rollback (side effects only after the guarded write commits)', () => {
  function seedCombatWithToken(wildShape: string | null, conflict: boolean) {
    const room = getRoom(SESSION)!;
    room.tokens.get('druid-token')!.conditions = ['stable'] as never;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      round: 1,
      currentTurnIndex: 0,
      combatants: [
        {
          tokenId: 'druid-token',
          characterId: DRUID,
          name: 'Mielikki',
          hp: 18,
          maxHp: 18,
          tempHp: 3,
          isNPC: false,
          deathSaves: { successes: 1, failures: 2 },
          conditions: ['stable'],
        },
      ],
    } as never;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT wild_shape')) {
        return { rows: [{ wild_shape: wildShape, version: 5 }] };
      }
      if (sql.startsWith('UPDATE characters')) return { rows: conflict ? [] : [{ version: 6 }] };
      return { rows: [] };
    });
    return room;
  }

  it('a conflicted damage write leaves conditions, token rows, and the combatant fully unchanged', async () => {
    const room = seedCombatWithToken(ACTIVE_WOLF, true);
    // 40 damage would end the form, drop the druid to 0, remove
    // stable, apply unconscious, and run concentration/grapple
    // cleanup — none of that may happen on a version conflict.
    await expect(CombatService.applyDamage(SESSION, 'druid-token', 40)).rejects.toThrow(
      /not applied/
    );
    const combatant = room.combatState!.combatants[0];
    expect(combatant.hp).toBe(18);
    expect(combatant.tempHp).toBe(3);
    expect(combatant.deathSaves).toEqual({ successes: 1, failures: 2 });
    expect(room.tokens.get('druid-token')!.conditions).toEqual(['stable']);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((sql) => sql.startsWith('UPDATE characters'))).toHaveLength(1);
    expect(sqls.some((sql) => sql.includes('UPDATE tokens'))).toBe(false);
    expect(sqls.some((sql) => sql.includes('concentrating_on'))).toBe(false);
  });

  it('on success the character/form write commits BEFORE token side-effect writes', async () => {
    const room = seedCombatWithToken(ACTIVE_WOLF, false);
    await CombatService.applyDamage(SESSION, 'druid-token', 40);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    const characterWrite = sqls.findIndex((sql) => sql.startsWith('UPDATE characters'));
    const tokenWrite = sqls.findIndex((sql) => sql.includes('UPDATE tokens'));
    expect(characterWrite).toBeGreaterThanOrEqual(0);
    expect(tokenWrite).toBeGreaterThan(characterWrite);
    const conditions = room.tokens.get('druid-token')!.conditions as unknown as string[];
    expect(conditions).toContain('unconscious');
    expect(conditions).not.toContain('stable');
  });
});

describe('out-of-combat direct !damage / !heal / !hp with an active form', () => {
  function wildShapeEmissions(emissions: Emission[]) {
    return emissions.filter(
      (e) =>
        e.event === 'character:updated' &&
        (e.payload as { changes?: { wildShape?: unknown } }).changes?.wildShape !== undefined
    );
  }

  it('!damage routes through the form in one guarded write; base HP untouched; bystanders see no form HP', async () => {
    getRoom(SESSION)!.showPlayersToPlayers = true;
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 6');
    const all = updates();
    expect(all).toHaveLength(1);
    const [sql, params] = all[0];
    expect(sql).toMatch(/wild_shape = \$1 WHERE id = \$2 AND version = \$3/);
    expect(sql).not.toMatch(/hit_points/);
    expect(readWildShapeColumn(String(params[0]))).toMatchObject({
      status: 'active',
      state: { formHp: 5 },
    });
    const wsEmits = wildShapeEmissions(emissions);
    expect(wsEmits.length).toBeGreaterThan(0);
    for (const e of wsEmits) expect(['dm-1', 'druid-1']).toContain(e.channelId);
    const bystanderPayloads = JSON.stringify(
      emissions.filter((e) => e.channelId === 'bystander-1').map((e) => e.payload)
    );
    expect(bystanderPayloads).not.toMatch(/formHp/);
  });

  it('!damage past the form HP ends the form and carries over atomically', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 15');
    const all = updates();
    expect(all).toHaveLength(1);
    const [sql, params] = all[0];
    expect(sql).toMatch(/wild_shape = \$1, hit_points = \$2 WHERE id = \$3 AND version = \$4/);
    expect(params[0]).toBeNull();
    expect(params[1]).toBe(14); // 18 - (15 - 11)
  });

  it('!damage consumes temp HP before the form: partial absorption leaves the form untouched', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF, temp_hit_points: 8 }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 5');
    const all = updates();
    expect(all).toHaveLength(1);
    const [sql, params] = all[0];
    // One guarded write: form (unchanged) + temp pool; base HP untouched.
    expect(sql).toMatch(/wild_shape = \$1, temp_hit_points = \$2 WHERE id = \$3 AND version = \$4/);
    expect(sql).not.toMatch(/(?<!temp_)hit_points/);
    expect(params[1]).toBe(3); // 8 temp - 5 damage
    expect(readWildShapeColumn(String(params[0]))).toMatchObject({
      status: 'active',
      state: { formHp: 11 },
    });
    // The committed temp HP is what fans out.
    const hpChanged = emissions.find((e) => e.event === 'combat:hp-changed');
    expect(hpChanged?.payload).toMatchObject({ hp: 18, tempHp: 3 });
  });

  it('!damage exhausts temp HP, then the form, then carries the excess into the druid — one guarded write', async () => {
    // 20 damage: 3 temp + 11 form + 6 into the druid (18 → 12).
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF, temp_hit_points: 3 }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 20');
    const all = updates();
    expect(all).toHaveLength(1);
    const [sql, params] = all[0];
    expect(sql).toMatch(
      /wild_shape = \$1, hit_points = \$2, temp_hit_points = \$3 WHERE id = \$4 AND version = \$5/
    );
    expect(params[0]).toBeNull(); // form ended
    expect(params[1]).toBe(12);
    expect(params[2]).toBe(0);
    const hpChanged = emissions.find((e) => e.event === 'combat:hp-changed');
    expect(hpChanged?.payload).toMatchObject({ hp: 12, tempHp: 0 });
    // Smaller hit: temp exhausted, remainder dents only the form.
    mockQuery.mockClear();
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF, temp_hit_points: 3 }) });
    const emissions2: Emission[] = [];
    await run(emissions2, 'druid-1', '!damage 9');
    const [sql2, params2] = updates()[0];
    expect(sql2).toMatch(
      /wild_shape = \$1, temp_hit_points = \$2 WHERE id = \$3 AND version = \$4/
    );
    expect(sql2).not.toMatch(/(?<!temp_)hit_points/);
    expect(params2[1]).toBe(0);
    expect(readWildShapeColumn(String(params2[0]))).toMatchObject({
      status: 'active',
      state: { formHp: 5 }, // 11 - (9 - 3)
    });
  });

  it('a conflicted temp-consuming !damage fails closed: whispered, no pool changed, no fanout', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF, temp_hit_points: 3 }), update: [] });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 20');
    expect(updates()).toHaveLength(1); // the single guarded attempt, refused
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/changed mid-action/);
    expect(emissions.filter((e) => e.event === 'character:updated')).toHaveLength(0);
    expect(emissions.filter((e) => e.event === 'combat:hp-changed')).toHaveLength(0);
  });

  it('!heal leaves temp HP unchanged and restores only the form', async () => {
    arrange({
      character: druidRow({
        wild_shape: JSON.stringify({ ...JSON.parse(ACTIVE_WOLF), formHp: 4 }),
        temp_hit_points: 6,
      }),
    });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!heal 5');
    const [sql, params] = updates()[0];
    expect(sql).not.toMatch(/temp_hit_points|hit_points = /);
    expect(readWildShapeColumn(String(params[0]))).toMatchObject({
      status: 'active',
      state: { formHp: 9 },
    });
    const hpChanged = emissions.find((e) => e.event === 'combat:hp-changed');
    expect(hpChanged?.payload).toMatchObject({ hp: 18, tempHp: 6 });
  });

  it('!heal restores the form (bounded), never the druid pool', async () => {
    arrange({
      character: druidRow({
        wild_shape: JSON.stringify({ ...JSON.parse(ACTIVE_WOLF), formHp: 4 }),
        hit_points: 10,
      }),
    });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!heal 20');
    const all = updates();
    expect(all).toHaveLength(1);
    const [sql, params] = all[0];
    expect(sql).not.toMatch(/hit_points/);
    expect(readWildShapeColumn(String(params[0]))).toMatchObject({
      status: 'active',
      state: { formHp: 11 },
    });
  });

  it('fails closed on a version conflict: whispered, nothing fanned out', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }), update: [] });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 6');
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/changed mid-action/);
    expect(emissions.filter((e) => e.event === 'character:updated')).toHaveLength(0);
  });

  it('fails closed on unreadable state with the !revert instruction, no writes', async () => {
    arrange({ character: druidRow({ wild_shape: 'garbage{' }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!damage 6');
    await run(emissions, 'druid-1', '!heal 6');
    await run(emissions, 'druid-1', '!hp 10');
    expect(updates()).toHaveLength(0);
    const text = whispersTo(emissions, 'druid-1').join(' ');
    expect(text).toMatch(/unreadable.*!revert.*unreadable.*!revert.*unreadable.*!revert/s);
  });

  it('absolute !hp refuses while wild-shaped instead of clobbering base HP', async () => {
    arrange({ character: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const emissions: Emission[] = [];
    await run(emissions, 'druid-1', '!hp 10');
    expect(updates()).toHaveLength(0);
    expect(whispersTo(emissions, 'druid-1').join(' ')).toMatch(/wild-shaped.*!revert/s);
  });

  it('in-combat chat damage syncs the form privately to DM and owner tabs only', async () => {
    const room = getRoom(SESSION)!;
    room.showPlayersToPlayers = true;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      round: 1,
      currentTurnIndex: 0,
      combatants: [
        {
          tokenId: 'druid-token',
          characterId: DRUID,
          name: 'Mielikki',
          hp: 18,
          maxHp: 18,
          tempHp: 0,
          isNPC: false,
          deathSaves: { successes: 0, failures: 0 },
          conditions: [],
        },
      ],
    } as never;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT wild_shape')) {
        return { rows: [{ wild_shape: ACTIVE_WOLF, version: 5 }] };
      }
      if (sql.startsWith('UPDATE characters')) return { rows: [{ version: 6 }] };
      return { rows: [] };
    });
    const emissions: Emission[] = [];
    await run(emissions, 'dm-1', '!damage 6 Mielikki');
    const wsEmits = wildShapeEmissions(emissions);
    expect(wsEmits.length).toBeGreaterThan(0);
    for (const e of wsEmits) {
      expect(['dm-1', 'druid-1']).toContain(e.channelId);
      expect(
        (e.payload as { changes: { wildShape: { formHp: number } } }).changes.wildShape.formHp
      ).toBe(5);
    }
    const bystanderPayloads = JSON.stringify(
      emissions.filter((e) => e.channelId === 'bystander-1').map((e) => e.payload)
    );
    expect(bystanderPayloads).not.toMatch(/formHp/);
  });
});
