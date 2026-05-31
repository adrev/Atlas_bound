import type { Character } from '@dnd-vtt/shared';
import { emitCharacterRest } from '../socket/emitters';

/**
 * Shared rest request helpers extracted from CharacterSheetFull so the
 * QuickActions bottom bar and sheet buttons use the same server-owned
 * rest path. The server applies the 5e updates, broadcasts
 * character:updated, and sends character:rested for the local toast.
 */

/**
 * Request a full Long Rest on the given character. The server owns the
 * actual HP, slots, feature, Hit Dice, death save, concentration, and
 * exhaustion mutations.
 */
export function performLongRest(character: Character): void {
  emitCharacterRest(character.id, 'long');
}

/**
 * Request a Short Rest. Hit Dice spending remains a manual, dice-by-
 * dice decision in the character sheet dialog; this request only
 * restores short-rest features and Warlock pact slots on the server.
 */
export function performShortRest(character: Character): void {
  emitCharacterRest(character.id, 'short');
}
