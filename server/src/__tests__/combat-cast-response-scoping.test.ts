/**
 * Handler-level coverage for the combat spell-cast VFX broadcast and the
 * counterspell / Shield RESPONSE relays — the pieces of the reaction flow
 * that `combat-reaction-scoping.test.ts` does NOT touch (that file pins the
 * counterspell/Shield *prompt* scoping; this one pins the cast VFX and the
 * response relays).
 *
 * Two distinct recipient policies live here, and both are intentional:
 *
 *  • `combat:spell-cast` (the cast VFX / animation) broadcasts room-wide.
 *    The on-map effect — a projectile, a fireball, an aura — is something
 *    every client is meant to see, so it is NOT token-visibility scoped the
 *    way the counterspell prompt is. These are CHARACTERIZATION tests: they
 *    lock in the current room-wide behavior plus the caster-ownership gate.
 *    (Open question for whether a HIDDEN caster's `casterId` should leak in
 *    that payload is flagged on the PR, not asserted here.)
 *
 *  • `combat:spell-counterspelled` / `combat:shield-cast` (the responses)
 *    broadcast room-wide ON PURPOSE: they must reach the original
 *    caster/attacker — who may not be able to see the responder's token — so
 *    that client can abort/recompute. What we DO pin here is the anti-spoof
 *    ownership gate: a player may only emit a response from a token they own,
 *    so a bystander can't forge a counterspell/Shield against any action by
 *    replaying the broadcast id.
 *
 * Drives the real handlers through a fake socket, as the relevant actor (DM
 * or the owning/non-owning player), so we isolate the recipient routing and
 * ownership gating — the only things under test.
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

const SESSION = 's-cast-response-scope';

/** DM (dm-sock) + one player (player-sock) on ribbon map-1. */
function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-CR', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'combat';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock', role: 'player', characterId: null });
  return getAllRooms().get(SESSION)!;
}

/** Channel ids that received a specific event, sorted for stable compare. */
function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

/** A schema-valid `combat:cast-spell` payload for the given caster token. */
function castPayload(casterId: string) {
  return {
    casterId,
    spellName: 'Fireball',
    targetIds: [],
    targetPosition: null,
    animationType: 'aoe' as const,
    animationColor: '#ff6600',
  };
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

describe('combat:spell-cast — cast VFX broadcast & ownership', () => {
  it('a DM cast broadcasts the spell VFX room-wide (every client sees the effect)', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { ownerUserId: null })]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:cast-spell')!(castPayload('npc'));
    expect(channelsFor(em, 'combat:spell-cast')).toEqual([SESSION]);
  });

  it('a player casting a token they OWN broadcasts the VFX room-wide', async () => {
    const em: Emission[] = [];
    seedRoom([tok('pc', { ownerUserId: 'player-user' })]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:cast-spell')!(castPayload('pc'));
    expect(channelsFor(em, 'combat:spell-cast')).toEqual([SESSION]);
  });

  it('a player casting a token they do NOT own emits nothing (ownership gate)', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { ownerUserId: 'dm-user' })]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:cast-spell')!(castPayload('npc'));
    expect(em).toHaveLength(0);
  });
});

describe('combat:spell-counterspelled — response broadcast & anti-spoof', () => {
  it('a DM counterspell response broadcasts room-wide (reaches the original caster)', async () => {
    const em: Emission[] = [];
    seedRoom([]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:spell-counterspelled')!({ castId: 'cast-1' });
    expect(channelsFor(em, 'combat:spell-counterspelled')).toEqual([SESSION]);
  });

  it('a player counterspelling from a token they OWN broadcasts room-wide', async () => {
    const em: Emission[] = [];
    seedRoom([tok('pc', { ownerUserId: 'player-user' })]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:spell-counterspelled')!({ castId: 'cast-1', counterCasterTokenId: 'pc' });
    expect(channelsFor(em, 'combat:spell-counterspelled')).toEqual([SESSION]);
  });

  it('a player cannot forge a counterspell from a token they do NOT own (anti-spoof)', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { ownerUserId: 'dm-user' })]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:spell-counterspelled')!({ castId: 'cast-1', counterCasterTokenId: 'npc' });
    expect(em).toHaveLength(0);
  });

  it('a player counterspell with no token id is dropped (anti-spoof)', async () => {
    const em: Emission[] = [];
    seedRoom([]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:spell-counterspelled')!({ castId: 'cast-1' });
    expect(em).toHaveLength(0);
  });
});

describe('combat:shield-cast — response broadcast & anti-spoof', () => {
  it('a DM Shield response broadcasts room-wide (reaches the original attacker)', async () => {
    const em: Emission[] = [];
    seedRoom([]);
    const h = handlersFor(fakeIo(em), 'dm-sock');
    await h.get('combat:shield-cast')!({ attackId: 'atk-1' });
    expect(channelsFor(em, 'combat:shield-cast')).toEqual([SESSION]);
  });

  it('a player Shielding from a token they OWN broadcasts room-wide', async () => {
    const em: Emission[] = [];
    seedRoom([tok('pc', { ownerUserId: 'player-user' })]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:shield-cast')!({ attackId: 'atk-1', defenderTokenId: 'pc' });
    expect(channelsFor(em, 'combat:shield-cast')).toEqual([SESSION]);
  });

  it('a player cannot forge a Shield from a token they do NOT own (anti-spoof)', async () => {
    const em: Emission[] = [];
    seedRoom([tok('npc', { ownerUserId: 'dm-user' })]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:shield-cast')!({ attackId: 'atk-1', defenderTokenId: 'npc' });
    expect(em).toHaveLength(0);
  });

  it('a player Shield with no token id is dropped (anti-spoof)', async () => {
    const em: Emission[] = [];
    seedRoom([]);
    const h = handlersFor(fakeIo(em), 'player-sock');
    await h.get('combat:shield-cast')!({ attackId: 'atk-1' });
    expect(em).toHaveLength(0);
  });
});
