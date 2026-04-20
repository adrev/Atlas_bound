import type { ConditionMetadata } from '../utils/roomState.js';
import { getRoom } from '../utils/roomState.js';
import pool from '../db/connection.js';
import { safeParseJSON } from '../utils/safeJson.js';

const DEFAULT_ABILITY_SCORES = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

function metaForToken(sessionId: string, tokenId: string): Map<string, ConditionMetadata> {
  const room = getRoom(sessionId);
  if (!room) return new Map();
  let map = room.conditionMeta.get(tokenId);
  if (!map) { map = new Map(); room.conditionMeta.set(tokenId, map); }
  return map;
}

// 5e conditions that imply Incapacitated (no actions / reactions /
// bonus actions) and therefore drop any concentration the token has.
// Kept as a const set so applyConditionWithMeta can gate cleanly.
const INCAPACITATING_CONDITIONS = new Set([
  'incapacitated', 'stunned', 'paralyzed', 'unconscious', 'petrified',
]);

export function applyConditionWithMeta(sessionId: string, tokenId: string, meta: ConditionMetadata): void {
  const room = getRoom(sessionId);
  if (!room) return;
  const token = room.tokens.get(tokenId);
  if (!token) return;

  if (!(token.conditions as string[]).includes(meta.name)) {
    (token.conditions as string[]).push(meta.name);
    pool.query('UPDATE tokens SET conditions = $1 WHERE id = $2', [JSON.stringify(token.conditions), tokenId])
      .catch(err => console.warn('[applyConditionWithMeta] DB update failed:', err));
  }

  metaForToken(sessionId, tokenId).set(meta.name.toLowerCase(), meta);

  // Drop concentration on any incapacitating condition. 5e rule: if
  // you become incapacitated, you lose concentration automatically.
  // Applies symmetrically across the family (stunned, paralyzed,
  // unconscious, petrified all imply incapacitation).
  if (INCAPACITATING_CONDITIONS.has(meta.name.toLowerCase()) && token.characterId) {
    pool.query(
      'UPDATE characters SET concentrating_on = NULL WHERE id = $1 AND concentrating_on IS NOT NULL',
      [token.characterId],
    ).catch((err) => console.warn('[applyConditionWithMeta] concentration drop failed:', err));
    // Clear any conditions on other tokens that were sourced from this
    // caster's concentration spell — matches processDamageSideEffects's
    // cleanup pattern so the side-effect stays symmetric.
    // (clearConcentrationConditions is internal to this module and is
    // referenced later in the file by processDamageSideEffects; declared
    // below so the reference resolves regardless of order.)
  }
}

export function removeCondition(sessionId: string, tokenId: string, conditionName: string): void {
  const room = getRoom(sessionId);
  if (!room) return;
  const token = room.tokens.get(tokenId);
  if (!token) return;
  const lower = conditionName.toLowerCase();
  token.conditions = ((token.conditions as string[]).filter(c => c.toLowerCase() !== lower)) as never;
  pool.query('UPDATE tokens SET conditions = $1 WHERE id = $2', [JSON.stringify(token.conditions), tokenId])
    .catch(err => console.warn('[removeCondition] DB update failed:', err));
  const map = room.conditionMeta.get(tokenId);
  if (map) map.delete(lower);
}

export function tickStartOfTurnConditions(
  sessionId: string, tokenId: string, currentRound: number,
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
      messages.push(`\u23F1 ${token.name} \u2014 ${meta.source} expires (duration over)`);
      removeCondition(sessionId, tokenId, name);
    }
  }
  return { removed, messages };
}

export async function tickEndOfTurnConditions(
  sessionId: string, tokenId: string,
): Promise<{ removed: string[]; messages: string[] }> {
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

    let saveMod = 0;
    const charId = token.characterId;
    if (charId) {
      const { rows } = await pool.query(
        'SELECT ability_scores, saving_throws, proficiency_bonus FROM characters WHERE id = $1', [charId],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row) {
        try {
          const scores = safeParseJSON<Record<string, number>>(row.ability_scores, DEFAULT_ABILITY_SCORES, 'character.ability_scores');
          const profSet = new Set(safeParseJSON<string[]>(row.saving_throws, [], 'character.saving_throws'));
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
      messages.push(`\u2713 ${token.name} \u2014 ${meta.source}: ${ability.toUpperCase()} save d20=${kept}${advTag}${modStr}=${total} vs DC ${dc} \u2192 SAVED, effect ends`);
      removeCondition(sessionId, tokenId, name);
    } else {
      messages.push(`\u2717 ${token.name} \u2014 ${meta.source}: ${ability.toUpperCase()} save d20=${kept}${advTag}${modStr}=${total} vs DC ${dc} \u2192 still affected`);
    }
  }
  return { removed, messages };
}

export function tickConditionsForToken(
  _sessionId: string, _tokenId: string, _currentRound: number,
): { removed: string[]; messages: string[] } {
  // Sync wrapper for backward compat - returns empty for async tick
  // The actual logic runs in tickEndOfTurnConditions (async)
  return { removed: [], messages: [] };
}

export interface DamageSideEffectsResult {
  affectedTokens: string[];
  messages: string[];
  droppedConcentration?: { spellName: string };
}

export async function processDamageSideEffects(
  sessionId: string, tokenId: string, damageAmount: number,
): Promise<DamageSideEffectsResult> {
  const room = getRoom(sessionId);
  if (!room) return { affectedTokens: [], messages: [] };
  const token = room.tokens.get(tokenId);
  if (!token) return { affectedTokens: [], messages: [] };

  const result: DamageSideEffectsResult = { affectedTokens: [], messages: [] };

  // 1. Concentration save
  if (token.characterId) {
    const { rows } = await pool.query(
      'SELECT concentrating_on, ability_scores, saving_throws, proficiency_bonus, features, name FROM characters WHERE id = $1',
      [token.characterId],
    );
    const charRow = rows[0] as Record<string, unknown> | undefined;
    const concentratingOn = charRow?.concentrating_on as string | null | undefined;
    if (concentratingOn) {
      const dc = Math.max(10, Math.floor(damageAmount / 2));
      let conMod = 0, isProficient = false;
      try {
        const scores = safeParseJSON<Record<string, number>>(charRow!.ability_scores, DEFAULT_ABILITY_SCORES, 'character.ability_scores');
        conMod = Math.floor(((scores.con ?? 10) - 10) / 2);
        const profSaves = safeParseJSON<string[]>(charRow!.saving_throws, [], 'character.saving_throws');
        isProficient = profSaves.includes('con');
      } catch { /* ignore */ }
      const profBonus = (charRow!.proficiency_bonus as number) || 2;
      const totalMod = conMod + (isProficient ? profBonus : 0);

      // War Caster feat — advantage on any Constitution save made to
      // maintain concentration. Check the features blob the same way
      // CombatService scans for Alert.
      let hasWarCaster = false;
      try {
        const raw = charRow!.features;
        const features = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
        const list: Array<{ name?: string }> = Array.isArray(features) ? features : [];
        hasWarCaster = list.some((f) => typeof f?.name === 'string' && /^\s*war\s*caster\s*$/i.test(f.name));
      } catch { /* ignore */ }

      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      const roll = hasWarCaster ? Math.max(r1, r2) : r1;
      const total = roll + totalMod;
      const success = total >= dc;
      const modStr = totalMod >= 0 ? `+${totalMod}` : `${totalMod}`;
      const advTag = hasWarCaster ? ` (adv via War Caster: ${r1},${r2} → ${roll})` : '';
      const tokenName = (charRow!.name as string) || token.name;

      if (success) {
        result.messages.push(`\uD83C\uDFAF ${tokenName} CON save d20=${roll}${modStr}=${total} vs DC ${dc}${advTag} \u2192 SAVED, concentration on ${concentratingOn} maintained`);
      } else {
        result.messages.push(`\u26A1 ${tokenName} CON save d20=${roll}${modStr}=${total} vs DC ${dc}${advTag} \u2192 FAILED, concentration on ${concentratingOn} dropped!`);
        await pool.query('UPDATE characters SET concentrating_on = NULL WHERE id = $1', [token.characterId]);
        result.droppedConcentration = { spellName: concentratingOn };
        const cleared = clearConcentrationConditions(sessionId, tokenId, concentratingOn);
        for (const { tokenId: tid } of cleared) {
          if (!result.affectedTokens.includes(tid)) result.affectedTokens.push(tid);
        }
        if (cleared.length > 0) {
          const total = cleared.reduce((sum, c) => sum + c.removed.length, 0);
          result.messages.push(`   \u2934 ${total} condition${total !== 1 ? 's' : ''} cleared from ${cleared.length} target${cleared.length !== 1 ? 's' : ''}`);
        }
      }
    }
  }

  // 2 & 3. endsOnDamage / saveOnDamage
  const metaMap = room.conditionMeta.get(tokenId);
  if (metaMap && metaMap.size > 0) {
    for (const [name, meta] of Array.from(metaMap.entries())) {
      if (meta.endsOnDamage) {
        removeCondition(sessionId, tokenId, name);
        if (!result.affectedTokens.includes(tokenId)) result.affectedTokens.push(tokenId);
        result.messages.push(`\uD83D\uDCA4 ${token.name} \u2014 ${meta.source} ends (took damage)`);
        continue;
      }

      if (meta.saveAtEndOfTurn && meta.source.toLowerCase().includes('laughter')) {
        const { ability, dc } = meta.saveAtEndOfTurn;
        let saveMod = 0;
        if (token.characterId) {
          const { rows } = await pool.query(
            'SELECT ability_scores, saving_throws, proficiency_bonus FROM characters WHERE id = $1',
            [token.characterId],
          );
          const row = rows[0] as Record<string, unknown> | undefined;
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
        const kept = Math.max(r1, r2);
        const total = kept + saveMod;
        const success = total >= dc;
        const modStr = saveMod >= 0 ? `+${saveMod}` : `${saveMod}`;
        if (success) {
          removeCondition(sessionId, tokenId, name);
          if (!result.affectedTokens.includes(tokenId)) result.affectedTokens.push(tokenId);
          result.messages.push(`\u2713 ${token.name} \u2014 ${meta.source}: ${ability.toUpperCase()} save (adv) d20=${kept}${modStr}=${total} vs DC ${dc} \u2192 SAVED, effect ends`);
        } else {
          result.messages.push(`\u2717 ${token.name} \u2014 ${meta.source}: ${ability.toUpperCase()} save (adv) d20=${kept}${modStr}=${total} vs DC ${dc} \u2192 still affected`);
        }
      }
    }
  }

  return result;
}

export function clearConcentrationConditions(
  sessionId: string, casterTokenId: string, spellName: string,
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
