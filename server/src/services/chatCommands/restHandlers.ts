import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import { broadcastEvent } from '../../utils/eventBroadcast.js';
import { computeRest, type RestKind } from '../RestService.js';
import type { PoolClient } from 'pg';

const REST_FIELD_TO_COLUMN: Record<string, { column: string; json: boolean }> = {
  hitPoints: { column: 'hit_points', json: false },
  tempHitPoints: { column: 'temp_hit_points', json: false },
  spellSlots: { column: 'spell_slots', json: true },
  features: { column: 'features', json: true },
  hitDice: { column: 'hit_dice', json: true },
  deathSaves: { column: 'death_saves', json: true },
  concentratingOn: { column: 'concentrating_on', json: false },
  exhaustionLevel: { column: 'exhaustion_level', json: false },
};

async function persistRestUpdates(
  client: PoolClient,
  characterId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    const field = REST_FIELD_TO_COLUMN[key];
    if (!field) continue;
    setClauses.push(`${field.column} = $${idx++}`);
    params.push(field.json ? JSON.stringify(value) : value);
  }

  if (setClauses.length === 0) return;
  setClauses.push('updated_at = NOW()::text');
  params.push(characterId);
  await client.query(`UPDATE characters SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
}

function syncCombatantRest(c: ChatCommandContext, characterId: string, updates: Record<string, unknown>): void {
  const combatants = c.ctx.room.combatState?.combatants ?? [];
  for (const combatant of combatants) {
    if (combatant.characterId !== characterId) continue;
    if (typeof updates.hitPoints === 'number') combatant.hp = updates.hitPoints;
    if (typeof updates.tempHitPoints === 'number') combatant.tempHp = updates.tempHitPoints;
    if (updates.deathSaves && typeof updates.deathSaves === 'object') {
      combatant.deathSaves = updates.deathSaves as { successes: number; failures: number };
    }
    if (typeof updates.exhaustionLevel === 'number') {
      combatant.exhaustionLevel = updates.exhaustionLevel;
    }
  }
}

/**
 * !rest <short|long> [target]
 *   DM triggers a server-owned rest for every linked PC in the
 *   session, or for a single named token. This intentionally writes
 *   the character rows directly so offline players and secondary tabs
 *   do not drift from a client-only rest trigger.
 */

async function handleRest(c: ChatCommandContext): Promise<boolean> {
  if (c.ctx.player.role !== 'dm') {
    whisperToCaller(c.io, c.ctx, '!rest: DM only. Players can use the Rest button in the bottom bar.');
    return true;
  }
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!rest: usage `!rest <short|long> [target]`');
    return true;
  }
  const kindRaw = parts.shift()!.toLowerCase();
  const kind: RestKind = kindRaw === 'short' || kindRaw === 's' ? 'short' : 'long';
  const targetName = parts.join(' ').trim();

  let rows: Record<string, unknown>[] = [];
  if (targetName) {
    const matches = Array.from(c.ctx.room.tokens.values()).filter(
      (t) => t.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (matches.length === 0) {
      whisperToCaller(c.io, c.ctx, `!rest: no token named "${targetName}" on this map.`);
      return true;
    }
    matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const target = matches[0];
    if (!target.characterId) {
      whisperToCaller(c.io, c.ctx, `!rest: "${target.name}" is not linked to a character.`);
      return true;
    }
    const result = await pool.query('SELECT * FROM characters WHERE id = $1', [target.characterId]);
    rows = result.rows as Record<string, unknown>[];
  } else {
    const result = await pool.query(
      `SELECT c.*
         FROM characters c
         JOIN session_players sp ON sp.character_id = c.id
        WHERE sp.session_id = $1
          AND c.user_id <> 'npc'
        ORDER BY c.name ASC`,
      [c.ctx.room.sessionId],
    );
    rows = result.rows as Record<string, unknown>[];
  }

  if (rows.length === 0) {
    whisperToCaller(c.io, c.ctx, targetName
      ? `!rest: no character row found for "${targetName}".`
      : '!rest: no linked player characters found in this session.');
    return true;
  }

  const results = rows.map((row) => computeRest(row, kind));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const result of results) {
      await persistRestUpdates(client, result.characterId, result.updates);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  for (const result of results) {
    if (Object.keys(result.updates).length === 0) continue;
    syncCombatantRest(c, result.characterId, result.updates);
    broadcastEvent(c.io, c.ctx.room, 'character:updated', {
      characterId: result.characterId,
      changes: result.updates,
    });
  }

  const details = results
    .map((result) => `   ${result.name}: ${result.changes.join(' • ')}`)
    .join('\n');

  broadcastSystem(
    c.io, c.ctx,
    `🛌 ${c.ctx.player.displayName} completes a ${kind === 'long' ? 'Long' : 'Short'} Rest${targetName ? ` (${targetName} only)` : ' — whole party'}.\n${details}`,
  );
  return true;
}

registerChatCommand('rest', handleRest);
