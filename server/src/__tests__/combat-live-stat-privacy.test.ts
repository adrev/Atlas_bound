/**
 * Live combat-stat payload privacy.
 *
 * Exact numbers (precise HP/temp HP, character-sheet HP/death-saves/
 * version, death-save counters, action economy, movement) used to fan out
 * through `emitToTokenViewers`, which scopes by token VISIBILITY only —
 * so any player who could see an NPC's token received its exact HP at the
 * socket layer even though `/state` and `combat:state-sync` redact it.
 *
 * `emitToTokenStatViewers` is the new chokepoint for those payloads:
 *   - every DM tab always receives them;
 *   - every tab of the token's owner always receives them;
 *   - other players receive them only when the token is visible to them
 *     AND the matching share toggle permits (`showCreatureStatsToPlayers`
 *     for creatures, `showPlayersToPlayers` for PCs);
 *   - an unresolvable token fails closed to DM-only.
 *
 * Condition/token-visual events keep the plain visibility path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { emitToTokenStatViewers, tokenStatsSharedWithPlayers } from '../utils/combatBroadcast.js';
import { registerCombatHp } from '../socket/combat/hpEvents.js';
import { registerChatCommand, tryHandleChatCommand } from '../services/ChatCommands.js';
import * as DiceService from '../services/DiceService.js';
import * as DiscordService from '../services/DiscordService.js';
import {
  addPlayerToRoom, createRoom, getAllRooms, getPlayerBySocketId, type RoomState,
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

function combatant(tokenId: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: null,
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 8,
    maxHp: 12,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

const SESSION = 's-live-stat-privacy';

/** DM (two tabs), token owner (two tabs), and a bystander player — all on map-1. */
function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-LSP', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'combat';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock-2', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'owner-user', displayName: 'Owner', socketId: 'owner-sock', role: 'player', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'owner-user', displayName: 'Owner', socketId: 'owner-sock-2', role: 'player', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'bystander-user', displayName: 'Vex', socketId: 'by-sock', role: 'player', characterId: null });
  return getAllRooms().get(SESSION)!;
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

const DM_TABS = ['dm-sock', 'dm-sock-2'];
const OWNER_TABS = ['owner-sock', 'owner-sock-2'];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('emitToTokenStatViewers — exact-stat scoping', () => {
  it('withholds a visible NPC exact HP payload from all players while sharing is off', () => {
    const room = seedRoom([tok('npc')]);
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'npc', 'combat:hp-changed', { tokenId: 'npc', hp: 3 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);
  });

  it('sends a visible NPC exact HP payload to map players when showCreatureStatsToPlayers is on', () => {
    const room = seedRoom([tok('npc')]);
    room.showCreatureStatsToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'npc', 'combat:hp-changed', { tokenId: 'npc', hp: 3 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('does not let showPlayersToPlayers unlock NPC stats (toggle independence)', () => {
    const room = seedRoom([tok('npc')]);
    room.showPlayersToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'npc', 'combat:hp-changed', { tokenId: 'npc', hp: 3 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);
  });

  it('always reaches every DM tab and every owner tab for a PC, but not bystanders, while sharing is off', () => {
    const room = seedRoom([tok('pc', { ownerUserId: 'owner-user' })]);
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'pc', 'character:updated', { characterId: 'c', changes: { hitPoints: 5, version: 7 } });
    expect(channelsFor(em, 'character:updated')).toEqual([...DM_TABS, ...OWNER_TABS]);
  });

  it('sends visible PC stats to bystanders when showPlayersToPlayers is on', () => {
    const room = seedRoom([tok('pc', { ownerUserId: 'owner-user' })]);
    room.showPlayersToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'pc', 'combat:hp-changed', { tokenId: 'pc', hp: 5 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('does not let showCreatureStatsToPlayers unlock PC stats', () => {
    const room = seedRoom([tok('pc', { ownerUserId: 'owner-user' })]);
    room.showCreatureStatsToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'pc', 'combat:hp-changed', { tokenId: 'pc', hp: 5 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([...DM_TABS, ...OWNER_TABS]);
  });

  it('keeps a HIDDEN PC private to DM + owner even with showPlayersToPlayers on (visibility still gates)', () => {
    const room = seedRoom([tok('pc', { ownerUserId: 'owner-user', visible: false })]);
    room.showPlayersToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'pc', 'combat:death-save-updated', { tokenId: 'pc', deathSaves: { successes: 1, failures: 2 }, roll: 4 });
    expect(channelsFor(em, 'combat:death-save-updated')).toEqual([...DM_TABS, ...OWNER_TABS]);
  });

  it('fails closed to DM-only when the token cannot be resolved', () => {
    const room = seedRoom([]);
    room.showCreatureStatsToPlayers = true;
    room.showPlayersToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'ghost', 'combat:hp-changed', { tokenId: 'ghost', hp: 0 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);
  });

  it('prefers the live combatant isNPC flag over token ownership for the toggle choice', () => {
    // An owner-assigned token whose character row is an NPC sidekick:
    // combat marked it isNPC, so bystanders need the CREATURE toggle.
    const room = seedRoom([tok('sidekick', { ownerUserId: 'owner-user' })]);
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [combatant('sidekick', { isNPC: true })],
      startedAt: new Date().toISOString(),
    } as CombatState;
    room.showPlayersToPlayers = true; // wrong toggle for an NPC combatant
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'sidekick', 'combat:hp-changed', { tokenId: 'sidekick', hp: 2 });
    // Owner keeps their own sidekick's numbers; the bystander needs
    // showCreatureStatsToPlayers, which is off.
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([...DM_TABS, ...OWNER_TABS]);

    room.showCreatureStatsToPlayers = true;
    em.length = 0;
    emitToTokenStatViewers(fakeIo(em), room, 'sidekick', 'combat:hp-changed', { tokenId: 'sidekick', hp: 2 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('classifies a legacy ownerUserId="npc" token as a creature outside combat', () => {
    // Older rows stored the NPC pseudo-user instead of null. The PC
    // toggle must NOT unlock its stats for bystanders.
    const room = seedRoom([tok('legacy-npc', { ownerUserId: 'npc' })]);
    room.showPlayersToPlayers = true;
    const em: Emission[] = [];
    emitToTokenStatViewers(fakeIo(em), room, 'legacy-npc', 'combat:hp-changed', { tokenId: 'legacy-npc', hp: 6 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);

    room.showCreatureStatsToPlayers = true;
    em.length = 0;
    emitToTokenStatViewers(fakeIo(em), room, 'legacy-npc', 'combat:hp-changed', { tokenId: 'legacy-npc', hp: 6 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('tokenStatsSharedWithPlayers falls back to ownerless-token = creature outside combat', () => {
    const room = seedRoom([tok('npc'), tok('pc', { ownerUserId: 'owner-user' })]);
    expect(tokenStatsSharedWithPlayers(room, room.tokens.get('npc')!)).toBe(false);
    expect(tokenStatsSharedWithPlayers(room, room.tokens.get('pc')!)).toBe(false);
    room.showCreatureStatsToPlayers = true;
    expect(tokenStatsSharedWithPlayers(room, room.tokens.get('npc')!)).toBe(true);
    expect(tokenStatsSharedWithPlayers(room, room.tokens.get('pc')!)).toBe(false);
    room.showPlayersToPlayers = true;
    expect(tokenStatsSharedWithPlayers(room, room.tokens.get('pc')!)).toBe(true);
  });
});

describe('combat HP handlers — exact stats gated, condition visuals not', () => {
  function seedCombat(t: Token, c: Combatant): RoomState {
    const room = seedRoom([t]);
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [c],
      startedAt: new Date().toISOString(),
    } as CombatState;
    return room;
  }

  it('combat:heal on a visible NPC keeps exact HP DM-only until creature stats are shared', async () => {
    const room = seedCombat(tok('npc'), combatant('npc', { hp: 4 }));
    const em: Emission[] = [];
    const handlers = new Map<string, (data: unknown) => Promise<void>>();
    const socket = {
      id: 'dm-sock',
      on: (ev: string, cb: (data: unknown) => Promise<void>) => handlers.set(ev, cb),
      emit: () => true,
    } as never;
    registerCombatHp(fakeIo(em), socket);

    await handlers.get('combat:heal')!({ tokenId: 'npc', amount: 3 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);

    room.showCreatureStatsToPlayers = true;
    em.length = 0;
    await handlers.get('combat:heal')!({ tokenId: 'npc', amount: 3 });
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('a visible NPC death-save counter stays DM-only while sharing is off, but its condition change still broadcasts', async () => {
    vi.spyOn(DiscordService, 'notifySession').mockResolvedValue(undefined);
    vi.spyOn(DiceService, 'rollDeathSave').mockReturnValue({
      roll: 12, isSuccess: true, isCritSuccess: false, isCritFail: false,
    });
    const room = seedCombat(
      tok('npc', { characterId: 'char-npc' }),
      combatant('npc', {
        characterId: 'char-npc',
        hp: 0,
        deathSaves: { successes: 2, failures: 0 },
      }),
    );
    const em: Emission[] = [];
    const handlers = new Map<string, (data: unknown) => Promise<void>>();
    const socket = {
      id: 'dm-sock',
      on: (ev: string, cb: (data: unknown) => Promise<void>) => handlers.set(ev, cb),
      emit: () => true,
    } as never;
    registerCombatHp(fakeIo(em), socket);

    await handlers.get('combat:death-save')!({ tokenId: 'npc' });

    // Third success → stabilized. The exact counters are private…
    expect(channelsFor(em, 'combat:death-save-updated')).toEqual(DM_TABS);
    expect(channelsFor(em, 'character:updated')).toEqual(DM_TABS);
    // …but the resulting `stable` condition badge keeps token visibility.
    expect(channelsFor(em, 'map:token-updated')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
    void room;
  });
});

describe('chat-command legacy emits — stat events gated, token visuals not', () => {
  it('routes legacy hp/sheet emits through the stat gate while map:token-updated keeps plain visibility', async () => {
    const room = seedRoom([tok('npc')]);
    registerChatCommand('stat-privacy-probe', (c) => {
      c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', { tokenId: 'npc', hp: 1 });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', { tokenId: 'npc', changes: { conditions: ['prone'] } });
      return true;
    });
    const em: Emission[] = [];
    const ctx = getPlayerBySocketId('dm-sock')!;

    await tryHandleChatCommand(fakeIo(em), ctx, '!stat-privacy-probe');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);
    expect(channelsFor(em, 'map:token-updated')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);

    room.showCreatureStatsToPlayers = true;
    em.length = 0;
    await tryHandleChatCommand(fakeIo(em), ctx, '!stat-privacy-probe');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('routes a TOKENLESS character:updated to every DM tab and every owner tab, not bystanders', async () => {
    const room = seedRoom([]);
    room.players.get('owner-user')!.characterId = 'char-1';
    registerChatCommand('tokenless-sheet-probe', (c) => {
      c.io.to(c.ctx.room.sessionId).emit('character:updated', { characterId: 'char-1', changes: { hitPoints: 9, version: 3 } });
      return true;
    });
    const em: Emission[] = [];
    const ctx = getPlayerBySocketId('dm-sock')!;

    await tryHandleChatCommand(fakeIo(em), ctx, '!tokenless-sheet-probe');
    expect(channelsFor(em, 'character:updated')).toEqual([...DM_TABS, ...OWNER_TABS]);

    room.showPlayersToPlayers = true;
    em.length = 0;
    await tryHandleChatCommand(fakeIo(em), ctx, '!tokenless-sheet-probe');
    expect(channelsFor(em, 'character:updated')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('fails a tokenless character:updated closed to DM-only when no player links the character', async () => {
    const room = seedRoom([]);
    room.showPlayersToPlayers = true; // must not matter without an owner
    registerChatCommand('orphan-sheet-probe', (c) => {
      c.io.to(c.ctx.room.sessionId).emit('character:updated', { characterId: 'no-such-char', changes: { hitPoints: 1 } });
      return true;
    });
    const em: Emission[] = [];
    const ctx = getPlayerBySocketId('dm-sock')!;

    await tryHandleChatCommand(fakeIo(em), ctx, '!orphan-sheet-probe');
    expect(channelsFor(em, 'character:updated')).toEqual(DM_TABS);
  });
});
