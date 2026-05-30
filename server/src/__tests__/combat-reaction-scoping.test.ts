/**
 * Handler-level coverage for combat reaction recipient scoping.
 *
 * `combat:spell-cast-attempt` (the counterspell "cast card") and
 * `combat:attack-hit-attempt` (the Shield prompt trigger) used to
 * broadcast room-wide via `io.to(sessionId)`, leaking a HIDDEN
 * caster/target's action — and the attack roll — to every player at the
 * socket-payload level. They now route through `emitToTokenViewers`,
 * scoped to clients who can see the relevant token (DM always; players
 * only if the token is visible; the token's owner via `includeOwner`).
 *
 * A token-less DM cast has no token position to leak, so it stays
 * room-wide — narrative casts can still be counterspelled exactly as
 * before. The counterspell/shield RESPONSE emits also stay room-wide on
 * purpose: they must reach the original actor to abort/recompute, who
 * may not be able to see the responder's token (see reactionEvents.ts).
 *
 * Tests drive the real handlers through a fake socket, as the DM (which
 * bypasses ownership/actionable gating) so we isolate the visibility
 * routing — the single thing this change touches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

// Stub the DB before importing handlers that transitively pull in the
// combat services (which open a pg pool at module load).
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCombatReactions } from '../socket/combat/reactionEvents.js';
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

const SESSION = 's-reaction-scope';

/** DM (dm-sock) + one player (player-sock) on ribbon map-1. */
function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-RX', 'dm-user');
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

type Handler = (data: unknown) => Promise<void> | void;

/** Register the reaction handlers against a fake socket; return event→handler. */
function handlersFor(io: never, socketId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = { id: socketId, on: (event: string, cb: Handler) => handlers.set(event, cb) };
  registerCombatReactions(io, socket as never);
  return handlers;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('combat:spell-cast-attempt — cast-card scoping', () => {
  it('a HIDDEN caster\'s cast card reaches the DM only — never players', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { visible: false })]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:spell-cast-attempt')!({ castId: 'c1', casterTokenId: 'npc', spellName: 'Fireball', spellLevel: 3 });
    expect(channels(em)).toEqual(['dm-sock']);
  });

  it('a VISIBLE caster\'s cast card reaches the DM and players on the map', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { visible: true })]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:spell-cast-attempt')!({ castId: 'c2', casterTokenId: 'npc', spellName: 'Fireball', spellLevel: 3 });
    expect(channels(em)).toEqual(['dm-sock', 'player-sock']);
  });

  it('a token-less DM cast stays room-wide (no token position to leak)', async () => {
    const em: Emission[] = [];
    seedRoom([]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:spell-cast-attempt')!({ castId: 'c3', spellName: 'Counterspell', spellLevel: 3 });
    expect(channels(em)).toEqual([SESSION]);
  });
});

describe('combat:attack-hit-attempt — Shield-prompt scoping', () => {
  it('a HIDDEN target\'s Shield prompt reaches the DM only', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { visible: false })]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:attack-hit-attempt')!({ attackId: 'a1', targetTokenId: 'npc', attackTotal: 18, currentAC: 15 });
    expect(channels(em)).toEqual(['dm-sock']);
  });

  it('a VISIBLE target\'s Shield prompt reaches the DM and players on the map', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { visible: true })]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:attack-hit-attempt')!({ attackId: 'a2', targetTokenId: 'npc', attackTotal: 18, currentAC: 15 });
    expect(channels(em)).toEqual(['dm-sock', 'player-sock']);
  });

  it('an unknown target token emits nothing (guarded)', async () => {
    const em: Emission[] = [];
    seedRoom([]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:attack-hit-attempt')!({ attackId: 'a3', targetTokenId: 'ghost', attackTotal: 18, currentAC: 15 });
    expect(em).toHaveLength(0);
  });
});
