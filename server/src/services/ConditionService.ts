import type { ConditionMetadata } from '../utils/roomState.js';
import { getRoom } from '../utils/roomState.js';
import db from '../db/connection.js';

/**
 * Get the metadata map for a token's conditions, creating it if missing.
 */
function metaForToken(sessionId: string, tokenId: string): Map<string, ConditionMetadata> {
  const room = getRoom(sessionId);
  if (!room) return new Map();
  let map = room.conditionMeta.get(tokenId);
  if (!map) {
    map = new Map();
    room.conditionMeta.set(tokenId, map);
  }
  return map;
}

/**
 * Apply a condition to a token with optional duration / save-retry metadata.
 * Adds the condition name to the token's conditions array and stores the
 * metadata in the room's conditionMeta map. The token update broadcast is
 * the caller's responsibility.
 */
export function applyConditionWithMeta(
  sessionId: string,
  tokenId: string,
  meta: ConditionMetadata,
): void {
  const room = getRoom(sessionId);
  if (!room) return;
  const token = room.tokens.get(tokenId);
  if (!token) return;

  if (!(token.conditions as string[]).includes(meta.name)) {
    (token.conditions as string[]).push(meta.name);
  }

  metaForToken(sessionId, tokenId).set(meta.name.toLowerCase(), meta);
}

/**
 * Remove a condition from a token + clear its metadata.
 */
export function removeCondition(sessionId: string, tokenId: string, conditionName: string): void {
  const room = getRoom(sessionId);
  if (!room) return;
  const token = room.tokens.get(tokenId);
  if (!token) return;
  const lower = conditionName.toLowerCase();
  token.conditions = ((token.conditions as string[]).filter(c => c.toLowerCase() !== lower)) as never;
  const map = room.conditionMeta.get(tokenId);
  if (map) map.delete(lower);
}

/**
 * Tick all conditions on a token at the END of its turn:
 *   • Auto-expire conditions whose expiresAfterRound has passed
 *   • Roll save-at-end-of-turn for spells like Hold Person
 *
 * Returns a list of removed condition names plus chat-friendly messages
 * so the combat handler can broadcast them.
 */
export function tickConditionsForToken(
  sessionId: string,
  tokenId: string,
  currentRound: number,
): { removed: string[]; messages: string[] } {
  const room = getRoom(sessionId);
  if (!room) return { removed: [], messages: [] };
  const token = room.tokens.get(tokenId);
  if (!token) return { removed: [], messages: [] };
  const metaMap = room.conditionMeta.get(tokenId);
  if (!metaMap || metaMap.size === 0) return { removed: [], messages: [] };

  const removed: string[] = [];
  const messages: string[] = [];

  for (const [name, meta] of Array.from(metaMap.entries())) {
    // 1. Auto-expiration (e.g. Bless after 10 rounds)
    if (meta.expiresAfterRound != null && currentRound > meta.expiresAfterRound) {
      removed.push(name);
      messages.push(`⏱ ${token.name} — ${meta.source} expires (duration over)`);
      removeCondition(sessionId, tokenId, name);
      continue;
    }

    // 2. Save-at-end-of-turn (Hold Person, Hideous Laughter, etc.)
    if (meta.saveAtEndOfTurn) {
      const { ability, dc, advantage } = meta.saveAtEndOfTurn;

      // Read save modifier from the target's character record
      let saveMod = 0;
      const charId = token.characterId;
      if (charId) {
        const row = db.prepare(
          'SELECT ability_scores, saving_throws, proficiency_bonus FROM characters WHERE id = ?',
        ).get(charId) as Record<string, unknown> | undefined;
        if (row) {
          try {
            const scores = JSON.parse(row.ability_scores as string);
            const profSet = new Set(JSON.parse(row.saving_throws as string) as string[]);
            saveMod = Math.floor((scores[ability] - 10) / 2);
            if (profSet.has(ability)) saveMod += (row.proficiency_bonus as number) || 2;
          } catch { /* ignore */ }
        }
      }

      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      const kept = advantage ? Math.max(r1, r2) : r1;
      const total = kept + saveMod;
      const success = total >= dc;
      const advTag = advantage ? ' (adv)' : '';
      const modStr = saveMod >= 0 ? `+${saveMod}` : `${saveMod}`;

      if (success) {
        removed.push(name);
        messages.push(`✓ ${token.name} — ${meta.source}: ${ability.toUpperCase()} save d20=${kept}${advTag}${modStr}=${total} vs DC ${dc} → SAVED, effect ends`);
        removeCondition(sessionId, tokenId, name);
      } else {
        messages.push(`✗ ${token.name} — ${meta.source}: ${ability.toUpperCase()} save d20=${kept}${advTag}${modStr}=${total} vs DC ${dc} → still affected`);
      }
    }
  }

  return { removed, messages };
}

/**
 * Clean up every condition in the room that was anchored to a specific
 * caster's concentration spell. Called when the caster drops concentration
 * (intentionally OR via a CON save on damage).
 *
 * Returns a per-token list of removed condition names so the combat
 * handler can broadcast token updates and announce in chat.
 */
export function clearConcentrationConditions(
  sessionId: string,
  casterTokenId: string,
  spellName: string,
): { tokenId: string; removed: string[] }[] {
  const room = getRoom(sessionId);
  if (!room) return [];
  const results: { tokenId: string; removed: string[] }[] = [];
  for (const [tokenId, metaMap] of room.conditionMeta.entries()) {
    const removed: string[] = [];
    for (const [name, meta] of Array.from(metaMap.entries())) {
      if (meta.casterTokenId === casterTokenId && meta.source === spellName) {
        removed.push(name);
        removeCondition(sessionId, tokenId, name);
      }
    }
    if (removed.length > 0) results.push({ tokenId, removed });
  }
  return results;
}
