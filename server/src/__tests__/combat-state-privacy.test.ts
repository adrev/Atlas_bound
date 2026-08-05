import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionEconomy, Combatant, Token } from '@dnd-vtt/shared';
import {
  actionEconomyVisibleTo,
  combatantsVisibleTo,
  emitCombatStateSync,
} from '../utils/combatStateVisibility.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

function token(id: string, ownerUserId: string | null, visible = true): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: `character-${id}`,
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId,
    createdAt: new Date(0).toISOString(),
  };
}

function combatant(tokenId: string, isNPC: boolean): Combatant {
  return {
    tokenId,
    characterId: `character-${tokenId}`,
    name: tokenId,
    initiative: 18,
    initiativeBonus: 4,
    hp: 13,
    maxHp: 20,
    tempHp: 3,
    armorClass: 17,
    speed: 35,
    isNPC,
    conditions: [],
    deathSaves: { successes: 2, failures: 1 },
    deathSaveRolledRound: 3,
    portraitUrl: null,
    exhaustionLevel: 2,
    hasAlert: true,
    surprised: true,
    initiativeBreakdown: {
      d20: 14,
      advantage: 'normal',
      modifiers: [{ label: 'DEX', value: 4, source: 'ability' }],
      total: 18,
    },
  };
}

function seedRoom(): RoomState {
  const room = createRoom('combat-privacy', 'PRIVACY', 'dm-user');
  room.playerMapId = 'map-1';
  addPlayerToRoom(room.sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'player-user',
    displayName: 'Player',
    socketId: 'player-socket',
    role: 'player',
    characterId: 'character-own-pc',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'other-user',
    displayName: 'Other',
    socketId: 'other-socket',
    role: 'player',
    characterId: 'character-other-pc',
  });
  room.tokens.set('npc', token('npc', null));
  room.tokens.set('own-pc', token('own-pc', 'player-user'));
  room.tokens.set('other-pc', token('other-pc', 'other-user'));
  room.tokens.set('hidden-npc', token('hidden-npc', null, false));
  return room;
}

beforeEach(() => getAllRooms().clear());

describe('combatantsVisibleTo', () => {
  it('omits hidden tokens and strips exact unshared NPC and PC stats', () => {
    const room = seedRoom();
    const player = room.players.get('player-user')!;
    const visible = combatantsVisibleTo(
      room,
      [
        combatant('npc', true),
        combatant('own-pc', false),
        combatant('other-pc', false),
        combatant('hidden-npc', true),
      ],
      player
    );

    expect(visible.map((entry) => entry.tokenId)).toEqual(['npc', 'own-pc', 'other-pc']);
    const npc = visible[0];
    expect(npc).toMatchObject({
      initiative: 0,
      initiativeBonus: 0,
      hp: 4,
      maxHp: 4,
      tempHp: 0,
      armorClass: 0,
      speed: 0,
      deathSaves: { successes: 0, failures: 0 },
    });
    expect(npc.initiativeBreakdown).toBeUndefined();
    expect(npc.exhaustionLevel).toBeUndefined();
    expect(npc.hasAlert).toBeUndefined();
    expect(visible[1].hp).toBe(13);
    expect(visible[2].armorClass).toBe(0);
  });

  it('returns full stats to DMs and explicitly shared audiences', () => {
    const room = seedRoom();
    const entries = [combatant('npc', true), combatant('other-pc', false)];

    expect(combatantsVisibleTo(room, entries, room.players.get('dm-user')!)).toBe(entries);

    room.showCreatureStatsToPlayers = true;
    room.showPlayersToPlayers = true;
    const shared = combatantsVisibleTo(room, entries, room.players.get('player-user')!);
    expect(shared[0].armorClass).toBe(17);
    expect(shared[1].initiativeBreakdown?.total).toBe(18);
  });
});

describe('combat state action-economy privacy', () => {
  const economy: ActionEconomy = {
    action: true,
    bonusAction: true,
    movementRemaining: 25,
    movementMax: 35,
    reaction: true,
  };

  it('hides another combatant movement budget but preserves the owner view', () => {
    const room = seedRoom();
    const player = room.players.get('player-user')!;

    expect(actionEconomyVisibleTo(room, combatant('npc', true), economy, player)).toEqual({
      action: false,
      bonusAction: false,
      movementRemaining: 0,
      movementMax: 0,
      reaction: false,
    });
    expect(actionEconomyVisibleTo(room, combatant('own-pc', false), economy, player)).toBe(economy);
  });

  it('emits redacted state to every player tab and full state to the DM', () => {
    const room = seedRoom();
    addPlayerToRoom(room.sessionId, {
      userId: 'player-user',
      displayName: 'Player',
      socketId: 'player-socket-2',
      role: 'player',
      characterId: 'character-own-pc',
    });
    room.combatState = {
      sessionId: room.sessionId,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [combatant('npc', true)],
      startedAt: new Date(0).toISOString(),
    };
    room.actionEconomies.set('npc', economy);
    const emissions: Array<{ socketId: string; payload: Record<string, unknown> }> = [];
    const io = {
      to: (socketId: string) => ({
        emit: (_event: string, payload: Record<string, unknown>) =>
          emissions.push({ socketId, payload }),
      }),
    } as never;

    emitCombatStateSync(io, room);

    const dm = emissions.find((entry) => entry.socketId === 'dm-socket')!;
    const playerTabs = emissions.filter((entry) => entry.socketId.startsWith('player-socket'));
    expect((dm.payload.combatants as Combatant[])[0].hp).toBe(13);
    expect(playerTabs).toHaveLength(2);
    for (const entry of playerTabs) {
      expect((entry.payload.combatants as Combatant[])[0].hp).toBe(4);
      expect((entry.payload.actionEconomy as ActionEconomy).movementMax).toBe(0);
    }
  });
});
