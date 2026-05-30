/**
 * Regression coverage for the hidden-combatant HP/condition leak fix.
 *
 * The combat HP handlers used to broadcast `combat:hp-changed`,
 * `map:token-updated` (conditions), `combat:death-save-updated`, and
 * `character:updated` to the WHOLE room — leaking a hidden NPC's HP /
 * conditions / existence to players at the socket-payload level. They now
 * route through `emitToTokenViewers`, which scopes by token visibility
 * (DM always; players only if they can see the token) with an
 * `includeOwner` escape hatch so a player's own PC sheet still syncs.
 *
 * Tests the helper directly with a fake `io` (no CombatService/db mocking),
 * since it's the single chokepoint every combat HP emit now goes through.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import { emitToTokenViewers } from '../utils/combatBroadcast.js';
import {
  createRoom, getAllRooms, addPlayerToRoom, type RoomState,
} from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
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

const SESSION = 's-hp-scope';

/** DM + a player on ribbon map-1; extra players added per-test. */
function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-HP', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'combat';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock', role: 'player', characterId: null });
  return getAllRooms().get(SESSION)!;
}

function channels(emissions: Emission[]): string[] {
  return emissions.map((e) => e.channelId).sort();
}

beforeEach(() => {
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('emitToTokenViewers — combat HP/condition scoping', () => {
  it('a HIDDEN NPC HP change reaches DM sockets only — never players', () => {
    const room = seedRoom([tok('npc', { visible: false, ownerUserId: 'npc' })]);
    const em: Emission[] = [];
    emitToTokenViewers(fakeIo(em), room, 'npc', 'combat:hp-changed', { tokenId: 'npc', hp: 3 });
    expect(channels(em)).toEqual(['dm-sock']);
  });

  it('a VISIBLE NPC HP change reaches DM and players on the map', () => {
    const room = seedRoom([tok('npc', { visible: true })]);
    const em: Emission[] = [];
    emitToTokenViewers(fakeIo(em), room, 'npc', 'combat:hp-changed', { tokenId: 'npc', hp: 3 });
    expect(channels(em)).toEqual(['dm-sock', 'player-sock']);
  });

  it('owned-PC sheet sync (includeOwner) reaches the owner even when the token is hidden, but not other players', () => {
    const room = seedRoom([tok('pc', { visible: false, ownerUserId: 'player-user' })]);
    // A second, non-owning player who must NOT learn the hidden token's HP.
    addPlayerToRoom(SESSION, { userId: 'other-user', displayName: 'Vex', socketId: 'other-sock', role: 'player', characterId: null });
    const em: Emission[] = [];
    emitToTokenViewers(
      fakeIo(em), room, 'pc', 'character:updated',
      { characterId: 'char-pip', changes: { hitPoints: 5 } },
      { includeOwner: true },
    );
    const ch = channels(em);
    expect(ch).toContain('dm-sock');        // DM always
    expect(ch).toContain('player-sock');    // owner, via includeOwner (hidden would otherwise exclude)
    expect(ch).not.toContain('other-sock'); // non-owner can't see the hidden token
  });

  it('includes every live tab of the owner (multi-tab)', () => {
    const room = seedRoom([tok('pc', { visible: false, ownerUserId: 'player-user' })]);
    addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock-2', role: 'player', characterId: null });
    const em: Emission[] = [];
    emitToTokenViewers(fakeIo(em), room, 'pc', 'character:updated', { characterId: 'c', changes: {} }, { includeOwner: true });
    const ch = channels(em);
    expect(ch).toContain('player-sock');
    expect(ch).toContain('player-sock-2');
  });

  it('hides a HIDDEN token condition change from players too (conditionEvents path)', () => {
    const room = seedRoom([tok('npc', { visible: false, ownerUserId: 'npc' })]);
    const em: Emission[] = [];
    emitToTokenViewers(fakeIo(em), room, 'npc', 'combat:condition-changed', { tokenId: 'npc', conditions: ['poisoned'] });
    expect(channels(em)).toEqual(['dm-sock']);
  });

  it('falls back to DM-only when the token is unknown (never leaks)', () => {
    const room = seedRoom([]);
    const em: Emission[] = [];
    emitToTokenViewers(fakeIo(em), room, 'ghost', 'combat:hp-changed', { tokenId: 'ghost', hp: 0 });
    expect(channels(em)).toEqual(['dm-sock']);
  });
});
