import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId, socketsOnMap, checkRateLimit,
} from '../utils/roomState.js';
import * as OpportunityAttackService from '../services/OpportunityAttackService.js';
import { loadDrawingsForMap, filterDrawingsForPlayer } from './drawingEvents.js';
import {
  mapLoadSchema, tokenMoveSchema, tokenAddSchema, tokenRemoveSchema,
  tokenUpdateSchema, fogRevealHideSchema, wallAddSchema, wallRemoveSchema,
  mapPingSchema,
} from '../utils/validation.js';

export function registerMapEvents(io: Server, socket: Socket): void {

  socket.on('map:load', (data) => {
    const parsed = mapLoadSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { mapId } = parsed.data;

    const mapRow = db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId) as Record<string, unknown> | undefined;
    if (!mapRow) return;

    const tokenRows = db.prepare('SELECT * FROM tokens WHERE map_id = ?').all(mapId) as Array<Record<string, unknown>>;

    const tokens: Token[] = tokenRows.map(t => ({
      id: t.id as string,
      mapId: t.map_id as string,
      characterId: t.character_id as string | null,
      name: t.name as string,
      x: t.x as number,
      y: t.y as number,
      size: t.size as number,
      imageUrl: t.image_url as string | null,
      color: t.color as string,
      layer: t.layer as Token['layer'],
      visible: Boolean(t.visible),
      hasLight: Boolean(t.has_light),
      lightRadius: t.light_radius as number,
      lightDimRadius: t.light_dim_radius as number,
      lightColor: t.light_color as string,
      conditions: JSON.parse(t.conditions as string),
      ownerUserId: t.owner_user_id as string | null,
      createdAt: t.created_at as string,
    }));

    // Store tokens in room memory
    ctx.room.currentMapId = mapId;
    // If this is the first map load for the session (fresh room with
    // no player ribbon yet), seed the ribbon to this map so players
    // get a coherent view. Scene manager activation (`map:activate-for-players`)
    // will override this later when the DM explicitly moves the ribbon.
    if (!ctx.room.playerMapId) {
      ctx.room.playerMapId = mapId;
      try {
        db.prepare('UPDATE sessions SET player_map_id = ? WHERE id = ?')
          .run(mapId, ctx.room.sessionId);
      } catch { /* ignore */ }
    }
    ctx.room.tokens.clear();
    for (const token of tokens) {
      ctx.room.tokens.set(token.id, token);
    }

    // Rehydrate drawings for this map into room memory. Ephemeral
    // drawings are lost on server restart, which is fine — they're
    // ephemeral by design. Only permanent ones come out of SQLite.
    const persistedDrawings = loadDrawingsForMap(mapId);
    ctx.room.drawings.clear();
    for (const d of persistedDrawings) {
      ctx.room.drawings.set(d.id, d);
    }

    // Update session's current map
    db.prepare('UPDATE sessions SET current_map_id = ? WHERE id = ?').run(mapId, ctx.room.sessionId);

    const mapData = {
      id: mapRow.id as string,
      name: mapRow.name as string,
      imageUrl: mapRow.image_url as string | null,
      width: mapRow.width as number,
      height: mapRow.height as number,
      gridSize: mapRow.grid_size as number,
      gridType: mapRow.grid_type as 'square' | 'hex',
      gridOffsetX: mapRow.grid_offset_x as number,
      gridOffsetY: mapRow.grid_offset_y as number,
      walls: JSON.parse(mapRow.walls as string) as WallSegment[],
      fogState: JSON.parse(mapRow.fog_state as string) as FogPolygon[],
    };

    // Send per-player payloads so each client only receives drawings
    // they have permission to see (shared drawings go to everyone,
    // dm-only only to DMs, player-only only to the creator + DMs).
    for (const player of ctx.room.players.values()) {
      const visibleDrawings = filterDrawingsForPlayer(persistedDrawings, player);
      io.to(player.socketId).emit('map:loaded', {
        map: mapData,
        tokens,
        drawings: visibleDrawings,
      });
    }
  });

  socket.on('map:token-move', (data) => {
    const parsed = tokenMoveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    if (!checkRateLimit(socket.id, 'map:token-move', 30)) return;

    const { tokenId, x, y } = parsed.data;
    // First try the canonical in-memory map (ribbon tokens). If not
    // there, fall back to a direct DB lookup so DMs can still move
    // tokens on a preview map they're editing.
    let token = ctx.room.tokens.get(tokenId);
    if (!token) {
      const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(tokenId) as Record<string, unknown> | undefined;
      if (!row) return;
      token = {
        id: row.id as string,
        mapId: row.map_id as string,
        characterId: row.character_id as string | null,
        name: row.name as string,
        x: row.x as number,
        y: row.y as number,
        size: row.size as number,
        imageUrl: row.image_url as string | null,
        color: row.color as string,
        layer: row.layer as Token['layer'],
        visible: Boolean(row.visible),
        hasLight: Boolean(row.has_light),
        lightRadius: row.light_radius as number,
        lightDimRadius: row.light_dim_radius as number,
        lightColor: row.light_color as string,
        conditions: JSON.parse(row.conditions as string),
        ownerUserId: row.owner_user_id as string | null,
        createdAt: row.created_at as string,
      };
    }

    // Validate ownership: in combat, players can only move their own tokens
    if (ctx.room.gameMode === 'combat' && ctx.player.role !== 'dm') {
      if (token.ownerUserId !== ctx.player.userId) return;
    }
    // In free-roam, only DM or token owner can move
    if (ctx.room.gameMode === 'free-roam' && ctx.player.role !== 'dm') {
      if (token.ownerUserId !== ctx.player.userId) return;
    }

    // Capture the OLD position BEFORE we overwrite it — needed for
    // Opportunity Attack detection.
    const oldX = token.x;
    const oldY = token.y;

    // Update in memory (only if it lives on the canonical ribbon map)
    if (ctx.room.tokens.has(tokenId)) {
      token.x = x;
      token.y = y;
    }

    // Persist to DB
    db.prepare('UPDATE tokens SET x = ?, y = ? WHERE id = ?').run(x, y, tokenId);

    // Broadcast to every socket currently rendering the token's map.
    // This filter is critical: a DM editing a preview map must not
    // leak token updates to players who are still on the ribbon.
    const recipients = socketsOnMap(ctx.room, token.mapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:token-moved', { tokenId, x, y, mapId: token.mapId });
    }

    // ── Opportunity Attack detection ───────────────────────────
    // Only fires during combat. For each enemy that lost the mover
    // from their reach on this step, emit a private prompt to the
    // attacker's owner (or the DM for NPC attackers). The player
    // then clicks Attack / Let them go in the modal.
    if (ctx.room.combatState?.active) {
      const opportunities = OpportunityAttackService.detectOpportunityAttacks(
        ctx.room.sessionId,
        tokenId,
        oldX,
        oldY,
        x,
        y,
      );
      for (const opp of opportunities) {
        const targetOwnerId = opp.attackerOwnerUserId;
        // Routing rules:
        //   • NPC attackers (no owner) → DM(s) only
        //   • Player attackers → BOTH the attacker's owner AND the DM
        //     This way the DM can always resolve any OA, even when the
        //     attacking player isn't connected (solo DM testing,
        //     spectator games, dropped connections).
        //   • Same socket never gets the same prompt twice.
        const sentToSocketIds = new Set<string>();
        const emittedTo: string[] = [];
        for (const player of ctx.room.players.values()) {
          const isDM = player.role === 'dm';
          const isAttackerOwner = targetOwnerId && player.userId === targetOwnerId;
          let shouldSend = false;
          if (targetOwnerId) {
            // PC attacker: send to owner AND every DM
            if (isAttackerOwner || isDM) shouldSend = true;
          } else {
            // NPC attacker: DMs only
            if (isDM) shouldSend = true;
          }
          if (shouldSend && !sentToSocketIds.has(player.socketId)) {
            io.to(player.socketId).emit('combat:oa-opportunity', opp);
            sentToSocketIds.add(player.socketId);
            emittedTo.push(`${player.userId}(${player.role})`);
          }
        }
        console.log(`[OA EMIT] ${opp.attackerName} → ${opp.moverName} | targetOwner=${targetOwnerId ?? 'NPC'} | sent to: ${emittedTo.length > 0 ? emittedTo.join(', ') : '⚠ NO ONE (no matching socket)'}`);
      }
    }
  });

  socket.on('map:token-add', (data) => {
    const parsed = tokenAddSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Players can place tokens they own OR dropped loot tokens
    // DM can place any token
    if (ctx.player.role !== 'dm') {
      const ownerUserId = parsed.data.ownerUserId;
      const isOwnToken = ownerUserId && ownerUserId === ctx.player.userId;
      const isLootDrop = parsed.data.layer === 'token' && parsed.data.size === 0.5;
      if (!isOwnToken && !isLootDrop) return;
    }

    // Resolve which map this socket is editing — for DMs, this is
    // their preview cursor if set, else the player ribbon. Players
    // can only add tokens to the ribbon map.
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const tokenId = uuidv4();
    const now = new Date().toISOString();

    const token: Token = {
      id: tokenId,
      mapId: targetMapId,
      characterId: parsed.data.characterId ?? null,
      name: parsed.data.name,
      x: parsed.data.x,
      y: parsed.data.y,
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
      ownerUserId: parsed.data.ownerUserId ?? null,
      createdAt: now,
    };

    // Only store in canonical room memory if the target is the
    // player ribbon — the room.tokens map is the ribbon's tokens.
    if (targetMapId === ctx.room.playerMapId) {
      ctx.room.tokens.set(tokenId, token);
    }

    // Persist to DB
    db.prepare(`
      INSERT INTO tokens (
        id, map_id, character_id, name, x, y, size, image_url, color, layer,
        visible, has_light, light_radius, light_dim_radius, light_color,
        conditions, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenId, token.mapId, token.characterId, token.name,
      token.x, token.y, token.size, token.imageUrl, token.color, token.layer,
      token.visible ? 1 : 0, token.hasLight ? 1 : 0,
      token.lightRadius, token.lightDimRadius, token.lightColor,
      JSON.stringify(token.conditions), token.ownerUserId,
    );

    // Broadcast only to sockets currently rendering this target map.
    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:token-added', token);
    }
  });

  socket.on('map:token-remove', (data) => {
    const parsed = tokenRemoveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { tokenId } = parsed.data;

    // Look up which map this token belongs to so we know where to
    // broadcast the removal. In-memory first, then DB fallback.
    let tokenMapId: string | null = null;
    const inMem = ctx.room.tokens.get(tokenId);
    if (inMem) {
      tokenMapId = inMem.mapId;
      ctx.room.tokens.delete(tokenId);
    } else {
      const row = db.prepare('SELECT map_id FROM tokens WHERE id = ?').get(tokenId) as { map_id: string } | undefined;
      if (row) tokenMapId = row.map_id;
    }

    db.prepare('DELETE FROM tokens WHERE id = ?').run(tokenId);

    // Broadcast only to sockets currently rendering this map.
    if (tokenMapId) {
      const recipients = socketsOnMap(ctx.room, tokenMapId);
      for (const sid of recipients) {
        io.to(sid).emit('map:token-removed', { tokenId, mapId: tokenMapId });
      }
    } else {
      // Map unknown — fall back to full broadcast (shouldn't happen)
      io.to(ctx.room.sessionId).emit('map:token-removed', { tokenId });
    }
  });

  socket.on('map:token-update', (data) => {
    const parsed = tokenUpdateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId, changes } = parsed.data;
    // Try in-memory first (ribbon tokens), then DB fallback for
    // tokens on other maps. This lets a DM edit tokens on a preview
    // map without the ribbon tokens being loaded into memory.
    let token = ctx.room.tokens.get(tokenId);
    let tokenMapId: string | null = null;
    if (token) {
      tokenMapId = token.mapId;
    } else {
      const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(tokenId) as Record<string, unknown> | undefined;
      if (!row) return;
      tokenMapId = row.map_id as string;
      token = {
        id: row.id as string,
        mapId: row.map_id as string,
        characterId: row.character_id as string | null,
        name: row.name as string,
        x: row.x as number,
        y: row.y as number,
        size: row.size as number,
        imageUrl: row.image_url as string | null,
        color: row.color as string,
        layer: row.layer as Token['layer'],
        visible: Boolean(row.visible),
        hasLight: Boolean(row.has_light),
        lightRadius: row.light_radius as number,
        lightDimRadius: row.light_dim_radius as number,
        lightColor: row.light_color as string,
        conditions: JSON.parse(row.conditions as string),
        ownerUserId: row.owner_user_id as string | null,
        createdAt: row.created_at as string,
      };
    }

    // Permission check:
    //   • DM can do anything, including editing conditions on any token.
    //   • Token owner can update their own token EXCEPT for conditions —
    //     players are not allowed to self-apply conditions via this path.
    //     If a player wants a condition (e.g. Haste from casting on self),
    //     they must go through condition:apply-with-meta via the spell
    //     cast resolver. This prevents a player from granting themselves
    //     conditions the DM hasn't sanctioned.
    //   • Any player can update an UNOWNED (NPC) token if the change is
    //     limited to game-state fields (position, conditions). This is
    //     what lets a player's Thunderwave push back a bandit, apply
    //     paralyzed from Hold Person, etc. Without this NPC effects from
    //     player-cast spells silently fail.
    const isDM = ctx.player.role === 'dm';
    const isOwner = token.ownerUserId === ctx.player.userId;
    if (!isDM) {
      // Block self-condition edits for owners.
      if (isOwner && changes.conditions !== undefined) {
        return;
      }
      if (!isOwner) {
        const isUnownedNpc = token.ownerUserId === null;
        const allowedFields = new Set(['x', 'y', 'conditions']);
        const onlyGameStateChanges = Object.keys(changes).every((k) => allowedFields.has(k));
        if (!isUnownedNpc || !onlyGameStateChanges) return;
      }
    }

    // Apply changes in memory (only if the token actually lives on the
    // canonical ribbon map — DM preview-map tokens aren't in room.tokens)
    if (ctx.room.tokens.has(tokenId)) {
      Object.assign(token, changes);
    }

    // Build update SQL
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (changes.name !== undefined) { setClauses.push('name = ?'); params.push(changes.name); }
    if (changes.x !== undefined) { setClauses.push('x = ?'); params.push(changes.x); }
    if (changes.y !== undefined) { setClauses.push('y = ?'); params.push(changes.y); }
    if (changes.size !== undefined) { setClauses.push('size = ?'); params.push(changes.size); }
    if (changes.imageUrl !== undefined) { setClauses.push('image_url = ?'); params.push(changes.imageUrl); }
    if (changes.color !== undefined) { setClauses.push('color = ?'); params.push(changes.color); }
    if (changes.layer !== undefined) { setClauses.push('layer = ?'); params.push(changes.layer); }
    if (changes.visible !== undefined) { setClauses.push('visible = ?'); params.push(changes.visible ? 1 : 0); }
    if (changes.hasLight !== undefined) { setClauses.push('has_light = ?'); params.push(changes.hasLight ? 1 : 0); }
    if (changes.lightRadius !== undefined) { setClauses.push('light_radius = ?'); params.push(changes.lightRadius); }
    if (changes.lightDimRadius !== undefined) { setClauses.push('light_dim_radius = ?'); params.push(changes.lightDimRadius); }
    if (changes.lightColor !== undefined) { setClauses.push('light_color = ?'); params.push(changes.lightColor); }
    if (changes.conditions !== undefined) { setClauses.push('conditions = ?'); params.push(JSON.stringify(changes.conditions)); }
    if (changes.ownerUserId !== undefined) { setClauses.push('owner_user_id = ?'); params.push(changes.ownerUserId); }

    if (setClauses.length > 0) {
      params.push(tokenId);
      db.prepare(`UPDATE tokens SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    }

    // Broadcast only to sockets rendering this token's map
    if (tokenMapId) {
      const recipients = socketsOnMap(ctx.room, tokenMapId);
      for (const sid of recipients) {
        io.to(sid).emit('map:token-updated', { tokenId, changes, mapId: tokenMapId });
      }
    } else {
      io.to(ctx.room.sessionId).emit('map:token-updated', { tokenId, changes });
    }
  });

  socket.on('map:fog-reveal', (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    // Resolve which map THIS DM is editing (preview cursor or ribbon).
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    // Get current fog state for that specific map
    const mapRow = db.prepare('SELECT fog_state FROM maps WHERE id = ?').get(targetMapId) as { fog_state: string } | undefined;
    if (!mapRow) return;

    const fogState: FogPolygon[] = JSON.parse(mapRow.fog_state);
    fogState.push({ points: parsed.data.points });

    db.prepare('UPDATE maps SET fog_state = ? WHERE id = ?')
      .run(JSON.stringify(fogState), targetMapId);

    // Broadcast only to sockets rendering this map (filters out
    // players still on the ribbon while the DM previews elsewhere).
    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
    }
  });

  socket.on('map:fog-hide', (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const mapRow = db.prepare('SELECT fog_state FROM maps WHERE id = ?').get(targetMapId) as { fog_state: string } | undefined;
    if (!mapRow) return;

    let fogState: FogPolygon[] = JSON.parse(mapRow.fog_state);
    // Remove the matching polygon (by comparing points arrays)
    const targetPoints = JSON.stringify(parsed.data.points);
    fogState = fogState.filter(f => JSON.stringify(f.points) !== targetPoints);

    db.prepare('UPDATE maps SET fog_state = ? WHERE id = ?')
      .run(JSON.stringify(fogState), targetMapId);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
    }
  });

  socket.on('map:wall-add', (data) => {
    const parsed = wallAddSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const mapRow = db.prepare('SELECT walls FROM maps WHERE id = ?').get(targetMapId) as { walls: string } | undefined;
    if (!mapRow) return;

    const walls: WallSegment[] = JSON.parse(mapRow.walls);
    walls.push(parsed.data);

    db.prepare('UPDATE maps SET walls = ? WHERE id = ?')
      .run(JSON.stringify(walls), targetMapId);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
    }
  });

  socket.on('map:wall-remove', (data) => {
    const parsed = wallRemoveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const mapRow = db.prepare('SELECT walls FROM maps WHERE id = ?').get(targetMapId) as { walls: string } | undefined;
    if (!mapRow) return;

    const walls: WallSegment[] = JSON.parse(mapRow.walls);
    if (parsed.data.index < 0 || parsed.data.index >= walls.length) return;
    walls.splice(parsed.data.index, 1);

    db.prepare('UPDATE maps SET walls = ? WHERE id = ?')
      .run(JSON.stringify(walls), targetMapId);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
    }
  });

  socket.on('map:ping', (data) => {
    const parsed = mapPingSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    io.to(ctx.room.sessionId).emit('map:pinged', {
      x: parsed.data.x,
      y: parsed.data.y,
      userId: ctx.player.userId,
      displayName: ctx.player.displayName,
      timestamp: Date.now(),
    });
  });
}
