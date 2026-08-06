import type { Server } from 'socket.io';
import type { RoomState } from '../utils/roomState.js';
import { getAllRooms } from '../utils/roomState.js';
import {
  fullCharacterRecipientSocketIds,
  npcCharacterRecipientSocketIds,
} from '../utils/characterVisibility.js';
import { emitCombatStateSync } from '../utils/combatStateVisibility.js';
import { readWildShapeColumn } from '../utils/wildShapeState.js';
import { persistSessionCombatState } from './CombatService.js';

const LIVE_COMBAT_FIELDS = new Set([
  'hitPoints',
  'maxHitPoints',
  'tempHitPoints',
  'deathSaves',
  'armorClass',
  'speed',
  'exhaustionLevel',
]);

export function emitCharacterUpdate(
  io: Server,
  room: RoomState,
  characterId: string,
  characterOwnerUserId: string,
  changes: Record<string, unknown>
): void {
  const payload = { characterId, changes };

  // NPC sheets follow creature sharing plus token visibility; knowing a
  // hidden/prep-map character id must not reveal its sheet.
  if (characterOwnerUserId === 'npc') {
    for (const socketId of npcCharacterRecipientSocketIds(
      room,
      characterId,
      room.showCreatureStatsToPlayers
    )) {
      io.to(socketId).emit('character:updated', payload);
    }
    return;
  }

  // PC sheets may contain private notes and inventory, so use the existing
  // owner/DM/party-sharing recipient policy rather than a room broadcast.
  for (const socketId of fullCharacterRecipientSocketIds(
    room,
    characterOwnerUserId,
    room.showPlayersToPlayers
  )) {
    io.to(socketId).emit('character:updated', payload);
  }
}

export function roomReferencesCharacter(room: RoomState, characterId: string): boolean {
  if (Array.from(room.players.values()).some((player) => player.characterId === characterId)) {
    return true;
  }
  if (Array.from(room.tokens.values()).some((token) => token.characterId === characterId)) {
    return true;
  }
  return !!room.combatState?.combatants.some((combatant) => combatant.characterId === characterId);
}

/**
 * Keep active combat memory aligned with a committed character-sheet edit.
 * Combat-state fanout remains privacy-redacted per recipient.
 */
export function syncCharacterUpdateToCombat(
  io: Server,
  room: RoomState,
  characterId: string,
  changes: Record<string, unknown>,
  wildShapeRaw?: unknown
): boolean {
  if (!room.combatState?.active) return false;
  if (!Object.keys(changes).some((field) => LIVE_COMBAT_FIELDS.has(field))) return false;
  // Invalid non-null form state also fails closed: do not replace current
  // beast-form AC/speed until the malformed state has been cleared.
  const transformed = readWildShapeColumn(wildShapeRaw).status !== 'none';
  let changed = false;

  for (const combatant of room.combatState.combatants) {
    if (combatant.characterId !== characterId) continue;
    const assignNumber = (value: unknown, current: number, assign: (next: number) => void) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === current) return;
      assign(value);
      changed = true;
    };
    assignNumber(changes.hitPoints, combatant.hp, (value) => {
      combatant.hp = value;
    });
    assignNumber(changes.maxHitPoints, combatant.maxHp, (value) => {
      combatant.maxHp = value;
    });
    assignNumber(changes.tempHitPoints, combatant.tempHp, (value) => {
      combatant.tempHp = value;
    });
    assignNumber(changes.exhaustionLevel, combatant.exhaustionLevel ?? 0, (value) => {
      combatant.exhaustionLevel = value;
    });
    if (!transformed) {
      assignNumber(changes.armorClass, combatant.armorClass, (value) => {
        combatant.armorClass = value;
      });
      assignNumber(changes.speed, combatant.speed, (value) => {
        combatant.speed = value;
      });
    }
    if (changes.deathSaves && typeof changes.deathSaves === 'object') {
      const next = changes.deathSaves as { successes?: unknown; failures?: unknown };
      if (
        typeof next.successes === 'number' &&
        typeof next.failures === 'number' &&
        (combatant.deathSaves.successes !== next.successes ||
          combatant.deathSaves.failures !== next.failures)
      ) {
        combatant.deathSaves = { successes: next.successes, failures: next.failures };
        changed = true;
      }
    }
  }

  if (!changed) return false;
  persistSessionCombatState(room.sessionId);
  emitCombatStateSync(io, room);
  return true;
}

/** REST fallback has no originating socket/room, so update every live room
 * that currently references the committed character. */
export function fanoutCharacterUpdateAcrossRooms(
  io: Server,
  characterId: string,
  characterOwnerUserId: string,
  changes: Record<string, unknown>,
  wildShapeRaw?: unknown,
  sourceRoom?: RoomState
): void {
  const rooms = new Set<RoomState>();
  if (sourceRoom) rooms.add(sourceRoom);
  for (const room of getAllRooms().values()) {
    if (roomReferencesCharacter(room, characterId)) rooms.add(room);
  }
  for (const room of rooms) {
    syncCharacterUpdateToCombat(io, room, characterId, changes, wildShapeRaw);
    emitCharacterUpdate(io, room, characterId, characterOwnerUserId, changes);
  }
}
