/**
 * Integration coverage for the map-scoped + hidden-token fan-out that
 * `tokenEvents.ts` applies to `map:token-move` (and the identical filter
 * on `map:token-add`). Pins the behavior CodeX shipped in 98bd0a6:
 *
 *   - a token move is broadcast only to sockets rendering the token's map
 *     (DM-preview moves must not leak to players on the ribbon map);
 *   - a hidden/invisible token's move reaches only sockets that should see it,
 *     never unrelated player sockets, even when the player is on the same map.
 *
 * Same fake-io/socket harness style as combat-start-integration.test.ts —
 * no real Socket.IO boot. We inject a DM "mover" socket, invoke the
 * handler, and assert which socket channels received `map:token-moved`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerTokenEvents } from '../socket/tokenEvents.js';
import { createRoom, getAllRooms, addPlayerToRoom } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function makeHarness(actorSocketId: string) {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const emissions: Emission[] = [];
  const record = (channelId: string) => ({
    emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
  });
  const io = { to: record } as never;
  const socket = {
    id: actorSocketId,
    data: { userId: 'dm-user', displayName: 'DM' },
    on: (event: string, handler: (d: unknown) => Promise<void> | void) => {
      handlers[event] = handler;
    },
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: actorSocketId, event, payload }),
    join: () => {},
    to: record,
  } as never;
  return { io, socket, handlers, emissions };
}

function tok(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    version: 1,
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

function tokenRow(token: Token): Record<string, unknown> {
  return {
    id: token.id,
    version: token.version ?? 1,
    map_id: token.mapId,
    character_id: token.characterId,
    name: token.name,
    x: token.x,
    y: token.y,
    size: token.size,
    image_url: token.imageUrl,
    color: token.color,
    layer: token.layer,
    visible: token.visible ? 1 : 0,
    has_light: token.hasLight ? 1 : 0,
    light_radius: token.lightRadius,
    light_dim_radius: token.lightDimRadius,
    light_color: token.lightColor,
    conditions: JSON.stringify(token.conditions),
    owner_user_id: token.ownerUserId,
    faction: token.faction ?? 'neutral',
    created_at: token.createdAt,
    aura: null,
    vision_overrides: null,
  };
}

const SESSION = 's-fanout';

/** Seed a room with a DM and one player, both on the ribbon map-1. */
function seedRoom(tokens: Token[]): void {
  const room = createRoom(SESSION, 'ROOM-FAN', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'free-roam';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'player-user',
    displayName: 'Pip',
    socketId: 'player-sock',
    role: 'player',
    characterId: null,
  });
}

function movedChannels(emissions: Emission[]): string[] {
  return eventChannels(emissions, 'map:token-moved');
}

function eventChannels(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((e) => e.event === event)
    .map((e) => e.channelId)
    .sort();
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.trim().startsWith('UPDATE tokens SET')) return { rows: [{ version: 2 }] };
    return { rows: [] };
  });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('token move fan-out scoping (98bd0a6)', () => {
  it('broadcasts a visible token move to every socket on the map (DM + player)', async () => {
    seedRoom([tok('tVis', { visible: true })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tVis', x: 70, y: 70 });

    expect(movedChannels(emissions)).toEqual(['dm-sock', 'player-sock']);
  });

  it('rejects stale token moves and sends the latest token back only to the sender', async () => {
    seedRoom([tok('tVis', { visible: true, version: 3 })]);
    const latest = tok('tVis', { visible: true, x: 5, y: 10, version: 4 });
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('UPDATE tokens SET')) return { rows: [] };
      if (sql.includes('SELECT * FROM tokens WHERE id = $1')) return { rows: [tokenRow(latest)] };
      return { rows: [] };
    });
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tVis', x: 70, y: 70, expectedVersion: 3 });

    expect(eventChannels(emissions, 'map:token-moved')).toEqual([]);
    expect(eventChannels(emissions, 'map:token-conflict')).toEqual(['dm-sock']);
    const conflict = emissions.find((e) => e.event === 'map:token-conflict')?.payload as {
      token?: Token;
    };
    expect(conflict.token?.x).toBe(5);
    expect(conflict.token?.version).toBe(4);
    expect(getAllRooms().get(SESSION)?.tokens.get('tVis')?.x).toBe(5);
  });

  it('hides a hidden token move from player sockets — DM sockets only', async () => {
    seedRoom([tok('tHidden', { visible: false })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tHidden', x: 70, y: 70 });

    const channels = movedChannels(emissions);
    expect(channels).toContain('dm-sock');
    expect(channels).not.toContain('player-sock');
  });

  it('hides an invisible unoutlined token move from non-owner player sockets', async () => {
    seedRoom([tok('tInvisible', { visible: true, conditions: ['invisible'], ownerUserId: 'npc' })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tInvisible', x: 70, y: 70 });

    const channels = movedChannels(emissions);
    expect(channels).toContain('dm-sock');
    expect(channels).not.toContain('player-sock');
  });

  it('keeps an invisible owned token visible to its owning player', async () => {
    seedRoom([
      tok('tInvisibleMine', {
        visible: true,
        conditions: ['invisible'],
        ownerUserId: 'player-user',
      }),
    ]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tInvisibleMine', x: 70, y: 70 });

    expect(movedChannels(emissions)).toEqual(['dm-sock', 'player-sock']);
  });

  it('does not leak a DM-preview-map move to a player on the ribbon map', async () => {
    // DM previews map-2; player stays on the ribbon map-1. A visible
    // token living on map-2 moves — only the DM (who is viewing map-2)
    // should receive it; the player on map-1 must not.
    seedRoom([tok('tPreview', { mapId: 'map-2', visible: true })]);
    const room = getAllRooms().get(SESSION)!;
    room.dmViewingMap.set('dm-user', 'map-2');

    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tPreview', x: 70, y: 70 });

    const channels = movedChannels(emissions);
    expect(channels).toEqual(['dm-sock']);
    expect(channels).not.toContain('player-sock');
  });

  it('includes every live tab of a same-map player (multi-tab fan-out)', async () => {
    seedRoom([tok('tVis', { visible: true })]);
    // Player opens a second tab on the same ribbon map.
    addPlayerToRoom(SESSION, {
      userId: 'player-user',
      displayName: 'Pip',
      socketId: 'player-sock-2',
      role: 'player',
      characterId: null,
    });
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tVis', x: 70, y: 70 });

    expect(movedChannels(emissions)).toEqual(['dm-sock', 'player-sock', 'player-sock-2']);
  });

  it('hides a hidden token add from player sockets — DM sockets only', async () => {
    seedRoom([]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-add']!({
      mapId: 'map-1',
      name: 'Hidden Stalker',
      x: 70,
      y: 70,
      size: 1,
      color: '#000000',
      layer: 'token',
      visible: false,
      hasLight: false,
      lightRadius: 0,
      lightDimRadius: 0,
      lightColor: '#ffffff',
      conditions: [],
    });

    expect(eventChannels(emissions, 'map:token-added')).toEqual(['dm-sock']);
  });

  it('hides an invisible unoutlined token add from non-owner player sockets', async () => {
    seedRoom([]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-add']!({
      mapId: 'map-1',
      name: 'Invisible Stalker',
      x: 70,
      y: 70,
      size: 1,
      color: '#000000',
      layer: 'token',
      visible: true,
      hasLight: false,
      lightRadius: 0,
      lightDimRadius: 0,
      lightColor: '#ffffff',
      conditions: ['invisible'],
      ownerUserId: 'npc',
    });

    expect(eventChannels(emissions, 'map:token-added')).toEqual(['dm-sock']);
  });

  it('keeps hidden token updates DM-only when visibility does not change', async () => {
    seedRoom([tok('tHidden', { visible: false })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-update']!({ tokenId: 'tHidden', changes: { color: '#111111' } });

    expect(eventChannels(emissions, 'map:token-updated')).toEqual(['dm-sock']);
  });

  it('sends demote-to-hidden removals to players so clients drop known tokens', async () => {
    seedRoom([tok('tVis', { visible: true })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-update']!({ tokenId: 'tVis', changes: { visible: false } });

    expect(eventChannels(emissions, 'map:token-updated')).toEqual(['dm-sock']);
    expect(eventChannels(emissions, 'map:token-removed')).toEqual(['player-sock']);
  });

  it('sends turn-invisible removals to non-owner players', async () => {
    seedRoom([tok('tVis', { visible: true, ownerUserId: 'npc' })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-update']!({
      tokenId: 'tVis',
      changes: { conditions: ['invisible'] },
    });

    expect(eventChannels(emissions, 'map:token-updated')).toEqual(['dm-sock']);
    expect(eventChannels(emissions, 'map:token-removed')).toEqual(['player-sock']);
  });

  it('sends full token payloads to players when a hidden token becomes visible', async () => {
    seedRoom([tok('tHidden', { visible: false })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-update']!({ tokenId: 'tHidden', changes: { visible: true } });

    expect(eventChannels(emissions, 'map:token-updated')).toEqual(['dm-sock']);
    expect(eventChannels(emissions, 'map:token-added')).toEqual(['player-sock']);
  });

  it('sends full token payloads to players when invisible is outlined', async () => {
    seedRoom([tok('tInvisible', { visible: true, conditions: ['invisible'], ownerUserId: 'npc' })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-update']!({
      tokenId: 'tInvisible',
      changes: { conditions: ['invisible', 'outlined'] },
    });

    expect(eventChannels(emissions, 'map:token-updated')).toEqual(['dm-sock']);
    expect(eventChannels(emissions, 'map:token-added')).toEqual(['player-sock']);
  });
});

describe('token move ownership rollback (T1.2)', () => {
  it('rolls a non-owner player move back to the sender and does not broadcast', async () => {
    // Token owned by the DM; a player who does not own it tries to move it.
    seedRoom([tok('tNpc', { ownerUserId: 'dm-user', x: 0, y: 0, visible: true })]);
    const { io, socket, handlers, emissions } = makeHarness('player-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tNpc', x: 140, y: 140 });

    // The only token-moved emission is the authoritative rollback to the
    // mover's own socket, carrying the OLD coordinates — not the attempted
    // (140,140). No other socket receives the rejected move.
    const moved = emissions.filter((e) => e.event === 'map:token-moved');
    expect(moved.map((e) => e.channelId)).toEqual(['player-sock']);
    expect(moved[0]!.payload).toMatchObject({ tokenId: 'tNpc', x: 0, y: 0 });
    expect(moved.some((e) => e.channelId === 'dm-sock')).toBe(false);
  });

  it('does not leak hidden token coordinates through non-owner rollback', async () => {
    seedRoom([
      tok('tHiddenNpc', {
        ownerUserId: 'dm-user',
        x: 35,
        y: 35,
        visible: false,
      }),
    ]);
    const { io, socket, handlers, emissions } = makeHarness('player-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tHiddenNpc', x: 140, y: 140 });

    expect(emissions.filter((e) => e.event === 'map:token-moved')).toHaveLength(0);
  });

  it('does not leak invisible non-owner coordinates through rollback', async () => {
    seedRoom([
      tok('tInvisibleNpc', {
        ownerUserId: 'dm-user',
        x: 35,
        y: 35,
        visible: true,
        conditions: ['invisible'],
      }),
    ]);
    const { io, socket, handlers, emissions } = makeHarness('player-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tInvisibleNpc', x: 140, y: 140 });

    expect(emissions.filter((e) => e.event === 'map:token-moved')).toHaveLength(0);
  });

  it('lets the owning player move their own token (broadcast, no rollback)', async () => {
    seedRoom([tok('tMine', { ownerUserId: 'player-user', x: 0, y: 0, visible: true })]);
    const { io, socket, handlers, emissions } = makeHarness('player-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tMine', x: 70, y: 70 });

    // Normal broadcast: the new coordinates fan out to everyone on the map.
    const moved = emissions.filter((e) => e.event === 'map:token-moved');
    expect(moved.map((e) => e.channelId).sort()).toEqual(['dm-sock', 'player-sock']);
    expect(moved[0]!.payload).toMatchObject({ x: 70, y: 70 });
  });
});
