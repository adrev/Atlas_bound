import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { getPlayerBySocketId } from '../utils/roomState.js';
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
    ctx.room.tokens.clear();
    for (const token of tokens) {
      ctx.room.tokens.set(token.id, token);
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

    io.to(ctx.room.sessionId).emit('map:loaded', { map: mapData, tokens });
  });

  socket.on('map:token-move', (data) => {
    const parsed = tokenMoveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId, x, y } = parsed.data;
    const token = ctx.room.tokens.get(tokenId);
    if (!token) return;

    // Validate ownership: in combat, players can only move their own tokens
    if (ctx.room.gameMode === 'combat' && ctx.player.role !== 'dm') {
      if (token.ownerUserId !== ctx.player.userId) return;
    }
    // In free-roam, only DM or token owner can move
    if (ctx.room.gameMode === 'free-roam' && ctx.player.role !== 'dm') {
      if (token.ownerUserId !== ctx.player.userId) return;
    }

    // Update in memory
    token.x = x;
    token.y = y;

    // Persist to DB
    db.prepare('UPDATE tokens SET x = ?, y = ? WHERE id = ?').run(x, y, tokenId);

    // Broadcast to room
    io.to(ctx.room.sessionId).emit('map:token-moved', { tokenId, x, y });
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

    if (!ctx.room.currentMapId) return;

    const tokenId = uuidv4();
    const now = new Date().toISOString();

    const token: Token = {
      id: tokenId,
      mapId: ctx.room.currentMapId,
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

    // Store in memory
    ctx.room.tokens.set(tokenId, token);

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

    io.to(ctx.room.sessionId).emit('map:token-added', token);
  });

  socket.on('map:token-remove', (data) => {
    const parsed = tokenRemoveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { tokenId } = parsed.data;
    ctx.room.tokens.delete(tokenId);
    db.prepare('DELETE FROM tokens WHERE id = ?').run(tokenId);

    io.to(ctx.room.sessionId).emit('map:token-removed', { tokenId });
  });

  socket.on('map:token-update', (data) => {
    const parsed = tokenUpdateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId, changes } = parsed.data;
    const token = ctx.room.tokens.get(tokenId);
    if (!token) return;

    // Only DM or token owner can update
    if (ctx.player.role !== 'dm' && token.ownerUserId !== ctx.player.userId) return;

    // Apply changes in memory
    Object.assign(token, changes);

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

    io.to(ctx.room.sessionId).emit('map:token-updated', { tokenId, changes });
  });

  socket.on('map:fog-reveal', (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm' || !ctx.room.currentMapId) return;

    // Get current fog state
    const mapRow = db.prepare('SELECT fog_state FROM maps WHERE id = ?').get(ctx.room.currentMapId) as { fog_state: string } | undefined;
    if (!mapRow) return;

    const fogState: FogPolygon[] = JSON.parse(mapRow.fog_state);
    fogState.push({ points: parsed.data.points });

    db.prepare('UPDATE maps SET fog_state = ? WHERE id = ?')
      .run(JSON.stringify(fogState), ctx.room.currentMapId);

    io.to(ctx.room.sessionId).emit('map:fog-updated', { fogState });
  });

  socket.on('map:fog-hide', (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm' || !ctx.room.currentMapId) return;

    const mapRow = db.prepare('SELECT fog_state FROM maps WHERE id = ?').get(ctx.room.currentMapId) as { fog_state: string } | undefined;
    if (!mapRow) return;

    let fogState: FogPolygon[] = JSON.parse(mapRow.fog_state);
    // Remove the matching polygon (by comparing points arrays)
    const targetPoints = JSON.stringify(parsed.data.points);
    fogState = fogState.filter(f => JSON.stringify(f.points) !== targetPoints);

    db.prepare('UPDATE maps SET fog_state = ? WHERE id = ?')
      .run(JSON.stringify(fogState), ctx.room.currentMapId);

    io.to(ctx.room.sessionId).emit('map:fog-updated', { fogState });
  });

  socket.on('map:wall-add', (data) => {
    const parsed = wallAddSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm' || !ctx.room.currentMapId) return;

    const mapRow = db.prepare('SELECT walls FROM maps WHERE id = ?').get(ctx.room.currentMapId) as { walls: string } | undefined;
    if (!mapRow) return;

    const walls: WallSegment[] = JSON.parse(mapRow.walls);
    walls.push(parsed.data);

    db.prepare('UPDATE maps SET walls = ? WHERE id = ?')
      .run(JSON.stringify(walls), ctx.room.currentMapId);

    io.to(ctx.room.sessionId).emit('map:walls-updated', { walls });
  });

  socket.on('map:wall-remove', (data) => {
    const parsed = wallRemoveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm' || !ctx.room.currentMapId) return;

    const mapRow = db.prepare('SELECT walls FROM maps WHERE id = ?').get(ctx.room.currentMapId) as { walls: string } | undefined;
    if (!mapRow) return;

    const walls: WallSegment[] = JSON.parse(mapRow.walls);
    if (parsed.data.index < 0 || parsed.data.index >= walls.length) return;
    walls.splice(parsed.data.index, 1);

    db.prepare('UPDATE maps SET walls = ? WHERE id = ?')
      .run(JSON.stringify(walls), ctx.room.currentMapId);

    io.to(ctx.room.sessionId).emit('map:walls-updated', { walls });
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
