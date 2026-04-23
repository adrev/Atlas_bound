import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import pool from '../db/connection.js';
import { getPlayerBySocketId, playerIsDM } from '../utils/roomState.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';
import { safeHandler } from '../utils/socketHelpers.js';

const characterUpdateSchema = z.object({
  characterId: z.string().min(1),
  changes: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ])),
});

const characterSyncRequestSchema = z.object({
  characterId: z.string().min(1),
});

const FIELD_TO_COLUMN: Record<string, { col: string; json: boolean }> = {
  name: { col: 'name', json: false },
  race: { col: 'race', json: false },
  class: { col: 'class', json: false },
  level: { col: 'level', json: false },
  hitPoints: { col: 'hit_points', json: false },
  maxHitPoints: { col: 'max_hit_points', json: false },
  tempHitPoints: { col: 'temp_hit_points', json: false },
  armorClass: { col: 'armor_class', json: false },
  speed: { col: 'speed', json: false },
  abilityScores: { col: 'ability_scores', json: true },
  savingThrows: { col: 'saving_throws', json: true },
  skills: { col: 'skills', json: true },
  spellSlots: { col: 'spell_slots', json: true },
  spells: { col: 'spells', json: true },
  features: { col: 'features', json: true },
  inventory: { col: 'inventory', json: true },
  deathSaves: { col: 'death_saves', json: true },
  portraitUrl: { col: 'portrait_url', json: false },
  conditions: { col: 'conditions', json: true },
  spellcastingAbility: { col: 'spellcasting_ability', json: false },
  spellAttackBonus: { col: 'spell_attack_bonus', json: false },
  spellSaveDC: { col: 'spell_save_dc', json: false },
  initiative: { col: 'initiative', json: false },
  currency: { col: 'currency', json: true },
  background: { col: 'background', json: true },
  characteristics: { col: 'characteristics', json: true },
  personality: { col: 'personality', json: true },
  notes: { col: 'notes_data', json: true },
  proficiencies: { col: 'proficiencies_data', json: true },
  senses: { col: 'senses', json: true },
  defenses: { col: 'defenses', json: true },
  extras: { col: 'extras', json: true },
  hitDice: { col: 'hit_dice', json: true },
  concentratingOn: { col: 'concentrating_on', json: false },
  exhaustionLevel: { col: 'exhaustion_level', json: false },
};

export function registerCharacterEvents(io: Server, socket: Socket): void {

  socket.on('character:update', safeHandler(socket, async (data) => {
    const parsed = characterUpdateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { characterId, changes } = parsed.data;

    const { rows: existingRows } = await pool.query('SELECT id, user_id FROM characters WHERE id = $1', [characterId]);
    if (existingRows.length === 0) return;
    const existing = existingRows[0];

    const charUserId = existing.user_id as string;
    const isDM = playerIsDM(ctx);

    if (charUserId === 'npc') {
      // NPCs are DM-writable for anything. Players can ONLY write HP
      // fields (hitPoints / tempHp) on NPCs that live on a map in THIS
      // session — so a player who resolves an attack client-side can
      // persist the damage to the shared NPC record (prior behaviour:
      // the server rejected silently, so the creature bounced back to
      // full HP on any reload). Any other NPC field change from a non-
      // DM is still dropped. The NPC-in-session check stops a cross-
      // session guess-UUID attack.
      const { rows: sessionTokenRows } = await pool.query(
        `SELECT 1 FROM tokens t
           JOIN maps m ON m.id = t.map_id
          WHERE t.character_id = $1 AND m.session_id = $2
          LIMIT 1`,
        [characterId, ctx.room.sessionId],
      );
      if (sessionTokenRows.length === 0) return;

      if (!isDM) {
        const allowedNpcFields = new Set(['hitPoints', 'tempHp', 'tempHitPoints']);
        const requestedFields = Object.keys(changes);
        const hasDisallowed = requestedFields.some((f) => !allowedNpcFields.has(f));
        if (hasDisallowed) return;
      }
    } else {
      // PCs: either owner-writes-their-own, OR a DM of THIS session
      // writing a PC that's actually linked to this session (via
      // session_players.character_id) or has a token on one of this
      // session's maps. Raw "DM in any session" is not enough — that
      // would let a DM in session A mutate a PC whose only link is
      // to session B.
      if (charUserId === ctx.player.userId) {
        // owner — allow
      } else if (isDM) {
        const { rows: linkRows } = await pool.query(
          `SELECT 1 FROM session_players
            WHERE session_id = $1 AND character_id = $2
            LIMIT 1`,
          [ctx.room.sessionId, characterId],
        );
        if (linkRows.length === 0) {
          // Fall back: is there a token for this character on a map
          // in this session?
          const { rows: tokRows } = await pool.query(
            `SELECT 1 FROM tokens t
               JOIN maps m ON m.id = t.map_id
              WHERE t.character_id = $1 AND m.session_id = $2
              LIMIT 1`,
            [characterId, ctx.room.sessionId],
          );
          if (tokRows.length === 0) return;
        }
      } else {
        return;
      }
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(changes)) {
      const mapping = FIELD_TO_COLUMN[key];
      if (!mapping) continue;
      setClauses.push(`${mapping.col} = $${paramIdx++}`);
      params.push(mapping.json ? JSON.stringify(value) : value);
    }

    if (setClauses.length > 0) {
      setClauses.push(`updated_at = NOW()::text`);
      params.push(characterId);
      await pool.query(`UPDATE characters SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, params);
    }

    socket.to(ctx.room.sessionId).emit('character:updated', { characterId, changes });
  }));

  socket.on('character:sync-request', safeHandler(socket, async (data) => {
    const parsed = characterSyncRequestSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { characterId } = parsed.data;

    // Verify character belongs to a player in this session
    const { rows: linkCheck } = await pool.query(
      'SELECT 1 FROM session_players WHERE session_id = $1 AND character_id = $2',
      [ctx.room.sessionId, characterId],
    );
    if (linkCheck.length === 0) return;

    const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
    if (rows.length === 0) return;

    // Broadcast to the whole session room (requester included) so the
    // DM and every other connected player refresh their copy of this
    // character. Previously only the requester got the synced data,
    // which left the DM viewing stale stats after a player re-imported
    // from D&D Beyond.
    io.to(ctx.room.sessionId).emit('character:synced', { character: dbRowToCharacter(rows[0]) });
  }));
}
