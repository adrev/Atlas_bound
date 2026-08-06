import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import pool from '../db/connection.js';
import { getPlayerBySocketId, playerIsDM } from '../utils/roomState.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { tokenVisibleToPlayer } from '../utils/tokenVisibility.js';
import {
  canReceiveFullCharacter,
  fullCharacterRecipientSocketIds,
} from '../utils/characterVisibility.js';
import { broadcastSystem } from '../services/ChatCommands.js';
import {
  computeAdjustSpellSlot,
  computeRest,
  computeSpendHitDie,
  persistRestUpdates,
  syncRestToCombatants,
} from '../services/RestService.js';
import {
  emitCharacterUpdate,
  fanoutCharacterUpdateAcrossRooms,
} from '../services/CharacterUpdateService.js';
import { preserveServerManagedFeatureResources } from '../utils/featureResourceAuthority.js';

const characterUpdateSchema = z.object({
  characterId: z.string().min(1),
  expectedVersion: z.number().int().min(1).optional(),
  changes: z.record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ])
  ),
});

const characterSyncRequestSchema = z.object({
  characterId: z.string().min(1),
});

const characterRestSchema = z.object({
  characterId: z.string().min(1),
  kind: z.enum(['short', 'long']),
});

const spendHitDieSchema = z.object({
  characterId: z.string().min(1),
  dieSize: z
    .number()
    .int()
    .refine((value) => [6, 8, 10, 12].includes(value)),
});

const spellSlotAdjustSchema = z.object({
  characterId: z.string().min(1),
  level: z.number().int().min(1).max(9),
  delta: z.union([z.literal(1), z.literal(-1)]),
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

async function characterIsInSession(characterId: string, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1
       FROM session_players
      WHERE session_id = $1 AND character_id = $2
      LIMIT 1`,
    [sessionId, characterId]
  );
  if (rows.length > 0) return true;

  const tokenCheck = await pool.query(
    `SELECT 1
       FROM tokens t
       JOIN maps m ON m.id = t.map_id
      WHERE t.character_id = $1 AND m.session_id = $2
      LIMIT 1`,
    [characterId, sessionId]
  );
  return tokenCheck.rows.length > 0;
}

async function emitCharacterConflict(
  io: Server,
  socketId: string,
  characterId: string
): Promise<void> {
  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  if (!rows[0]) return;
  io.to(socketId).emit('character:update-conflict', {
    character: dbRowToCharacter(rows[0] as Record<string, unknown>),
  });
}

export function registerCharacterEvents(io: Server, socket: Socket): void {
  socket.on(
    'character:update',
    safeHandler(socket, async (data) => {
      const parsed = characterUpdateSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      const { characterId, changes } = parsed.data;
      const { expectedVersion } = parsed.data;

      const { rows: existingRows } = await pool.query(
        'SELECT id, user_id, version, wild_shape FROM characters WHERE id = $1',
        [characterId]
      );
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
          [characterId, ctx.room.sessionId]
        );
        if (sessionTokenRows.length === 0) return;

        if (!isDM) {
          const allowedNpcFields = new Set(['hitPoints', 'tempHp', 'tempHitPoints']);
          const requestedFields = Object.keys(changes);
          const hasDisallowed = requestedFields.some((f) => !allowedNpcFields.has(f));
          if (hasDisallowed) return;

          // Free-roam attacks still resolve through this legacy absolute-HP
          // update, but a player may only target an NPC they can currently
          // see on the player ribbon. Knowing a character id must not permit
          // edits to hidden creatures or tokens on a DM prep map.
          const visibleTarget = Array.from(ctx.room.tokens.values()).some(
            (token) =>
              token.characterId === characterId &&
              token.mapId === ctx.room.playerMapId &&
              tokenVisibleToPlayer(token, ctx.player.userId)
          );
          if (!visibleTarget) return;
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
            [ctx.room.sessionId, characterId]
          );
          if (linkRows.length === 0) {
            // Fall back: is there a token for this character on a map
            // in this session?
            const { rows: tokRows } = await pool.query(
              `SELECT 1 FROM tokens t
               JOIN maps m ON m.id = t.map_id
              WHERE t.character_id = $1 AND m.session_id = $2
              LIMIT 1`,
              [characterId, ctx.room.sessionId]
            );
            if (tokRows.length === 0) return;
          }
        } else {
          return;
        }
      }

      // Old/stale clients may omit the field because it used to be
      // optional on the wire. Never turn that into an unconditional
      // overwrite: return the authoritative row so the caller can retry.
      if (expectedVersion === undefined) {
        await emitCharacterConflict(io, socket.id, characterId);
        return;
      }

      const acceptedChanges = { ...changes };
      if (changes.features !== undefined) {
        const { rows: featureRows } = await pool.query(
          'SELECT features FROM characters WHERE id = $1',
          [characterId]
        );
        const protectedFeatures = preserveServerManagedFeatureResources(
          featureRows[0]?.features,
          changes.features
        );
        if (!protectedFeatures) {
          await emitCharacterConflict(io, socket.id, characterId);
          return;
        }
        acceptedChanges.features = protectedFeatures;
      }

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      for (const [key, value] of Object.entries(acceptedChanges)) {
        const mapping = FIELD_TO_COLUMN[key];
        if (!mapping) continue;
        setClauses.push(`${mapping.col} = $${paramIdx++}`);
        params.push(mapping.json ? JSON.stringify(value) : value);
      }

      if (setClauses.length === 0) return;

      setClauses.push(`updated_at = NOW()::text`);
      params.push(characterId, expectedVersion);
      const updateSql = `UPDATE characters SET ${setClauses.join(', ')} WHERE id = $${paramIdx} AND version = $${paramIdx + 1} RETURNING version`;
      const { rows: updatedRows } = await pool.query(updateSql, params);
      if (updatedRows.length === 0) {
        await emitCharacterConflict(io, socket.id, characterId);
        return;
      }
      acceptedChanges.version = Number(updatedRows[0].version);

      fanoutCharacterUpdateAcrossRooms(
        io,
        characterId,
        charUserId,
        acceptedChanges,
        existing.wild_shape,
        ctx.room
      );
    })
  );

  socket.on(
    'character:rest',
    safeHandler(socket, async (data) => {
      const parsed = characterRestSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      const { characterId, kind } = parsed.data;
      const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
      if (rows.length === 0) return;

      const row = rows[0] as Record<string, unknown>;
      const charUserId = String(row.user_id ?? '');
      const isDM = playerIsDM(ctx);
      const inSession = await characterIsInSession(characterId, ctx.room.sessionId);
      if (!inSession) return;
      if (!isDM && charUserId !== ctx.player.userId) return;
      if (!isDM && charUserId === 'npc') return;

      const result = computeRest(row, kind);
      let version: number | undefined;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        version = await persistRestUpdates(client, result.characterId, result.updates);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const hasUpdates = Object.keys(result.updates).length > 0;
      if (hasUpdates) {
        syncRestToCombatants(ctx.room, result.characterId, result.updates);
        // Carry the post-write characters.version so sheet stores stay in
        // step and the owner's next optimistic edit doesn't send a stale
        // expectedVersion (false character:update-conflict).
        const fanoutChanges: Record<string, unknown> =
          version !== undefined ? { ...result.updates, version } : result.updates;
        emitCharacterUpdate(io, ctx.room, result.characterId, charUserId, fanoutChanges);
      }

      socket.emit('character:rested', {
        characterId: result.characterId,
        kind,
        changes: result.changes,
        updates: result.updates,
      });
      if (hasUpdates) {
        broadcastSystem(
          io,
          ctx,
          `🛌 ${result.name} finishes a ${kind === 'long' ? 'Long' : 'Short'} Rest\n   ${result.changes.join(' • ')}`
        );
      }
    })
  );

  socket.on(
    'character:spend-hit-die',
    safeHandler(socket, async (data) => {
      const parsed = spendHitDieSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      const { characterId, dieSize } = parsed.data;
      let result: ReturnType<typeof computeSpendHitDie> | null = null;
      let characterOwnerUserId: string | null = null;
      let version: number | undefined;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT * FROM characters WHERE id = $1 FOR UPDATE', [
          characterId,
        ]);
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          const charUserId = String(row.user_id ?? '');
          const isDM = playerIsDM(ctx);
          const inSession = await characterIsInSession(characterId, ctx.room.sessionId);
          if (
            inSession &&
            (isDM || charUserId === ctx.player.userId) &&
            (isDM || charUserId !== 'npc')
          ) {
            characterOwnerUserId = charUserId;
            result = computeSpendHitDie(row, dieSize);
            version = await persistRestUpdates(client, result.characterId, result.updates);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (!result || !characterOwnerUserId) return;

      const hasUpdates = Object.keys(result.updates).length > 0;
      if (hasUpdates) {
        syncRestToCombatants(ctx.room, result.characterId, result.updates);
        // Same stale-expectedVersion guard as the character:rest fanout.
        const fanoutChanges: Record<string, unknown> =
          version !== undefined ? { ...result.updates, version } : result.updates;
        emitCharacterUpdate(io, ctx.room, result.characterId, characterOwnerUserId, fanoutChanges);
      }

      socket.emit('character:hit-die-spent', result);
      if (hasUpdates) {
        broadcastSystem(
          io,
          ctx,
          `💤 ${result.name} spends 1d${dieSize} Hit Die\n   ${result.changes.join(' • ')}`
        );
      }
    })
  );

  socket.on(
    'character:spell-slot-adjust',
    safeHandler(socket, async (data) => {
      const parsed = spellSlotAdjustSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      const { characterId, level, delta } = parsed.data;
      let result: ReturnType<typeof computeAdjustSpellSlot> | null = null;
      let characterOwnerUserId: string | null = null;
      let version: number | undefined;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT * FROM characters WHERE id = $1 FOR UPDATE', [
          characterId,
        ]);
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          const charUserId = String(row.user_id ?? '');
          const isDM = playerIsDM(ctx);
          const inSession = await characterIsInSession(characterId, ctx.room.sessionId);
          if (
            inSession &&
            (isDM || charUserId === ctx.player.userId) &&
            (isDM || charUserId !== 'npc')
          ) {
            characterOwnerUserId = charUserId;
            result = computeAdjustSpellSlot(row, level, delta);
            version = await persistRestUpdates(client, result.characterId, result.updates);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (!result || !characterOwnerUserId) return;

      const hasUpdates = Object.keys(result.updates).length > 0;
      if (hasUpdates) {
        // Same stale-expectedVersion guard as the character:rest fanout.
        const fanoutChanges: Record<string, unknown> =
          version !== undefined ? { ...result.updates, version } : result.updates;
        emitCharacterUpdate(io, ctx.room, result.characterId, characterOwnerUserId, fanoutChanges);
      }

      socket.emit('character:spell-slot-adjusted', result);
    })
  );

  socket.on(
    'character:sync-request',
    safeHandler(socket, async (data) => {
      const parsed = characterSyncRequestSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      const { characterId } = parsed.data;

      // Verify the character is linked to this session and load the
      // session's explicit party-sheet sharing policy.
      const { rows: linkCheck } = await pool.query(
        `SELECT sp.user_id AS owner_user_id, s.settings
           FROM session_players sp
           JOIN sessions s ON s.id = sp.session_id
          WHERE sp.session_id = $1 AND sp.character_id = $2
          LIMIT 1`,
        [ctx.room.sessionId, characterId]
      );
      if (linkCheck.length === 0) return;

      const characterOwnerUserId = String(linkCheck[0].owner_user_id);
      const settings = safeParseJSON<Record<string, unknown>>(
        linkCheck[0].settings,
        {},
        'sessions.settings'
      );
      const showPlayersToPlayers = settings.showPlayersToPlayers === true;
      if (
        !canReceiveFullCharacter({
          recipientUserId: ctx.player.userId,
          recipientRole: ctx.player.role,
          characterOwnerUserId,
          showPlayersToPlayers,
        })
      ) {
        return;
      }

      const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
      if (rows.length === 0) return;

      const payload = { character: dbRowToCharacter(rows[0]) };
      for (const socketId of fullCharacterRecipientSocketIds(
        ctx.room,
        characterOwnerUserId,
        showPlayersToPlayers
      )) {
        io.to(socketId).emit('character:synced', payload);
      }
    })
  );
}
