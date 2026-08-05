import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const {
  poolQuery,
  connect,
  clientQuery,
  release,
  loadDrawingsForMapAsync,
  filterDrawingsForPlayer,
  loadZonesForMap,
} = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  loadDrawingsForMapAsync: vi.fn(),
  filterDrawingsForPlayer: vi.fn(),
  loadZonesForMap: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({
  default: { query: poolQuery, connect },
}));

vi.mock('../socket/drawingEvents.js', () => ({
  loadDrawingsForMapAsync,
  filterDrawingsForPlayer,
}));

vi.mock('../socket/mapEvents.js', () => ({
  loadZonesForMap,
}));

import { registerSceneEvents } from '../socket/sceneEvents.js';
import { addPlayerToRoom, createRoom, deleteRoom, getAllRooms } from '../utils/roomState.js';

type Handler = (data: unknown) => Promise<void> | void;

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION_ID = 'session-scene-atomic';
const DM_SOCKET_ID = 'dm-scene-socket';

const mapRow = {
  id: 'map-new',
  session_id: SESSION_ID,
  name: 'New Scene',
  image_url: '/maps/new.png',
  width: 1400,
  height: 1050,
  grid_size: 70,
  grid_type: 'square',
  grid_offset_x: 0,
  grid_offset_y: 0,
  walls: '[]',
  fog_state: '[]',
  ambient_light: 'bright',
  ambient_opacity: null,
};

function token(id: string): Token {
  return {
    id,
    mapId: 'map-old',
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
  };
}

function harness() {
  const emissions: Emission[] = [];
  const handlers = new Map<string, Handler>();
  const socket = {
    id: DM_SOCKET_ID,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: DM_SOCKET_ID, event, payload }),
  };
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  };
  registerSceneEvents(io as never, socket as never);
  return { emissions, handlers };
}

function seedRoom() {
  const room = createRoom(SESSION_ID, 'SCENE', 'dm-user');
  room.playerMapId = 'stale-room-map';
  room.currentMapId = 'stale-room-map';
  room.tokens.set('old-token', token('old-token'));
  addPlayerToRoom(SESSION_ID, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: DM_SOCKET_ID,
    role: 'dm',
    characterId: null,
  });
  return room;
}

beforeEach(() => {
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  poolQuery.mockReset();
  connect.mockReset();
  clientQuery.mockReset();
  release.mockReset();
  connect.mockResolvedValue({ query: clientQuery, release });
  loadDrawingsForMapAsync.mockReset();
  loadDrawingsForMapAsync.mockResolvedValue([]);
  filterDrawingsForPlayer.mockReset();
  filterDrawingsForPlayer.mockReturnValue([]);
  loadZonesForMap.mockReset();
  loadZonesForMap.mockResolvedValue([]);
});

describe('map:activate-for-players transaction', () => {
  it('commits staged tokens, migration, and session pointers before mutating room state', async () => {
    const room = seedRoom();
    const roomPointersAtCommit: Array<[string | null, string | null]> = [];
    poolQuery.mockResolvedValueOnce({ rows: [mapRow] }).mockResolvedValueOnce({ rows: [] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') {
        roomPointersAtCommit.push([room.playerMapId, room.currentMapId]);
        return { rows: [], rowCount: null };
      }
      if (/SELECT \* FROM maps/.test(sql)) return { rows: [mapRow], rowCount: 1 };
      if (/SELECT player_map_id FROM sessions/.test(sql)) {
        return { rows: [{ player_map_id: 'map-old' }], rowCount: 1 };
      }
      if (/SELECT id FROM tokens WHERE map_id/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id, character_id FROM tokens/.test(sql)) {
        return { rows: [{ id: 'pc-old', character_id: 'character-old' }], rowCount: 1 };
      }
      if (/SELECT character_id FROM tokens/.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE sessions SET player_map_id/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const { emissions, handlers } = harness();

    await handlers.get('map:activate-for-players')!({
      mapId: 'map-new',
      stagedPositions: [
        {
          characterId: 'character-staged',
          name: 'Staged Hero',
          x: 140,
          y: 210,
          imageUrl: null,
          ownerUserId: 'player-user',
        },
      ],
    });

    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toMatch(/SELECT \* FROM maps.*FOR UPDATE/);
    expect(sql[2]).toMatch(/SELECT player_map_id FROM sessions.*FOR UPDATE/);
    expect(sql.some((query) => /INSERT INTO tokens/.test(query))).toBe(true);
    expect(sql.some((query) => /UPDATE tokens SET map_id/.test(query))).toBe(true);
    expect(sql.at(-2)).toMatch(/UPDATE sessions SET player_map_id/);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(
      clientQuery.mock.calls.find(([query]) =>
        /SELECT id, character_id FROM tokens/.test(query)
      )?.[1]
    ).toEqual(['map-old']);
    expect(roomPointersAtCommit).toEqual([['stale-room-map', 'stale-room-map']]);
    expect(room.playerMapId).toBe('map-new');
    expect(room.currentMapId).toBe('map-new');
    expect(release).toHaveBeenCalledTimes(1);
    expect(emissions.some((emission) => emission.event === 'map:loaded')).toBe(true);
    expect(emissions.some((emission) => emission.event === 'map:player-map-changed')).toBe(true);
  });

  it('rolls back every write and preserves live room state when staging fails', async () => {
    const room = seedRoom();
    poolQuery.mockResolvedValueOnce({ rows: [mapRow] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM maps/.test(sql)) return { rows: [mapRow], rowCount: 1 };
      if (/SELECT player_map_id FROM sessions/.test(sql)) {
        return { rows: [{ player_map_id: 'map-old' }], rowCount: 1 };
      }
      if (/SELECT id FROM tokens WHERE map_id/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO tokens/.test(sql)) throw new Error('insert failed');
      return { rows: [], rowCount: null };
    });
    const { emissions, handlers } = harness();

    await handlers.get('map:activate-for-players')!({
      mapId: 'map-new',
      stagedPositions: [
        {
          characterId: 'character-staged',
          name: 'Staged Hero',
          x: 140,
          y: 210,
          imageUrl: null,
          ownerUserId: 'player-user',
        },
      ],
    });

    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
    expect(sql.some((query) => /UPDATE sessions SET player_map_id/.test(query))).toBe(false);
    expect(room.playerMapId).toBe('stale-room-map');
    expect(room.currentMapId).toBe('stale-room-map');
    expect(room.tokens.has('old-token')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(emissions.some((emission) => emission.event === 'map:loaded')).toBe(false);
    expect(emissions.some((emission) => emission.event === 'map:player-map-changed')).toBe(false);
    expect(emissions).toContainEqual({
      channelId: DM_SOCKET_ID,
      event: 'session:error',
      payload: { message: 'Failed to move players to this map' },
    });
  });

  it('rolls back completed token work when the session pointer update fails', async () => {
    const room = seedRoom();
    poolQuery.mockResolvedValueOnce({ rows: [mapRow] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM maps/.test(sql)) return { rows: [mapRow], rowCount: 1 };
      if (/SELECT player_map_id FROM sessions/.test(sql)) {
        return { rows: [{ player_map_id: 'map-old' }], rowCount: 1 };
      }
      if (/SELECT id, character_id FROM tokens/.test(sql)) {
        return { rows: [{ id: 'pc-old', character_id: 'character-old' }], rowCount: 1 };
      }
      if (/SELECT character_id FROM tokens/.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE sessions SET player_map_id/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const { emissions, handlers } = harness();

    await handlers.get('map:activate-for-players')!({ mapId: 'map-new' });

    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql.some((query) => /UPDATE tokens SET map_id/.test(query))).toBe(true);
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
    expect(room.playerMapId).toBe('stale-room-map');
    expect(room.currentMapId).toBe('stale-room-map');
    expect(room.tokens.has('old-token')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(emissions.some((emission) => emission.event === 'map:loaded')).toBe(false);
  });
});
