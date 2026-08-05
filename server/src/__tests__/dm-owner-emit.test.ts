/**
 * `dmAndOwnerSocketIds` / `emitToDmAndOwner` — the fixed DM+owner-only
 * fanout policy for full-fidelity character payloads. Every live DM tab
 * and every live tab of the owning player receive the event; bystander
 * players never do, and no sharing toggle widens the audience.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dmAndOwnerSocketIds, emitToDmAndOwner } from '../utils/dmOwnerEmit.js';
import { addPlayerToRoom, createRoom, deleteRoom, getAllRooms } from '../utils/roomState.js';

const SESSION = 's-dm-owner-emit';

function seedRoom() {
  createRoom(SESSION, 'ROOM-DOE', 'dm-user');
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock-2',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-sock',
    role: 'player',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-sock-2',
    role: 'player',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'bystander-user',
    displayName: 'Vex',
    socketId: 'by-sock',
    role: 'player',
    characterId: null,
  });
  return getAllRooms().get(SESSION)!;
}

beforeEach(() => {
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('dmAndOwnerSocketIds', () => {
  it('resolves every DM tab and every owning-player tab, never bystanders', () => {
    const room = seedRoom();
    const recipients = [...dmAndOwnerSocketIds(room, 'owner-user')].sort();
    expect(recipients).toEqual(['dm-sock', 'dm-sock-2', 'owner-sock', 'owner-sock-2']);
  });

  it('resolves DM tabs only when no player owns the character', () => {
    const room = seedRoom();
    const recipients = [...dmAndOwnerSocketIds(room, null)].sort();
    expect(recipients).toEqual(['dm-sock', 'dm-sock-2']);
  });

  it('ignores sharing toggles — bystanders stay excluded even with sharing on', () => {
    const room = seedRoom();
    room.showPlayersToPlayers = true;
    room.showCreatureStatsToPlayers = true;
    const recipients = [...dmAndOwnerSocketIds(room, 'owner-user')].sort();
    expect(recipients).toEqual(['dm-sock', 'dm-sock-2', 'owner-sock', 'owner-sock-2']);
  });

  it('falls back to the registered socketId when no live socket set exists', () => {
    const room = seedRoom();
    room.userSockets.clear();
    const recipients = [...dmAndOwnerSocketIds(room, 'owner-user')].sort();
    expect(recipients).toEqual(['dm-sock-2', 'owner-sock-2']);
  });
});

describe('emitToDmAndOwner', () => {
  it('emits the payload once per recipient socket', () => {
    const room = seedRoom();
    const emissions: Array<{ socketId: string; event: string; payload: unknown }> = [];
    const io = {
      to: (socketId: string) => ({
        emit: (event: string, payload: unknown) => emissions.push({ socketId, event, payload }),
      }),
    } as never;
    emitToDmAndOwner(io, room, 'owner-user', 'character:updated', { characterId: 'c1' });
    expect(emissions.map((e) => e.socketId).sort()).toEqual([
      'dm-sock',
      'dm-sock-2',
      'owner-sock',
      'owner-sock-2',
    ]);
    expect(emissions.every((e) => e.event === 'character:updated')).toBe(true);
  });
});
