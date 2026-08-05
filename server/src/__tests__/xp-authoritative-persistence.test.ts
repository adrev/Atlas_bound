import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery, connect: mockConnect },
}));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import { initDatabase } from '../db/schema.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
} from '../utils/roomState.js';
import '../services/chatCommands/xpAndWildShapeHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'xp-session';
const ALICE = 'alice-character';
const BOB = 'bob-character';
const SIR_ALDRIC = 'sir-aldric-character';

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
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'XPXP', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'alice-token',
    token('alice-token', { characterId: ALICE, ownerUserId: 'alice-user', name: 'Alice' })
  );
  // Second token for the same character — awards must dedupe to one write.
  room.tokens.set(
    'alice-token-2',
    token('alice-token-2', {
      characterId: ALICE,
      ownerUserId: 'alice-user',
      name: 'Alice',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
  );
  room.tokens.set(
    'bob-token',
    token('bob-token', { characterId: BOB, ownerUserId: 'bob-user', name: 'Bob' })
  );
  // Same name as an on-map PC but on another map — must never resolve.
  room.tokens.set(
    'off-map-zed',
    token('off-map-zed', {
      mapId: 'map-2',
      characterId: 'zed-character',
      ownerUserId: 'zed-user',
      name: 'Zed',
      createdAt: '2099-01-01T00:00:00.000Z',
    })
  );
  room.tokens.set('sheetless', token('sheetless', { ownerUserId: 'dm-user', name: 'Statue' }));
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['alice-user', 'alice-1', 'player', ALICE],
    ['alice-user', 'alice-2', 'player', ALICE],
    ['bob-user', 'bob-1', 'player', BOB],
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

function aliceRow(overrides: Record<string, unknown> = {}) {
  return { name: 'Alice', level: 3, experience: 900, version: 7, ...overrides };
}

function bobRow(overrides: Record<string, unknown> = {}) {
  return { name: 'Bob', level: 3, experience: 1200, version: 11, ...overrides };
}

/**
 * Wire the transaction client. SELECTs answer per characterId; guarded
 * UPDATEs answer (or throw) per characterId. Defaults simulate the
 * version trigger (RETURNING selected + 1).
 */
function arrange(
  options: {
    rows?: Record<string, Record<string, unknown> | null>;
    updates?: Record<string, Array<Record<string, unknown>> | Error>;
  } = {}
): void {
  const rows: Record<string, Record<string, unknown> | null> = {
    [ALICE]: aliceRow(),
    [BOB]: bobRow(),
    ...options.rows,
  };
  mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT name, level, experience, version')) {
      const row = rows[params?.[0] as string];
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('UPDATE characters SET experience')) {
      const characterId = params?.[1] as string;
      const result = options.updates?.[characterId];
      if (result instanceof Error) throw result;
      if (result) return { rows: result };
      return { rows: [{ version: (params?.[2] as number) + 1 }] };
    }
    return { rows: [] };
  });
  // Read-only paths (threshold / report) go through pool.query.
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT name, level, experience')) {
      const row = rows[params?.[0] as string];
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
}

function clientCalls(): string[] {
  return mockClientQuery.mock.calls.map((call) => String(call[0]));
}

function guardedUpdates(): Array<[string, unknown[]]> {
  return mockClientQuery.mock.calls
    .filter((call) => String(call[0]).startsWith('UPDATE characters SET experience'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
}

function emissionsFor(emissions: Emission[], event: string): Emission[] {
  return emissions.filter((emission) => emission.event === event);
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissionsFor(emissions, event)
    .map((emission) => emission.channelId)
    .sort();
}

function whispers(emissions: Emission[]): Array<{ channelId: string; content: string }> {
  return emissions
    .filter(
      (emission) =>
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'whisper'
    )
    .map((emission) => ({
      channelId: emission.channelId,
      content: (emission.payload as { content: string }).content,
    }));
}

function publicMessages(emissions: Emission[]): string[] {
  return emissions
    .filter(
      (emission) =>
        emission.channelId === SESSION &&
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'system'
    )
    .map((emission) => (emission.payload as { content: string }).content);
}

function expectFailedClosed(emissions: Emission[], callerSocket = 'dm-1'): void {
  expect(emissionsFor(emissions, 'character:updated')).toEqual([]);
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
  expect(whispers(emissions)[0].channelId).toBe(callerSocket);
}

async function runAs(socketId: string, raw: string, emissions: Emission[]): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId(socketId)!, raw);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

describe('!xp award — authoritative persisted XP', () => {
  it('awards through one transaction with per-character version-guarded UPDATEs', async () => {
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice Bob 500', emissions);

    expect(clientCalls()[0]).toBe('BEGIN');
    expect(clientCalls()[clientCalls().length - 1]).toBe('COMMIT');
    expect(guardedUpdates()).toEqual([
      [
        'UPDATE characters SET experience = $1 WHERE id = $2 AND version = $3 RETURNING version',
        [1400, ALICE, 7],
      ],
      [
        'UPDATE characters SET experience = $1 WHERE id = $2 AND version = $3 RETURNING version',
        [1700, BOB, 11],
      ],
    ]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('never persists XP through the unguarded pool on the award path', async () => {
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice 500', emissions);
    expect(mockQuery.mock.calls.filter((call) => String(call[0]).startsWith('UPDATE'))).toEqual([]);
  });

  it('fans exact totals + authoritative versions only to DM and owner tabs', async () => {
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice 500', emissions);

    const updates = emissionsFor(emissions, 'character:updated');
    expect(updates.map((u) => u.channelId).sort()).toEqual(['alice-1', 'alice-2', 'dm-1', 'dm-2']);
    for (const update of updates) {
      expect(update.payload).toEqual({
        characterId: ALICE,
        changes: { experience: 1400, version: 8 },
      });
    }
  });

  it('public line shows amount and eligibility but never exact totals', async () => {
    arrange({ rows: { [ALICE]: aliceRow({ experience: 2500 }) } });
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice 500', emissions);

    const publics = publicMessages(emissions);
    expect(publics).toHaveLength(1);
    expect(publics[0]).toContain('awards 500 XP to Alice');
    expect(publics[0]).toContain('eligible for level 4');
    expect(publics[0]).not.toContain('3000');
    expect(publics[0]).not.toContain('2500');
    // Exact new total goes to the DM caller as a whisper.
    const dmWhisper = whispers(emissions).find((w) => w.channelId === 'dm-1');
    expect(dmWhisper?.content).toContain('3000 XP total');
  });

  it('never mutates level — eligibility is reported, not applied', async () => {
    arrange({ rows: { [ALICE]: aliceRow({ level: 3, experience: 2600 }) } });
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice 200', emissions);

    const sql = [...clientCalls(), ...mockQuery.mock.calls.map((call) => String(call[0]))];
    expect(sql.some((s) => /SET\s+level/i.test(s))).toBe(false);
    const update = emissionsFor(emissions, 'character:updated')[0].payload as {
      changes: Record<string, unknown>;
    };
    expect(update.changes).not.toHaveProperty('level');
    expect(publicMessages(emissions)[0]).toContain('eligible for level 4');
  });

  it('deduplicates repeated names and same-character tokens into one award', async () => {
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice alice Alice 100', emissions);
    expect(guardedUpdates()).toHaveLength(1);
    expect(guardedUpdates()[0][1]).toEqual([1000, ALICE, 7]);
  });

  it('supports a single character name containing spaces', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.set(
      'sir-aldric-token',
      token('sir-aldric-token', {
        characterId: SIR_ALDRIC,
        ownerUserId: 'alice-user',
        name: 'Sir Aldric',
      })
    );
    arrange({
      rows: {
        [SIR_ALDRIC]: {
          name: 'Sir Aldric',
          level: 3,
          experience: 900,
          version: 4,
        },
      },
    });
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Sir Aldric 100', emissions);

    expect(guardedUpdates()).toHaveLength(1);
    expect(guardedUpdates()[0][1]).toEqual([1000, SIR_ALDRIC, 4]);
  });

  it('supports comma-separated character names containing spaces', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.set(
      'sir-aldric-token',
      token('sir-aldric-token', {
        characterId: SIR_ALDRIC,
        ownerUserId: 'alice-user',
        name: 'Sir Aldric',
      })
    );
    arrange({
      rows: {
        [SIR_ALDRIC]: {
          name: 'Sir Aldric',
          level: 3,
          experience: 900,
          version: 4,
        },
      },
    });
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Sir Aldric, Bob 100', emissions);

    expect(guardedUpdates().map(([, params]) => params[1])).toEqual([SIR_ALDRIC, BOB]);
  });

  it('caps eligibility at level 20 and reports max level safely', async () => {
    arrange({ rows: { [ALICE]: aliceRow({ level: 20, experience: 400000 }) } });
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp Alice 1000', emissions);
    const publics = publicMessages(emissions);
    expect(publics).toHaveLength(1);
    expect(publics[0]).not.toMatch(/level 2[1-9]/);
    expect(publics[0]).not.toContain('eligible');
  });

  describe('fail-closed paths (no fanout, no public success, single caller whisper)', () => {
    it('rolls back the whole award when the second target conflicts (no partial award)', async () => {
      arrange({ updates: { [BOB]: [] } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice Bob 500', emissions);

      expect(clientCalls()).toContain('ROLLBACK');
      expect(clientCalls()).not.toContain('COMMIT');
      expectFailedClosed(emissions);
      expect(whispers(emissions)[0].content).toContain('no XP was awarded');
    });

    it('fails closed on a DB error during the guarded UPDATE', async () => {
      arrange({ updates: { [ALICE]: new Error('boom') } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 500', emissions);
      expect(clientCalls()).toContain('ROLLBACK');
      expectFailedClosed(emissions);
    });

    it('fails closed when the selected version is unusable, without attempting the write', async () => {
      arrange({ rows: { [ALICE]: aliceRow({ version: 0 }) } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 500', emissions);
      expect(guardedUpdates()).toEqual([]);
      expectFailedClosed(emissions);
    });

    it('fails closed when stored XP is malformed, without attempting the write', async () => {
      arrange({ rows: { [ALICE]: aliceRow({ experience: 'lots' }) } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 500', emissions);
      expect(guardedUpdates()).toEqual([]);
      expectFailedClosed(emissions);
    });

    it('fails closed when the total would overflow the nonnegative INT4 bound', async () => {
      arrange({ rows: { [ALICE]: aliceRow({ experience: 2_000_000_000 }) } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 1', emissions);
      expect(guardedUpdates()).toEqual([]);
      expectFailedClosed(emissions);
    });

    it('fails closed when a character row is missing', async () => {
      arrange({ rows: { [ALICE]: null } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 500', emissions);
      expect(guardedUpdates()).toEqual([]);
      expectFailedClosed(emissions);
    });

    it('rolls back when RETURNING yields an unusable version — never fabricates one', async () => {
      arrange({ updates: { [ALICE]: [{ version: 'seven' }] } });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 500', emissions);
      expect(clientCalls()).toContain('ROLLBACK');
      expect(clientCalls()).not.toContain('COMMIT');
      expectFailedClosed(emissions);
    });

    it('whispers a truthful non-success when COMMIT itself fails', async () => {
      arrange();
      const base = mockClientQuery.getMockImplementation()!;
      mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql === 'COMMIT') throw new Error('connection lost');
        return base(sql, params);
      });
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice 500', emissions);
      expectFailedClosed(emissions);
      expect(whispers(emissions)[0].content).toContain('could not be confirmed');
    });

    it('awards nothing when any named target is off the viewing map', async () => {
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Alice Zed 500', emissions);
      expect(mockConnect).not.toHaveBeenCalled();
      expectFailedClosed(emissions);
      expect(whispers(emissions)[0].content).toContain('Zed');
    });

    it('awards nothing when a target token has no character sheet', async () => {
      const emissions: Emission[] = [];
      await runAs('dm-1', '!xp Statue 500', emissions);
      expect(mockConnect).not.toHaveBeenCalled();
      expectFailedClosed(emissions);
    });

    it.each(['100abc', '2.5', '1e3', '+100', '-100', '0', '1000000', 'NaN'])(
      'rejects non-strict amount %s before any query',
      async (amount) => {
        const emissions: Emission[] = [];
        await runAs('dm-1', `!xp Alice ${amount}`, emissions);
        expect(mockConnect).not.toHaveBeenCalled();
        expect(mockClientQuery).not.toHaveBeenCalled();
        expectFailedClosed(emissions);
      }
    );
  });

  it('refuses award for non-DM callers with no query at all', async () => {
    const emissions: Emission[] = [];
    await runAs('alice-1', '!xp Bob 500', emissions);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
    expectFailedClosed(emissions, 'alice-1');
    expect(whispers(emissions)[0].content).toContain('DM only');
  });
});

describe('!xp report — DM-only, whispered, viewing-map scoped', () => {
  it('whispers deduplicated party totals only to the requesting DM tab', async () => {
    const emissions: Emission[] = [];
    await runAs('dm-1', '!xp report', emissions);

    expect(publicMessages(emissions)).toEqual([]);
    expect(emissionsFor(emissions, 'character:updated')).toEqual([]);
    const report = whispers(emissions);
    expect(report).toHaveLength(1);
    expect(report[0].channelId).toBe('dm-1');
    expect(report[0].content).toContain('Alice: L3, 900 XP');
    expect(report[0].content).toContain('Bob: L3, 1200 XP');
    expect(report[0].content).not.toContain('Zed');
    // Two alice tokens, one character — one line.
    expect(report[0].content.match(/Alice/g)).toHaveLength(1);
  });

  it('is refused for players', async () => {
    const emissions: Emission[] = [];
    await runAs('alice-1', '!xp report', emissions);
    expect(mockQuery).not.toHaveBeenCalled();
    expectFailedClosed(emissions, 'alice-1');
    expect(whispers(emissions)[0].content).toContain('DM only');
  });
});

describe('!xp threshold — own linked character only', () => {
  it('whispers the linked character status to the caller only', async () => {
    const emissions: Emission[] = [];
    await runAs('alice-1', '!xp threshold', emissions);

    expect(publicMessages(emissions)).toEqual([]);
    const status = whispers(emissions);
    expect(status).toHaveLength(1);
    expect(status[0].channelId).toBe('alice-1');
    expect(status[0].content).toContain('Alice — Level 3, 900 XP');
    expect(status[0].content).toContain('1800 XP to level 4 (threshold 2700)');
    // Reads only the caller's own linked character.
    expect(mockQuery.mock.calls.map((call) => call[1])).toEqual([[ALICE]]);
  });

  it('reports max level at 20 without inventing a level 21 threshold', async () => {
    arrange({ rows: { [ALICE]: aliceRow({ level: 20, experience: 355000 }) } });
    const emissions: Emission[] = [];
    await runAs('alice-1', '!xp threshold', emissions);
    const status = whispers(emissions)[0];
    expect(status.content).toContain('Maximum level reached');
    expect(status.content).not.toContain('level 21');
  });

  it('mentions pending eligibility without touching the stored level', async () => {
    arrange({ rows: { [ALICE]: aliceRow({ level: 3, experience: 2800 }) } });
    const emissions: Emission[] = [];
    await runAs('alice-1', '!xp threshold', emissions);
    expect(whispers(emissions)[0].content).toContain('Eligible for level 4');
    expect(mockQuery.mock.calls.some((call) => /UPDATE/i.test(String(call[0])))).toBe(false);
  });

  it('fails closed when stored XP is unreadable', async () => {
    arrange({ rows: { [ALICE]: aliceRow({ experience: null }) } });
    const emissions: Emission[] = [];
    await runAs('alice-1', '!xp threshold', emissions);
    expectFailedClosed(emissions, 'alice-1');
    expect(whispers(emissions)[0].content).toContain('unreadable');
  });
});

describe('characters.experience schema migration', () => {
  async function capturedDdl(): Promise<string> {
    mockQuery.mockResolvedValue({ rows: [] });
    await initDatabase();
    return mockQuery.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('creates fresh schemas with a nonnegative experience column', async () => {
    const ddl = await capturedDdl();
    expect(ddl).toMatch(
      /CREATE TABLE IF NOT EXISTS characters[\s\S]*experience INTEGER NOT NULL DEFAULT 0 CONSTRAINT characters_experience_nonnegative CHECK \(experience >= 0\)/
    );
  });

  it('migrates existing databases idempotently without dropping the live constraint', async () => {
    const ddl = await capturedDdl();
    expect(ddl).toContain(
      'ALTER TABLE characters ADD COLUMN IF NOT EXISTS experience INTEGER NOT NULL DEFAULT 0;'
    );
    expect(ddl).toContain('UPDATE characters SET experience = 0 WHERE experience < 0;');
    expect(ddl).not.toContain('DROP CONSTRAINT IF EXISTS characters_experience_nonnegative');
    expect(ddl).toMatch(
      /ALTER TABLE characters\s+ADD CONSTRAINT characters_experience_nonnegative CHECK \(experience >= 0\);/
    );
    expect(ddl).toContain('EXCEPTION WHEN duplicate_object THEN');
  });
});
