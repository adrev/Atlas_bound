import type { Token } from '@dnd-vtt/shared';
import type { RoomState } from './roomState.js';

/**
 * Serialize a token's active condition → source-token-id map for
 * transport to the client. The full `ConditionMetadata` struct
 * (source name, appliedRound, saveAtEndOfTurn, etc.) stays
 * server-side; the client only needs `casterTokenId` to enforce
 * rules like "Charmed can't attack the charmer" and
 * "Frightened can't willingly move closer to the source of fear."
 *
 * Returns undefined when the token has no metadata or no entries
 * carry a source id, so we don't bloat every token payload with
 * empty `{}` objects.
 */
export function serializeConditionSources(
  room: RoomState, tokenId: string,
): Record<string, string | null> | undefined {
  const metaMap = room.conditionMeta.get(tokenId);
  if (!metaMap || metaMap.size === 0) return undefined;
  const out: Record<string, string | null> = {};
  for (const [condName, meta] of metaMap.entries()) {
    if (meta.casterTokenId) {
      out[condName] = meta.casterTokenId;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Decorate a Token with its current conditionSources. Mutates in
 * place and returns the same object so it can chain into array
 * broadcasts: `tokens.map(rowToToken).map((t) => withConditionSources(room, t))`.
 */
export function withConditionSources(room: RoomState, token: Token): Token {
  const sources = serializeConditionSources(room, token.id);
  if (sources) token.conditionSources = sources;
  return token;
}

/**
 * Build the `changes` patch for a `map:token-updated` broadcast that
 * always ships the latest conditions + conditionSources alongside any
 * extra fields the caller wants to merge. Use this after every
 * applyConditionWithMeta / removeCondition call so client-side rule
 * guards (charmed can't attack the charmer, frightened can't advance
 * toward the fear source) stay in sync without a full `map:load`.
 *
 * Sources are always included — an empty `{}` when no tracked sources
 * remain, so stale entries clear on the client (Zustand's updateToken
 * is a shallow merge; omitting the field would keep the old value).
 */
export function tokenConditionChanges(
  room: RoomState, tokenId: string, extras: Partial<Token> = {},
): Partial<Token> {
  const token = room.tokens.get(tokenId);
  const sources = serializeConditionSources(room, tokenId) ?? {};
  return {
    ...extras,
    ...(token ? { conditions: token.conditions } : {}),
    conditionSources: sources,
  };
}
