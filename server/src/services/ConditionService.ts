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
 * Adds the condition name to the token's conditions array, persists the
 * updated array to SQLite, and stores the metadata in the room's
 * conditionMeta map. The token update broadcast is the caller's
 * responsibility.
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
    // Persist the updated conditions array to the DB so it survives
    // server restarts, page refreshes, and cross-map navigation.
    try {
      db.prepare('UPDATE tokens SET conditions = ? WHERE id = ?')
        .run(JSON.stringify(token.conditions), tokenId);
    } catch (err) {
      console.warn('[applyConditionWithMeta] DB update failed:', err);
    }
  }

  metaForToken(sessionId, tokenId).set(meta.name.toLowerCase(), meta);
}

/**
 * Remove a condition from a token + clear its metadata. Also persists
 * the updated conditions array to SQLite so the removal survives a
 * server restart.
 */
export function removeCondition(sessionId: string, tokenId: string, conditionName: string): void {
  const room = getRoom(sessionId);
  if (!room) return;
  const token = room.tokens.get(tokenId);
  if (!token) return;
  const lower = conditionName.toLowerCase();
  token.conditions = ((token.conditions as string[]).filter(c => c.toLowerCase() !== lower)) as never;
  // Persist the updated conditions array to the DB.
  try {
    db.prepare('UPDATE tokens SET conditions = ? WHERE id = ?')
      .run(JSON.stringify(token.conditions), tokenId);
  } catch (err) {
    console.warn('[removeCondition] DB update failed:', err);
  }
  const map = room.conditionMeta.get(tokenId);
  if (map) map.delete(lower);
}

/**
 * Tick conditions at the START of a token's turn — checks the
 * `expiresAfterRound` field on every condition and removes any that
 * are now past their duration.
 *
 * The math: a spell cast on round R with duration D should be active
 * for rounds R..R+D-1 inclusive. We compute `expiresAfterRound = R + D - 1`
 * at cast time, so this check fires at the start of round (R + D),
 * which is exactly when the effect should end.
 *
 * Save retries (Hold Person, etc.) live in `tickEndOfTurnConditions`
 * because per RAW the save happens at the END of the affected
 * creature's turn, not the start.
 */
export function tickStartOfTurnConditions(
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
    if (meta.expiresAfterRound != null && currentRound > meta.expiresAfterRound) {
      removed.push(name);
      messages.push(`⏱ ${token.name} — ${meta.source} expires (duration over)`);
      removeCondition(sessionId, tokenId, name);
    }
  }

  return { removed, messages };
}

/**
 * Tick conditions at the END of a token's turn — only handles
 * save-at-end-of-turn re-rolls (Hold Person, Tasha's Hideous Laughter,
 * Dominate Person, etc.). Expiration checks live in the start-of-turn
 * tick so durations match D&D 5e timing.
 */
export function tickEndOfTurnConditions(
  sessionId: string,
  tokenId: string,
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
    if (!meta.saveAtEndOfTurn) continue;
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

  return { removed, messages };
}

/**
 * Backwards-compatible wrapper used by anything still calling the
 * old single-tick function. Runs the END-of-turn save retries only —
 * the start-of-turn expiration tick is now its own function called
 * separately by combatEvents.ts.
 */
export function tickConditionsForToken(
  sessionId: string,
  tokenId: string,
  _currentRound: number,
): { removed: string[]; messages: string[] } {
  return tickEndOfTurnConditions(sessionId, tokenId);
}

/**
 * Process the side effects of a token taking damage:
 *   1. If the target is a concentrating caster, roll a CON save vs
 *      DC max(10, dmg/2). On fail, drop concentration AND clear every
 *      condition the caster was anchoring across the room.
 *   2. Look at the target's own conditions for endsOnDamage flags
 *      (Sleep) — clear those.
 *   3. Look for saveOnDamage flags (Hideous Laughter) — re-roll the
 *      save with advantage; if it succeeds, clear the condition.
 *
 * Returns a structured result that the combat handler uses to emit
 * token updates and chat messages. Pure server logic — no socket
 * emits done here.
 */
export interface DamageSideEffectsResult {
  /** Tokens whose conditions array was modified */
  affectedTokens: string[];
  /** Chat-friendly messages explaining what happened */
  messages: string[];
  /** True if the target dropped concentration on a spell (caller should clear concentratingOn on the character) */
  droppedConcentration?: { spellName: string };
}

export function processDamageSideEffects(
  sessionId: string,
  tokenId: string,
  damageAmount: number,
): DamageSideEffectsResult {
  const room = getRoom(sessionId);
  if (!room) return { affectedTokens: [], messages: [] };
  const token = room.tokens.get(tokenId);
  if (!token) return { affectedTokens: [], messages: [] };

  const result: DamageSideEffectsResult = { affectedTokens: [], messages: [] };

  // 1. Concentration save (only if the target IS a concentrating character)
  if (token.characterId) {
    const charRow = db.prepare(
      'SELECT concentrating_on, ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = ?',
    ).get(token.characterId) as Record<string, unknown> | undefined;
    const concentratingOn = charRow?.concentrating_on as string | null | undefined;
    if (concentratingOn) {
      // DC = max(10, half damage rounded down)
      const dc = Math.max(10, Math.floor(damageAmount / 2));
      // Read CON save mod
      let conMod = 0;
      let isProficient = false;
      try {
        const scores = JSON.parse(charRow!.ability_scores as string);
        conMod = Math.floor(((scores.con ?? 10) - 10) / 2);
        const profSaves = JSON.parse(charRow!.saving_throws as string) as string[];
        isProficient = profSaves.includes('con');
      } catch { /* ignore */ }
      const profBonus = (charRow!.proficiency_bonus as number) || 2;
      const totalMod = conMod + (isProficient ? profBonus : 0);
      const roll = Math.floor(Math.random() * 20) + 1;
      const total = roll + totalMod;
      const success = total >= dc;
      const modStr = totalMod >= 0 ? `+${totalMod}` : `${totalMod}`;
      const tokenName = (charRow!.name as string) || token.name;

      if (success) {
        result.messages.push(
          `🎯 ${tokenName} CON save d20=${roll}${modStr}=${total} vs DC ${dc} → SAVED, concentration on ${concentratingOn} maintained`,
        );
      } else {
        result.messages.push(
          `⚡ ${tokenName} CON save d20=${roll}${modStr}=${total} vs DC ${dc} → FAILED, concentration on ${concentratingOn} dropped!`,
        );
        // Clear concentration on the character row
        db.prepare('UPDATE characters SET concentrating_on = NULL WHERE id = ?').run(token.characterId);
        result.droppedConcentration = { spellName: concentratingOn };
        // Also clear any conditions this caster was anchoring
        const cleared = clearConcentrationConditions(sessionId, tokenId, concentratingOn);
        for (const { tokenId: tid } of cleared) {
          if (!result.affectedTokens.includes(tid)) result.affectedTokens.push(tid);
        }
        if (cleared.length > 0) {
          const total = cleared.reduce((sum, c) => sum + c.removed.length, 0);
          result.messages.push(
            `   ⤷ ${total} condition${total !== 1 ? 's' : ''} cleared from ${cleared.length} target${cleared.length !== 1 ? 's' : ''}`,
          );
        }
      }
    }
  }

  // 2 & 3. endsOnDamage / saveOnDamage on the TARGET's own conditions
  const metaMap = room.conditionMeta.get(tokenId);
  if (metaMap && metaMap.size > 0) {
    for (const [name, meta] of Array.from(metaMap.entries())) {
      // 2. Sleep-style: ends entirely on any damage
      if (meta.endsOnDamage) {
        removeCondition(sessionId, tokenId, name);
        if (!result.affectedTokens.includes(tokenId)) result.affectedTokens.push(tokenId);
        result.messages.push(`💤 ${token.name} — ${meta.source} ends (took damage)`);
        continue;
      }

      // 3. Hideous Laughter-style: re-roll save with advantage on damage
      if (meta.saveAtEndOfTurn && meta.source.toLowerCase().includes('laughter')) {
        // Roll the save with advantage right now
        const { ability, dc } = meta.saveAtEndOfTurn;
        let saveMod = 0;
        if (token.characterId) {
          const row = db.prepare(
            'SELECT ability_scores, saving_throws, proficiency_bonus FROM characters WHERE id = ?',
          ).get(token.characterId) as Record<string, unknown> | undefined;
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
        const kept = Math.max(r1, r2);  // advantage
        const total = kept + saveMod;
        const success = total >= dc;
        const modStr = saveMod >= 0 ? `+${saveMod}` : `${saveMod}`;
        if (success) {
          removeCondition(sessionId, tokenId, name);
          if (!result.affectedTokens.includes(tokenId)) result.affectedTokens.push(tokenId);
          result.messages.push(
            `✓ ${token.name} — ${meta.source}: ${ability.toUpperCase()} save (adv) d20=${kept}${modStr}=${total} vs DC ${dc} → SAVED, effect ends`,
          );
        } else {
          result.messages.push(
            `✗ ${token.name} — ${meta.source}: ${ability.toUpperCase()} save (adv) d20=${kept}${modStr}=${total} vs DC ${dc} → still affected`,
          );
        }
      }
    }
  }

  return result;
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
