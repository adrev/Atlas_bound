import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId, socketsOnMap, checkRateLimit,
} from '../utils/roomState.js';
import * as OpportunityAttackService from '../services/OpportunityAttackService.js';
import { loadDrawingsForMapAsync, filterDrawingsForPlayer } from './drawingEvents.js';
import {
  mapLoadSchema, tokenMoveSchema, tokenAddSchema, tokenRemoveSchema,
  tokenUpdateSchema, fogRevealHideSchema, wallAddSchema, wallRemoveSchema,
  mapPingSchema,
} from '../utils/validation.js';

export function registerMapEvents(io: Server, socket: Socket): void {

  socket.on('map:load', async (data) => {
    const parsed = mapLoadSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    const { mapId } = parsed.data;

    // Verify map belongs to this session
    const { rows: ownerCheck } = await pool.query('SELECT 1 FROM maps WHERE id = $1 AND session_id = $2', [mapId, ctx.room.sessionId]);
    if (ownerCheck.length === 0) return;

    const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1', [mapId]);
    const mapRow = mapRows[0] as Record<string, unknown> | undefined;
    if (!mapRow) return;

    const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [mapId]);
    const tokens: Token[] = tokenRows.map(t => ({
      id: t.id, mapId: t.map_id, characterId: t.character_id, name: t.name,
      x: t.x, y: t.y, size: t.size, imageUrl: t.image_url, color: t.color,
      layer: t.layer as Token['layer'], visible: Boolean(t.visible),
      hasLight: Boolean(t.has_light), lightRadius: t.light_radius,
      lightDimRadius: t.light_dim_radius, lightColor: t.light_color,
      conditions: JSON.parse(t.conditions as string), ownerUserId: t.owner_user_id,
      createdAt: t.created_at,
    }));

    ctx.room.currentMapId = mapId;
    if (!ctx.room.playerMapId) {
      ctx.room.playerMapId = mapId;
      try { await pool.query('UPDATE sessions SET player_map_id = $1 WHERE id = $2', [mapId, ctx.room.sessionId]); } catch { /* ignore */ }
    }
    ctx.room.tokens.clear();
    for (const token of tokens) ctx.room.tokens.set(token.id, token);

    const persistedDrawings = await loadDrawingsForMapAsync(mapId);
    ctx.room.drawings.clear();
    for (const d of persistedDrawings) ctx.room.drawings.set(d.id, d);

    await pool.query('UPDATE sessions SET current_map_id = $1 WHERE id = $2', [mapId, ctx.room.sessionId]);

    const mapData = {
      id: mapRow.id as string, name: mapRow.name as string,
      imageUrl: mapRow.image_url as string | null,
      width: mapRow.width as number, height: mapRow.height as number,
      gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as 'square' | 'hex',
      gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
      walls: JSON.parse(mapRow.walls as string) as WallSegment[],
      fogState: JSON.parse(mapRow.fog_state as string) as FogPolygon[],
    };

    for (const player of ctx.room.players.values()) {
      const visibleDrawings = filterDrawingsForPlayer(persistedDrawings, player);
      io.to(player.socketId).emit('map:loaded', { map: mapData, tokens, drawings: visibleDrawings });
    }
  });

  socket.on('map:token-move', async (data) => {
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
      const { rows: mapCheck } = await pool.query('SELECT 1 FROM maps WHERE id = $1 AND session_id = $2', [row.map_id, ctx.room.sessionId]);
      if (mapCheck.length === 0) return;
      token = {
        id: row.id as string, mapId: row.map_id as string,
        characterId: row.character_id as string | null, name: row.name as string,
        x: row.x as number, y: row.y as number, size: row.size as number,
        imageUrl: row.image_url as string | null, color: row.color as string,
        layer: row.layer as Token['layer'], visible: Boolean(row.visible),
        hasLight: Boolean(row.has_light), lightRadius: row.light_radius as number,
        lightDimRadius: row.light_dim_radius as number, lightColor: row.light_color as string,
        conditions: JSON.parse(row.conditions as string), ownerUserId: row.owner_user_id as string | null,
        createdAt: row.created_at as string,
      };
    }

    if (ctx.room.gameMode === 'combat' && ctx.player.role !== 'dm') {
      if (token.ownerUserId !== ctx.player.userId) return;
    }
    if (ctx.room.gameMode === 'free-roam' && ctx.player.role !== 'dm') {
      if (token.ownerUserId !== ctx.player.userId) return;
    }

    const oldX = token.x;
    const oldY = token.y;

    if (ctx.room.tokens.has(tokenId)) { token.x = x; token.y = y; }

    await pool.query('UPDATE tokens SET x = $1, y = $2 WHERE id = $3', [x, y, tokenId]);

    const recipients = socketsOnMap(ctx.room, token.mapId);
    for (const sid of recipients) {
      io.to(sid).emit('map:token-moved', { tokenId, x, y, mapId: token.mapId });
    }

    if (ctx.room.combatState?.active) {
      const opportunities = OpportunityAttackService.detectOpportunityAttacks(ctx.room.sessionId, tokenId, oldX, oldY, x, y);
      for (const opp of opportunities) {
        const targetOwnerId = opp.attackerOwnerUserId;
        const sentToSocketIds = new Set<string>();
        for (const player of ctx.room.players.values()) {
          const isDM = player.role === 'dm';
          const isAttackerOwner = targetOwnerId && player.userId === targetOwnerId;
          let shouldSend = false;
          if (targetOwnerId) { if (isAttackerOwner || isDM) shouldSend = true; }
          else { if (isDM) shouldSend = true; }
          if (shouldSend && !sentToSocketIds.has(player.socketId)) {
            io.to(player.socketId).emit('combat:oa-opportunity', opp);
            sentToSocketIds.add(player.socketId);
          }
        }
      }
    }
  });

  socket.on('map:token-add', async (data) => {
    const parsed = tokenAddSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    if (ctx.player.role !== 'dm') {
      const ownerUserId = parsed.data.ownerUserId;
      const isOwnToken = ownerUserId && ownerUserId === ctx.player.userId;
      const isLootDrop = parsed.data.layer === 'token' && parsed.data.size === 0.5;
      if (!isOwnToken && !isLootDrop) return;
    }

    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const tokenId = uuidv4();
    const now = new Date().toISOString();

    const token: Token = {
      id: tokenId, mapId: targetMapId, characterId: parsed.data.characterId ?? null,
      name: parsed.data.name, x: parsed.data.x, y: parsed.data.y, size: parsed.data.size,
      imageUrl: parsed.data.imageUrl ?? null, color: parsed.data.color,
      layer: parsed.data.layer, visible: parsed.data.visible,
      hasLight: parsed.data.hasLight, lightRadius: parsed.data.lightRadius,
      lightDimRadius: parsed.data.lightDimRadius, lightColor: parsed.data.lightColor,
      conditions: parsed.data.conditions as Token['conditions'],
      ownerUserId: parsed.data.ownerUserId ?? null, createdAt: now,
    };

    if (targetMapId === ctx.room.playerMapId) ctx.room.tokens.set(tokenId, token);

    await pool.query(`
      INSERT INTO tokens (
        id, map_id, character_id, name, x, y, size, image_url, color, layer,
        visible, has_light, light_radius, light_dim_radius, light_color,
        conditions, owner_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `, [
      tokenId, token.mapId, token.characterId, token.name,
      token.x, token.y, token.size, token.imageUrl, token.color, token.layer,
      token.visible ? 1 : 0, token.hasLight ? 1 : 0,
      token.lightRadius, token.lightDimRadius, token.lightColor,
      JSON.stringify(token.conditions), token.ownerUserId,
    ]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:token-added', token);
  });

  socket.on('map:token-remove', async (data) => {
    const parsed = tokenRemoveSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { tokenId } = parsed.data;

    let tokenMapId: string | null = null;
    const inMem = ctx.room.tokens.get(tokenId);
    if (inMem) { tokenMapId = inMem.mapId; ctx.room.tokens.delete(tokenId); }
    else {
      const { rows } = await pool.query(
        'SELECT t.map_id FROM tokens t JOIN maps m ON t.map_id = m.id WHERE t.id = $1 AND m.session_id = $2',
        [tokenId, ctx.room.sessionId],
      );
      if (rows[0]) tokenMapId = rows[0].map_id;
      else return;
    }

    await pool.query('DELETE FROM tokens WHERE id = $1', [tokenId]);

    if (tokenMapId) {
      const recipients = socketsOnMap(ctx.room, tokenMapId);
      for (const sid of recipients) io.to(sid).emit('map:token-removed', { tokenId, mapId: tokenMapId });
    } else {
      io.to(ctx.room.sessionId).emit('map:token-removed', { tokenId });
    }
  });

  socket.on('map:token-update', async (data) => {
    const parsed = tokenUpdateSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId, changes } = parsed.data;
    let token = ctx.room.tokens.get(tokenId);
    let tokenMapId: string | null = null;
    if (token) { tokenMapId = token.mapId; }
    else {
      const { rows } = await pool.query(
        'SELECT t.* FROM tokens t JOIN maps m ON t.map_id = m.id WHERE t.id = $1 AND m.session_id = $2',
        [tokenId, ctx.room.sessionId],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return;
      tokenMapId = row.map_id as string;
      token = {
        id: row.id as string, mapId: row.map_id as string,
        characterId: row.character_id as string | null, name: row.name as string,
        x: row.x as number, y: row.y as number, size: row.size as number,
        imageUrl: row.image_url as string | null, color: row.color as string,
        layer: row.layer as Token['layer'], visible: Boolean(row.visible),
        hasLight: Boolean(row.has_light), lightRadius: row.light_radius as number,
        lightDimRadius: row.light_dim_radius as number, lightColor: row.light_color as string,
        conditions: JSON.parse(row.conditions as string), ownerUserId: row.owner_user_id as string | null,
        createdAt: row.created_at as string,
      };
    }

    const isDM = ctx.player.role === 'dm';
    const isOwner = token.ownerUserId === ctx.player.userId;
    if (!isDM) {
      if (isOwner && changes.conditions !== undefined) return;
      if (!isOwner) {
        const isUnownedNpc = token.ownerUserId === null;
        const allowedFields = new Set(['x', 'y', 'conditions']);
        const onlyGameStateChanges = Object.keys(changes).every((k) => allowedFields.has(k));
        if (!isUnownedNpc || !onlyGameStateChanges) return;
      }
    }

    if (ctx.room.tokens.has(tokenId)) Object.assign(token, changes);

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (changes.name !== undefined) { setClauses.push(`name = $${paramIdx++}`); params.push(changes.name); }
    if (changes.x !== undefined) { setClauses.push(`x = $${paramIdx++}`); params.push(changes.x); }
    if (changes.y !== undefined) { setClauses.push(`y = $${paramIdx++}`); params.push(changes.y); }
    if (changes.size !== undefined) { setClauses.push(`size = $${paramIdx++}`); params.push(changes.size); }
    if (changes.imageUrl !== undefined) { setClauses.push(`image_url = $${paramIdx++}`); params.push(changes.imageUrl); }
    if (changes.color !== undefined) { setClauses.push(`color = $${paramIdx++}`); params.push(changes.color); }
    if (changes.layer !== undefined) { setClauses.push(`layer = $${paramIdx++}`); params.push(changes.layer); }
    if (changes.visible !== undefined) { setClauses.push(`visible = $${paramIdx++}`); params.push(changes.visible ? 1 : 0); }
    if (changes.hasLight !== undefined) { setClauses.push(`has_light = $${paramIdx++}`); params.push(changes.hasLight ? 1 : 0); }
    if (changes.lightRadius !== undefined) { setClauses.push(`light_radius = $${paramIdx++}`); params.push(changes.lightRadius); }
    if (changes.lightDimRadius !== undefined) { setClauses.push(`light_dim_radius = $${paramIdx++}`); params.push(changes.lightDimRadius); }
    if (changes.lightColor !== undefined) { setClauses.push(`light_color = $${paramIdx++}`); params.push(changes.lightColor); }
    if (changes.conditions !== undefined) { setClauses.push(`conditions = $${paramIdx++}`); params.push(JSON.stringify(changes.conditions)); }
    if (changes.ownerUserId !== undefined) { setClauses.push(`owner_user_id = $${paramIdx++}`); params.push(changes.ownerUserId); }

    if (setClauses.length > 0) {
      params.push(tokenId);
      await pool.query(`UPDATE tokens SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, params);
    }

    if (tokenMapId) {
      const recipients = socketsOnMap(ctx.room, tokenMapId);
      for (const sid of recipients) io.to(sid).emit('map:token-updated', { tokenId, changes, mapId: tokenMapId });
    } else {
      io.to(ctx.room.sessionId).emit('map:token-updated', { tokenId, changes });
    }
  });

  socket.on('map:fog-reveal', async (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT fog_state FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    const fogState: FogPolygon[] = JSON.parse(rows[0].fog_state);
    fogState.push({ points: parsed.data.points });

    await pool.query('UPDATE maps SET fog_state = $1 WHERE id = $2', [JSON.stringify(fogState), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
  });

  socket.on('map:fog-hide', async (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT fog_state FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    let fogState: FogPolygon[] = JSON.parse(rows[0].fog_state);
    const targetPoints = JSON.stringify(parsed.data.points);
    fogState = fogState.filter(f => JSON.stringify(f.points) !== targetPoints);

    await pool.query('UPDATE maps SET fog_state = $1 WHERE id = $2', [JSON.stringify(fogState), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
  });

  socket.on('map:wall-add', async (data) => {
    const parsed = wallAddSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT walls FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    const walls: WallSegment[] = JSON.parse(rows[0].walls);
    walls.push(parsed.data);

    await pool.query('UPDATE maps SET walls = $1 WHERE id = $2', [JSON.stringify(walls), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
  });

  socket.on('map:wall-remove', async (data) => {
    const parsed = wallRemoveSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT walls FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    const walls: WallSegment[] = JSON.parse(rows[0].walls);
    if (parsed.data.index < 0 || parsed.data.index >= walls.length) return;
    walls.splice(parsed.data.index, 1);

    await pool.query('UPDATE maps SET walls = $1 WHERE id = $2', [JSON.stringify(walls), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
  });

  socket.on('map:ping', (data) => {
    const parsed = mapPingSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    io.to(ctx.room.sessionId).emit('map:pinged', {
      x: parsed.data.x, y: parsed.data.y,
      userId: ctx.player.userId, displayName: ctx.player.displayName, timestamp: Date.now(),
    });
  });
}
