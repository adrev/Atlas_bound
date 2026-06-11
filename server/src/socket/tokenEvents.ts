import type { Server, Socket } from 'socket.io';
import type { Token } from '@dnd-vtt/shared';
import { gridDistance, snapToGrid } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import {
  checkRateLimit,
  getPlayerBySocketId,
  isTokenActionable,
  resolveViewingMapId,
  socketRecipientsOnMap,
  socketsOnMap,
  socketsForToken,
} from '../utils/roomState.js';
import { broadcastEventToSockets } from '../utils/eventBroadcast.js';
import * as OpportunityAttackService from '../services/OpportunityAttackService.js';
import * as CombatService from '../services/CombatService.js';
import {
  tokenMoveSchema,
  tokenAddSchema,
  tokenRemoveSchema,
  tokenUpdateSchema,
} from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { rowToToken } from '../utils/tokenMapper.js';
import { tokenVisibleToPlayer } from '../utils/tokenVisibility.js';
import { emitToTokenViewers } from '../utils/combatBroadcast.js';
import { tokenConditionChanges } from '../utils/conditionSources.js';
import { emitCombatStateSync } from '../utils/combatStateVisibility.js';

function rejectTokenMove(
  io: Server,
  socketId: string,
  sessionId: string,
  userId: string,
  token: Token,
  reason?: string
): void {
  io.to(socketId).emit('map:token-moved', {
    tokenId: token.id,
    x: token.x,
    y: token.y,
    mapId: token.mapId,
  });
  if (!reason) return;
  io.to(socketId).emit('chat:new-message', {
    id: uuidv4(),
    sessionId,
    userId: 'system',
    displayName: 'System',
    type: 'whisper',
    content: reason,
    characterName: null,
    whisperTo: userId,
    rollData: null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * All token-lifecycle socket events (add / move / remove / update).
 *
 * Pulled out of the old mega `mapEvents.ts`. Shares nothing with fog,
 * walls, or zones, so a standalone registrar keeps the boundaries
 * explicit and makes the hot path (token-move = 30 Hz per user in
 * combat) easy to find and tune.
 */
export function registerTokenEvents(io: Server, socket: Socket): void {
  socket.on(
    'map:token-move',
    safeHandler(socket, async (data) => {
      const parsed = tokenMoveSchema.safeParse(data);
      if (!parsed.success) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;
      if (!checkRateLimit(socket.id, 'map:token-move', 30)) return;

      const { tokenId, x, y } = parsed.data;
      let token = ctx.room.tokens.get(tokenId);
      if (!token) {
        const { rows } = await pool.query('SELECT * FROM tokens WHERE id = $1', [tokenId]);
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return;
        // Verify token's map belongs to this session
        const { rows: mapCheck } = await pool.query(
          'SELECT 1 FROM maps WHERE id = $1 AND session_id = $2',
          [row.map_id, ctx.room.sessionId]
        );
        if (mapCheck.length === 0) return;
        token = rowToToken(row);
      }

      // Ownership: a non-DM may only move tokens they own (same rule in
      // combat and free-roam). A bare `return` here leaves the client that
      // optimistically moved the token stuck at the wrong spot until the
      // next /state snapshot — the move looks like it worked. Echo the
      // authoritative (pre-move) position back to the sender so its canvas
      // rubber-bands immediately. Note this runs BEFORE the in-memory
      // position is mutated below, so token.x/token.y are still the old
      // coordinates.
      const isOwnerOrDM = ctx.player.role === 'dm' || token.ownerUserId === ctx.player.userId;
      if (!isOwnerOrDM) {
        const viewerMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
        if (viewerMapId === token.mapId && tokenVisibleToPlayer(token, ctx.player.userId)) {
          rejectTokenMove(io, socket.id, ctx.room.sessionId, ctx.player.userId, token);
        }
        return;
      }

      const oldX = token.x;
      const oldY = token.y;
      const activeCombatant = ctx.room.combatState?.active
        ? ctx.room.combatState.combatants[ctx.room.combatState.currentTurnIndex]
        : null;
      const isCurrentCombatantMove = activeCombatant?.tokenId === tokenId;
      const gridSize = ctx.room.mapGridSizes.get(token.mapId) ?? 70;
      const movedFeet = gridSize > 0 ? gridDistance(oldX, oldY, x, y, gridSize) : 0;

      if (activeCombatant && ctx.player.role !== 'dm') {
        if (!isCurrentCombatantMove) {
          rejectTokenMove(
            io,
            socket.id,
            ctx.room.sessionId,
            ctx.player.userId,
            token,
            `⛔ ${token.name} cannot move right now — it is not that token's turn.`
          );
          return;
        }
        if (!isTokenActionable(ctx, tokenId)) {
          rejectTokenMove(
            io,
            socket.id,
            ctx.room.sessionId,
            ctx.player.userId,
            token,
            `⛔ ${token.name} cannot move while incapacitated or downed.`
          );
          return;
        }
        const economy = CombatService.getActionEconomy(ctx.room.sessionId);
        const remaining = economy?.movementRemaining ?? activeCombatant.speed;
        if (movedFeet > remaining) {
          rejectTokenMove(
            io,
            socket.id,
            ctx.room.sessionId,
            ctx.player.userId,
            token,
            `⛔ ${token.name} tried to move ${movedFeet} ft but only ${remaining} ft remain this turn. Take Dash for more movement.`
          );
          return;
        }
      }

      // ── Frightened: can't willingly move CLOSER to the fear source ──
      // RAW (PHB p.291): "A frightened creature … can't willingly move
      // closer to the source of its fear." The condition metadata tracks
      // `casterTokenId` as the source (set by e.g. `!fear`, Dreadful
      // Aspect, Conquering Presence). If the move decreases euclidean
      // distance to that source AND the DM didn't issue the move,
      // abort: reply with the original position so the client rubber-
      // bands back and whisper the player a reason.
      if ((token.conditions as string[]).includes('frightened') && ctx.player.role !== 'dm') {
        const metaMap = ctx.room.conditionMeta.get(tokenId);
        const fearMeta = metaMap?.get('frightened');
        const sourceId = fearMeta?.casterTokenId;
        if (sourceId) {
          const sourceToken = ctx.room.tokens.get(sourceId);
          if (sourceToken) {
            const oldDist = Math.hypot(sourceToken.x - oldX, sourceToken.y - oldY);
            const newDist = Math.hypot(sourceToken.x - x, sourceToken.y - y);
            if (newDist < oldDist - 1) {
              // 1-px tolerance for snap rounding
              // Reject: emit the token back to its original position for
              // the moving client and whisper the reason.
              rejectTokenMove(
                io,
                socket.id,
                ctx.room.sessionId,
                ctx.player.userId,
                token,
                `⛔ ${token.name} is frightened of ${sourceToken.name} — can't willingly move closer.`
              );
              return;
            }
          }
        }
      }

      if (ctx.room.tokens.has(tokenId)) {
        token.x = x;
        token.y = y;
      }

      await pool.query('UPDATE tokens SET x = $1, y = $2 WHERE id = $3', [x, y, tokenId]);

      // Scope movement to sockets rendering this map. A DM can move
      // tokens on a preview map; those coordinates must not be shipped
      // to players sitting on the ribbon map.
      const moveRecipients = socketsForToken(ctx.room, token.mapId, token);
      broadcastEventToSockets(
        io,
        ctx.room,
        'map:token-moved',
        { tokenId, x, y, mapId: token.mapId },
        moveRecipients,
        { tokenId, mapId: token.mapId }
      );

      if (activeCombatant && isCurrentCombatantMove && movedFeet > 0) {
        const remaining = CombatService.useMovement(ctx.room.sessionId, movedFeet);
        emitToTokenViewers(
          io,
          ctx.room,
          tokenId,
          'combat:movement-used',
          {
            tokenId,
            remaining,
          },
          { includeOwner: true }
        );
      }

      if (ctx.room.combatState?.active) {
        const opportunities = OpportunityAttackService.detectOpportunityAttacks(
          ctx.room.sessionId,
          tokenId,
          oldX,
          oldY,
          x,
          y
        );
        if (opportunities.length > 0) {
          // Log each detected OA so a failing broadcast is diagnosable
          // from the prod logs — "why didn't the player see the reaction
          // prompt" is the #1 combat support ask.
          console.log(
            `[OA] ${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'} detected on move of ${token.name} (${tokenId})`
          );
        }
        for (const opp of opportunities) {
          const targetOwnerId = opp.attackerOwnerUserId;
          const sentToSocketIds = new Set<string>();
          // Broadcast to the attacker owner on EVERY socket they have open
          // (multi-tab) via userSockets, not just the primary socketId
          // stored on RoomPlayer. The previous single-socket emit missed
          // the player if their active tab was the second one they
          // opened, since RoomPlayer.socketId tracks the most-recent
          // `session:join` and can lag reality if they toggled tabs.
          if (targetOwnerId) {
            const attackerSockets = ctx.room.userSockets.get(targetOwnerId);
            if (attackerSockets && attackerSockets.size > 0) {
              for (const sid of attackerSockets) {
                if (!sentToSocketIds.has(sid)) {
                  io.to(sid).emit('combat:oa-opportunity', opp);
                  sentToSocketIds.add(sid);
                }
              }
            } else {
              console.warn(
                `[OA] attacker owner ${targetOwnerId} for ${opp.attackerName} has no live sockets — OA prompt lost`
              );
            }
          }
          // Always mirror to every DM tab so the DM sees NPC OAs (primary
          // use case) and can observe PC OAs for adjudication.
          for (const player of ctx.room.players.values()) {
            if (player.role !== 'dm') continue;
            const dmSockets = ctx.room.userSockets.get(player.userId);
            if (dmSockets) {
              for (const sid of dmSockets) {
                if (!sentToSocketIds.has(sid)) {
                  io.to(sid).emit('combat:oa-opportunity', opp);
                  sentToSocketIds.add(sid);
                }
              }
            } else if (!sentToSocketIds.has(player.socketId)) {
              io.to(player.socketId).emit('combat:oa-opportunity', opp);
              sentToSocketIds.add(player.socketId);
            }
          }
        }
      }
    })
  );

  socket.on(
    'map:token-add',
    safeHandler(socket, async (data) => {
      const parsed = tokenAddSchema.safeParse(data);
      if (!parsed.success) {
        // Silent validation drops used to eat bugs like "DDB-proxied portrait
        // URL isn't on the allowlist", so surface the issue path + message.
        console.warn(
          '[map:token-add] validation failed:',
          parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          }))
        );
        return;
      }
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      if (ctx.player.role !== 'dm') {
        // Players may only add tokens they own. Loot drops are NOT
        // created via this event — use POST /api/characters/:id/loot/drop
        // which validates the source inventory atomically server-side.
        const ownerUserId = parsed.data.ownerUserId;
        const isOwnToken = ownerUserId && ownerUserId === ctx.player.userId;
        if (!isOwnToken) return;

        // Anchor the token to a character? Then the character must
        // belong to the caller. Previously a player could craft a
        // payload with ownerUserId=self but characterId=another user's
        // PC — and any subsequent combat HP writes would flow back to
        // that other character via tokens.character_id.
        const claimedCharId = parsed.data.characterId ?? null;
        if (claimedCharId) {
          const { rows: charRows } = await pool.query(
            'SELECT user_id FROM characters WHERE id = $1',
            [claimedCharId]
          );
          const charOwner = charRows[0]?.user_id as string | null | undefined;
          if (!charOwner) return;
          // Players may only place tokens backed by their own character
          // rows. NPC/monster placement is DM-owned; allowing
          // user_id='npc' here lets players create self-owned tokens
          // linked to shared NPC rows and later mutate shared HP/state.
          if (charOwner !== ctx.player.userId) return;
        }
      }

      const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
      if (!targetMapId) return;

      // R6: Auto-number duplicate token names on the same map.
      //   Existing: "Goblin"                → new becomes "Goblin 2"
      //   Existing: "Goblin", "Goblin 2"    → new becomes "Goblin 3"
      //   Existing: "Goblin 2" only         → new becomes "Goblin" (fills the slot)
      //   No duplicates                     → keep the requested name
      // The base name is untouched (we don't rename "Goblin" → "Goblin 1"
      // retroactively — that would be disruptive for tokens already in
      // play). This matches the TokenNameNumber script pattern from
      // roll20-api-scripts.
      const requestedName = parsed.data.name;
      let finalName = requestedName;
      {
        const { rows: dupRows } = await pool.query(
          'SELECT name FROM tokens WHERE map_id = $1 AND (name = $2 OR name LIKE $3)',
          [targetMapId, requestedName, `${requestedName} %`]
        );
        if (dupRows.length > 0) {
          const suffixRe = new RegExp(
            `^${requestedName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} (\\d+)$`
          );
          const used = new Set<number>();
          let hasBase = false;
          for (const r of dupRows) {
            const n = r.name as string;
            if (n === requestedName) {
              hasBase = true;
              continue;
            }
            const m = suffixRe.exec(n);
            if (m) used.add(parseInt(m[1], 10));
          }
          if (!hasBase) {
            // Base name free (only numbered dupes exist) — take it.
            finalName = requestedName;
          } else {
            let next = 2;
            while (used.has(next)) next += 1;
            finalName = `${requestedName} ${next}`;
          }
        }
      }

      const tokenId = uuidv4();
      const now = new Date().toISOString();

      // Default faction: if the client didn't specify one, infer from
      // ownership + character type. PC tokens (non-null ownerUserId)
      // are friendly; NPCs owned by the 'npc' system user are hostile;
      // the "loot bag" drop flow creates neutral characters with
      // race='loot' class='bag' and passes ownerUserId=null — we treat
      // those (and any other loose NPC tokens the DM places) as hostile
      // by default, and the DM toggles them to neutral/friendly from
      // the panel. Explicit faction in the payload always wins.
      let defaultFaction: Token['faction'] = 'hostile';
      const payloadOwnerUserId = parsed.data.ownerUserId ?? null;
      if (payloadOwnerUserId) {
        defaultFaction = 'friendly';
      } else if (parsed.data.characterId) {
        try {
          const { rows: charRows } = await pool.query(
            'SELECT user_id, race, class FROM characters WHERE id = $1',
            [parsed.data.characterId]
          );
          const row = charRows[0] as Record<string, unknown> | undefined;
          if (row) {
            const race = String(row.race ?? '').toLowerCase();
            const klass = String(row.class ?? '').toLowerCase();
            if (race === 'loot' && klass === 'bag') {
              defaultFaction = 'neutral';
            } else if (row.user_id === 'npc') {
              defaultFaction = 'hostile';
            } else if (row.user_id && row.user_id !== 'npc') {
              defaultFaction = 'friendly';
            }
          }
        } catch {
          /* fall through to hostile */
        }
      }
      const finalFaction: Token['faction'] = parsed.data.faction ?? defaultFaction;

      // Snap the drop point to the nearest grid cell CENTER. Call sites
      // (context menu, creature library, encounter builder, loot drop)
      // hand us raw pointer coords; without snapping, tokens land on the
      // cross-hair corner where four cells meet — characters appear to
      // straddle tiles. snapToGrid is a no-op when gridSize is 0 or the
      // map has no grid config cached yet.
      const snapGridSize = ctx.room.mapGridSizes.get(targetMapId) ?? 0;
      const snapped =
        snapGridSize > 0
          ? snapToGrid(parsed.data.x, parsed.data.y, snapGridSize)
          : { x: parsed.data.x, y: parsed.data.y };

      const token: Token = {
        id: tokenId,
        mapId: targetMapId,
        characterId: parsed.data.characterId ?? null,
        name: finalName,
        x: snapped.x,
        y: snapped.y,
        size: parsed.data.size,
        imageUrl: parsed.data.imageUrl ?? null,
        color: parsed.data.color,
        layer: parsed.data.layer,
        visible: parsed.data.visible,
        hasLight: parsed.data.hasLight,
        lightRadius: parsed.data.lightRadius,
        lightDimRadius: parsed.data.lightDimRadius,
        lightColor: parsed.data.lightColor,
        conditions: parsed.data.conditions as Token['conditions'],
        ownerUserId: payloadOwnerUserId,
        faction: finalFaction,
        createdAt: now,
      };

      if (targetMapId === ctx.room.playerMapId) ctx.room.tokens.set(tokenId, token);

      await pool.query(
        `
      INSERT INTO tokens (
        id, map_id, character_id, name, x, y, size, image_url, color, layer,
        visible, has_light, light_radius, light_dim_radius, light_color,
        conditions, owner_user_id, faction
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `,
        [
          tokenId,
          token.mapId,
          token.characterId,
          token.name,
          token.x,
          token.y,
          token.size,
          token.imageUrl,
          token.color,
          token.layer,
          token.visible ? 1 : 0,
          token.hasLight ? 1 : 0,
          token.lightRadius,
          token.lightDimRadius,
          token.lightColor,
          JSON.stringify(token.conditions),
          token.ownerUserId,
          token.faction,
        ]
      );

      const addRecipients = socketsForToken(ctx.room, targetMapId, token);
      broadcastEventToSockets(
        io,
        ctx.room,
        'map:token-added',
        token as unknown as Record<string, unknown>,
        addRecipients,
        { tokenId, mapId: targetMapId }
      );
    })
  );

  socket.on(
    'map:token-remove',
    safeHandler(socket, async (data) => {
      const parsed = tokenRemoveSchema.safeParse(data);
      if (!parsed.success) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;
      const { tokenId } = parsed.data;

      // Authorization: DMs can remove anything; players can only remove
      // tokens they own (e.g. a Light spell marker they cast). Previously
      // only DMs were allowed, which meant a player who cast Light had
      // to ask the DM to click away their own utility token. The
      // ownerUserId check scopes the escape hatch narrowly — PC tokens
      // are still DM-only to remove, because PC ownerUserId is typically
      // the player, and the UI doesn't expose delete to them anyway.
      let tokenMapId: string | null = null;
      let tokenOwnerUserId: string | null = null;
      const inMem = ctx.room.tokens.get(tokenId);
      if (inMem) {
        tokenMapId = inMem.mapId;
        tokenOwnerUserId = inMem.ownerUserId ?? null;
      } else {
        const { rows } = await pool.query(
          'SELECT t.map_id, t.owner_user_id FROM tokens t JOIN maps m ON t.map_id = m.id WHERE t.id = $1 AND m.session_id = $2',
          [tokenId, ctx.room.sessionId]
        );
        if (rows[0]) {
          tokenMapId = rows[0].map_id as string;
          tokenOwnerUserId = (rows[0].owner_user_id as string | null) ?? null;
        } else {
          return;
        }
      }

      if (ctx.player.role !== 'dm' && tokenOwnerUserId !== ctx.player.userId) {
        // Player trying to remove a token they don't own — silently drop.
        return;
      }

      const cleanup = CombatService.cleanupRemovedTokenFromCombat(ctx.room.sessionId, tokenId);
      for (const affectedTokenId of [
        ...cleanup.releasedGrappleTokenIds,
        ...cleanup.concentrationClearedTokenIds,
      ]) {
        if (!ctx.room.tokens.has(affectedTokenId)) continue;
        emitToTokenViewers(io, ctx.room, affectedTokenId, 'map:token-updated', {
          tokenId: affectedTokenId,
          changes: tokenConditionChanges(ctx.room, affectedTokenId),
        });
      }

      if (inMem) ctx.room.tokens.delete(tokenId);
      await pool.query('DELETE FROM tokens WHERE id = $1', [tokenId]);

      if (cleanup.combatStateChanged) {
        emitCombatStateSync(io, ctx.room);
      }

      // Broadcast removal only to sockets rendering this map. The
      // `mapId` in the payload lets map-scoped UI decide whether to
      // animate the removal or silently drop it.
      const removeRecipients = tokenMapId
        ? socketsOnMap(ctx.room, tokenMapId)
        : Array.from(ctx.room.userSockets.values()).flatMap((sids) => Array.from(sids));
      broadcastEventToSockets(
        io,
        ctx.room,
        'map:token-removed',
        { tokenId, ...(tokenMapId ? { mapId: tokenMapId } : {}) },
        removeRecipients,
        { tokenId, mapId: tokenMapId }
      );
    })
  );

  socket.on(
    'map:token-update',
    safeHandler(socket, async (data) => {
      const parsed = tokenUpdateSchema.safeParse(data);
      if (!parsed.success) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;

      const { tokenId, changes } = parsed.data;
      let token = ctx.room.tokens.get(tokenId);
      let tokenMapId: string | null = null;
      if (token) {
        tokenMapId = token.mapId;
      } else {
        const { rows } = await pool.query(
          'SELECT t.* FROM tokens t JOIN maps m ON t.map_id = m.id WHERE t.id = $1 AND m.session_id = $2',
          [tokenId, ctx.room.sessionId]
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return;
        tokenMapId = row.map_id as string;
        token = rowToToken(row);
      }

      // Snapshot pre-update visibility so per-recipient fanout can send
      // added/removed events instead of leaking hidden/invisible token
      // payloads to players that should not currently see the token.
      const beforeToken: Token = {
        ...token,
        conditions: Array.isArray(token.conditions)
          ? ([...token.conditions] as Token['conditions'])
          : token.conditions,
      };

      const isDM = ctx.player.role === 'dm';
      const isOwner = token.ownerUserId === ctx.player.userId;
      // Faction is a DM-only field — non-DM clients cannot change sides.
      if (!isDM && changes.faction !== undefined) return;
      if (!isDM) {
        if (isOwner && changes.conditions !== undefined) return;
        if (!isOwner) {
          // Non-owner, non-DM players cannot modify other tokens through
          // this path at all. The old rule allowed `conditions` writes on
          // unowned NPCs ("mark the goblin bloodied"), but that let
          // players overwrite the full conditions array — adding dead,
          // stunned, paralyzed, etc. bypassing the combat system.
          // Legitimate condition changes go through combat:condition-add
          // and condition:apply-with-meta which have proper auth checks.
          return;
        }
      }

      if (ctx.room.tokens.has(tokenId)) Object.assign(token, changes);

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (changes.name !== undefined) {
        setClauses.push(`name = $${paramIdx++}`);
        params.push(changes.name);
      }
      if (changes.x !== undefined) {
        setClauses.push(`x = $${paramIdx++}`);
        params.push(changes.x);
      }
      if (changes.y !== undefined) {
        setClauses.push(`y = $${paramIdx++}`);
        params.push(changes.y);
      }
      if (changes.size !== undefined) {
        setClauses.push(`size = $${paramIdx++}`);
        params.push(changes.size);
      }
      if (changes.imageUrl !== undefined) {
        setClauses.push(`image_url = $${paramIdx++}`);
        params.push(changes.imageUrl);
      }
      if (changes.color !== undefined) {
        setClauses.push(`color = $${paramIdx++}`);
        params.push(changes.color);
      }
      if (changes.layer !== undefined) {
        setClauses.push(`layer = $${paramIdx++}`);
        params.push(changes.layer);
      }
      if (changes.visible !== undefined) {
        setClauses.push(`visible = $${paramIdx++}`);
        params.push(changes.visible ? 1 : 0);
      }
      if (changes.hasLight !== undefined) {
        setClauses.push(`has_light = $${paramIdx++}`);
        params.push(changes.hasLight ? 1 : 0);
      }
      if (changes.lightRadius !== undefined) {
        setClauses.push(`light_radius = $${paramIdx++}`);
        params.push(changes.lightRadius);
      }
      if (changes.lightDimRadius !== undefined) {
        setClauses.push(`light_dim_radius = $${paramIdx++}`);
        params.push(changes.lightDimRadius);
      }
      if (changes.lightColor !== undefined) {
        setClauses.push(`light_color = $${paramIdx++}`);
        params.push(changes.lightColor);
      }
      if (changes.conditions !== undefined) {
        setClauses.push(`conditions = $${paramIdx++}`);
        params.push(JSON.stringify(changes.conditions));
      }
      if (changes.ownerUserId !== undefined) {
        setClauses.push(`owner_user_id = $${paramIdx++}`);
        params.push(changes.ownerUserId);
      }
      if (changes.faction !== undefined) {
        setClauses.push(`faction = $${paramIdx++}`);
        params.push(changes.faction);
      }
      if (changes.aura !== undefined) {
        setClauses.push(`aura = $${paramIdx++}`);
        // aura is either {radiusFeet,color,opacity,shape} or null
        // (explicitly clearing the aura). JSON.stringify(null) = "null"
        // which is valid JSON — safeParseJSON round-trips it correctly.
        params.push(changes.aura === null ? null : JSON.stringify(changes.aura));
      }

      if (setClauses.length > 0) {
        params.push(tokenId);
        await pool.query(
          `UPDATE tokens SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
          params
        );
      }

      const latestToken = ctx.room.tokens.get(tokenId) ?? token;

      if (tokenMapId) {
        const recipients = socketRecipientsOnMap(ctx.room, tokenMapId);
        for (const { socketId: sid, role, userId } of recipients) {
          if (role === 'dm') {
            io.to(sid).emit('map:token-updated', { tokenId, changes, mapId: tokenMapId });
            continue;
          }
          const couldSeeBefore = tokenVisibleToPlayer(beforeToken, userId);
          const canSeeLatest = tokenVisibleToPlayer(latestToken, userId);
          if (!couldSeeBefore && !canSeeLatest) continue;
          if (!couldSeeBefore && canSeeLatest) {
            io.to(sid).emit('map:token-added', latestToken);
          } else if (couldSeeBefore && !canSeeLatest) {
            io.to(sid).emit('map:token-removed', { tokenId, mapId: tokenMapId });
          } else {
            io.to(sid).emit('map:token-updated', { tokenId, changes, mapId: tokenMapId });
          }
        }
      } else {
        io.to(ctx.room.sessionId).emit('map:token-updated', { tokenId, changes });
      }
    })
  );
}
