/**
 * Integration coverage for the map-scoped + hidden-token fan-out that
 * `tokenEvents.ts` applies to `map:token-move` (and the identical filter
 * on `map:token-add`). Pins the behavior CodeX shipped in 98bd0a6:
 *
 *   - a token move is broadcast only to sockets rendering the token's map
 *     (DM-preview moves must not leak to players on the ribbon map);
 *   - a HIDDEN token's move reaches DM sockets only, never player sockets,
 *     even when the player is on the same map.
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

interface Emission { channelId: string; event: string; payload: unknown }

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
    on: (event: string, handler: (d: unknown) => Promise<void> | void) => { handlers[event] = handler; },
    emit: (event: string, payload: unknown) => emissions.push({ channelId: actorSocketId, event, payload }),
    join: () => {},
    to: record,
  } as never;
  return { io, socket, handlers, emissions };
}

function tok(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id, mapId: 'map-1', characterId: null, name: id,
    x: 0, y: 0, size: 1, imageUrl: null, color: '#000',
    layer: 'token', visible: true, hasLight: false,
    lightRadius: 0, lightDimRadius: 0, lightColor: '#fff',
    conditions: [], ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
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
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock', role: 'player', characterId: null });
}

function movedChannels(emissions: Emission[]): string[] {
  return emissions
    .filter((e) => e.event === 'map:token-moved')
    .map((e) => e.channelId)
    .sort();
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
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

  it('hides a hidden token move from player sockets — DM sockets only', async () => {
    seedRoom([tok('tHidden', { visible: false })]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tHidden', x: 70, y: 70 });

    const channels = movedChannels(emissions);
    expect(channels).toContain('dm-sock');
    expect(channels).not.toContain('player-sock');
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
    addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock-2', role: 'player', characterId: null });
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'tVis', x: 70, y: 70 });

    expect(movedChannels(emissions)).toEqual(['dm-sock', 'player-sock', 'player-sock-2']);
  });
});
