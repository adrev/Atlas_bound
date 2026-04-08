import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon, MapSummary } from '@dnd-vtt/shared';
import db from '../db/connection.js';
import { getPlayerBySocketId } from '../utils/roomState.js';
import {
  mapPreviewLoadSchema, mapActivateForPlayersSchema, mapDeleteSchema,
} from '../utils/validation.js';
import { loadDrawingsForMap, filterDrawingsForPlayer } from './drawingEvents.js';

/**
 * Scene Manager (Player Ribbon / DM preview) handlers.
 *
 * Architecture:
 *   - `room.playerMapId`   → the "yellow ribbon". What the players see.
 *   - `room.dmViewingMap`  → per-DM ephemeral preview cursor. When a DM
 *                             previews a map, they get a private copy of
 *                             the map, tokens, walls, fog, and drawings
 *                             WITHOUT touching the ribbon.
 *   - `room.currentMapId`  → deprecated, kept as a fallback hint for
 *                             DM rehydration on refresh.
 *
 * All four handlers are DM-only EXCEPT `map:list` which any player can
 * request (the scene manager sidebar is DM-only in the UI but we leave
 * the fetch open so a player tool can request it harmlessly).
 */
export function registerSceneEvents(io: Server, socket: Socket): void {

  // ── map:list ──────────────────────────────────────────────────────
  // Returns every map in this session with the ribbon flag already
  // computed. DMs use this for the Scene Manager sidebar.
  socket.on('map:list', () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const rows = db.prepare(`
      SELECT m.id, m.name, m.image_url, m.width, m.height, m.grid_size, m.created_at,
             (SELECT COUNT(*) FROM tokens t WHERE t.map_id = m.id) AS token_count
      FROM maps m
      WHERE m.session_id = ?
      ORDER BY m.created_at ASC
    `).all(ctx.room.sessionId) as Array<Record<string, unknown>>;

    const maps: MapSummary[] = rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      imageUrl: r.image_url as string | null,
      width: r.width as number,
      height: r.height as number,
      gridSize: r.grid_size as number,
      tokenCount: (r.token_count as number) ?? 0,
      createdAt: r.created_at as string,
      isPlayerMap: (r.id as string) === ctx.room.playerMapId,
    }));

    console.log(`[SCENE] map:list → ${maps.length} maps, ribbon=${ctx.room.playerMapId ?? 'null'}`);
    socket.emit('map:list-result', {
      maps,
      playerMapId: ctx.room.playerMapId,
    });
  });

  // ── map:preview-load ──────────────────────────────────────────────
  // DM-only. Load a map into the DM's private view WITHOUT touching
  // the player ribbon. The server emits `map:loaded` with isPreview=true
  // to ONLY the requesting socket. No other clients see anything.
  socket.on('map:preview-load', (data) => {
    const parsed = mapPreviewLoadSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { mapId } = parsed.data;
    const mapRow = db.prepare('SELECT * FROM maps WHERE id = ? AND session_id = ?')
      .get(mapId, ctx.room.sessionId) as Record<string, unknown> | undefined;
    if (!mapRow) {
      socket.emit('session:error', { message: 'Map not found in this session' });
      return;
    }

    // Record this DM's ephemeral preview cursor so subsequent token /
    // wall / fog / drawing edits know which map to target.
    ctx.room.dmViewingMap.set(ctx.player.userId, mapId);
    // Also persist to sessions.current_map_id as a fallback hint for
    // DM rehydration on refresh (legacy column, repurposed).
    try {
      db.prepare('UPDATE sessions SET current_map_id = ? WHERE id = ?')
        .run(mapId, ctx.room.sessionId);
    } catch { /* ignore */ }

    const tokenRows = db.prepare('SELECT * FROM tokens WHERE map_id = ?')
      .all(mapId) as Array<Record<string, unknown>>;
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

    const drawings = loadDrawingsForMap(mapId);
    const visibleDrawings = filterDrawingsForPlayer(drawings, ctx.player);

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

    // Emit ONLY to the requesting socket. Crucially do NOT broadcast.
    socket.emit('map:loaded', {
      map: mapData,
      tokens,
      drawings: visibleDrawings,
      isPreview: true,
    });
  });

  // ── map:activate-for-players ──────────────────────────────────────
  // DM-only. Move the player ribbon to a new map. Broadcasts `map:loaded`
  // to every player (and every DM who isn't already viewing it) so their
  // canvases switch. Also emits a lightweight `map:player-map-changed`
  // ping so scene manager sidebars can update the ribbon indicator.
  socket.on('map:activate-for-players', (data) => {
    console.log('[SCENE] map:activate-for-players received', data);
    const parsed = mapActivateForPlayersSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[SCENE] validation failed', parsed.error.issues);
      return;
    }

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) {
      console.warn('[SCENE] no ctx for socket', socket.id);
      return;
    }
    if (ctx.player.role !== 'dm') {
      console.warn('[SCENE] non-DM tried to activate', ctx.player.userId);
      return;
    }

    const { mapId } = parsed.data;
    const mapRow = db.prepare('SELECT * FROM maps WHERE id = ? AND session_id = ?')
      .get(mapId, ctx.room.sessionId) as Record<string, unknown> | undefined;
    if (!mapRow) {
      console.warn('[SCENE] map not found', mapId, 'in session', ctx.room.sessionId);
      socket.emit('session:error', { message: 'Map not found in this session' });
      return;
    }
    console.log(`[SCENE] activating map ${mapRow.name} (${mapId}) for ${ctx.room.players.size} players`);

    // Capture the old ribbon map so we can migrate player character
    // tokens from it to the new map. Without this, the PC tokens get
    // "stranded" on the old map and players arrive at an empty scene.
    const oldPlayerMapId = ctx.room.playerMapId;

    // Move the ribbon in memory and persist it.
    ctx.room.playerMapId = mapId;
    ctx.room.currentMapId = mapId;
    try {
      db.prepare('UPDATE sessions SET player_map_id = ?, current_map_id = ? WHERE id = ?')
        .run(mapId, mapId, ctx.room.sessionId);
    } catch { /* ignore */ }

    // ── Migrate player character tokens ──────────────────────────
    // When the DM moves the ribbon, the party's tokens should follow.
    // Find every player-owned character token on the OLD ribbon map
    // and move it to the new one. Skip any PC that ALREADY has a
    // token on the new map (the DM may have pre-placed it there
    // manually, and we don't want to stomp that).
    //
    // NPCs, monsters, effects, and loot drops are NOT migrated —
    // those are scene-specific. This mirrors Roll20's behavior: the
    // party travels, the encounter doesn't.
    if (oldPlayerMapId && oldPlayerMapId !== mapId) {
      const pcTokens = db.prepare(`
        SELECT id, character_id FROM tokens
        WHERE map_id = ?
          AND character_id IS NOT NULL
          AND owner_user_id IS NOT NULL
      `).all(oldPlayerMapId) as Array<{ id: string; character_id: string }>;

      if (pcTokens.length > 0) {
        const gridSize = (mapRow.grid_size as number) ?? 70;
        const mapWidth = (mapRow.width as number) ?? 1400;
        const mapHeight = (mapRow.height as number) ?? 1050;
        const alreadyOnNewMap = db.prepare(`
          SELECT character_id FROM tokens
          WHERE map_id = ? AND character_id IS NOT NULL
        `).all(mapId) as Array<{ character_id: string }>;
        const existingCharacterIds = new Set(alreadyOnNewMap.map(r => r.character_id));

        // Spawn PCs in a horizontal line centered on the map. This
        // puts them in the middle of the visible viewport (the default
        // camera focuses on the map center), so the DM sees the party
        // immediately after activating the new map. Spawning in the
        // top-left corner made them invisible at typical zoom levels.
        const pcsToMigrate = pcTokens.filter(pc => !existingCharacterIds.has(pc.character_id));
        const lineWidth = pcsToMigrate.length * gridSize;
        const startX = Math.round((mapWidth - lineWidth) / 2);
        const centerY = Math.round(mapHeight / 2);

        let spawnIndex = 0;
        for (const pc of pcsToMigrate) {
          const x = startX + spawnIndex * gridSize;
          const y = centerY;
          db.prepare('UPDATE tokens SET map_id = ?, x = ?, y = ? WHERE id = ?')
            .run(mapId, x, y, pc.id);
          spawnIndex++;
        }
        if (spawnIndex > 0) {
          console.log(`[SCENE] migrated ${spawnIndex} PC token${spawnIndex !== 1 ? 's' : ''} from ${oldPlayerMapId} → ${mapId} @ (${startX}, ${centerY})`);
        }
      }
    }

    // Load tokens + drawings for the new ribbon map into the room
    // memory so the canonical `room.tokens` / `room.drawings` match
    // what the players are actually seeing. NOTE: this happens AFTER
    // the PC migration above so the new rows are included.
    const tokenRows = db.prepare('SELECT * FROM tokens WHERE map_id = ?')
      .all(mapId) as Array<Record<string, unknown>>;
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
    ctx.room.tokens.clear();
    for (const t of tokens) ctx.room.tokens.set(t.id, t);

    const drawings = loadDrawingsForMap(mapId);
    ctx.room.drawings.clear();
    for (const d of drawings) ctx.room.drawings.set(d.id, d);

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

    // Per-player emit so each client only gets drawings they can see.
    // Players ALWAYS receive this; DMs only receive it if they weren't
    // already previewing something else (we don't want to yank a DM
    // out of their in-progress prep).
    for (const player of ctx.room.players.values()) {
      if (player.role === 'dm') {
        const dmViewing = ctx.room.dmViewingMap.get(player.userId);
        // If this DM is previewing a DIFFERENT map, don't pull them
        // back. Their scene manager sidebar will still update via
        // `map:player-map-changed` below.
        if (dmViewing && dmViewing !== mapId) continue;
        // If this DM is the one who activated (or they're on this
        // map already), clear their preview cursor — they're back on
        // the ribbon now.
        ctx.room.dmViewingMap.delete(player.userId);
      }
      const visibleDrawings = filterDrawingsForPlayer(drawings, player);
      io.to(player.socketId).emit('map:loaded', {
        map: mapData,
        tokens,
        drawings: visibleDrawings,
        isPreview: false,
      });
    }

    // Lightweight ribbon-moved ping to every client (so scene manager
    // sidebars can update the yellow indicator without a list re-fetch).
    io.to(ctx.room.sessionId).emit('map:player-map-changed', { mapId });
  });

  // ── map:delete ────────────────────────────────────────────────────
  // DM-only. Removes a map from the session library. Refuses if it's
  // currently the player ribbon (DM must move the ribbon first).
  socket.on('map:delete', (data) => {
    const parsed = mapDeleteSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { mapId } = parsed.data;

    // Safety: don't let the DM delete the map the players are on.
    if (ctx.room.playerMapId === mapId) {
      socket.emit('session:error', {
        message: 'Cannot delete the map the players are currently on. Move the player ribbon to another map first.',
      });
      return;
    }

    const mapRow = db.prepare('SELECT id FROM maps WHERE id = ? AND session_id = ?')
      .get(mapId, ctx.room.sessionId) as { id: string } | undefined;
    if (!mapRow) {
      socket.emit('session:error', { message: 'Map not found in this session' });
      return;
    }

    // FK cascade removes tokens + drawings automatically. walls + fog
    // are columns on the map row so they go with the DELETE.
    try {
      db.prepare('DELETE FROM maps WHERE id = ?').run(mapId);
    } catch (err) {
      console.warn('[map:delete] DB delete failed:', err);
      socket.emit('session:error', { message: 'Failed to delete map' });
      return;
    }

    // Clear any DM preview cursors that were pointing at this map —
    // they're invalid now. Those DMs will fall back to the ribbon.
    for (const [userId, viewing] of Array.from(ctx.room.dmViewingMap.entries())) {
      if (viewing === mapId) ctx.room.dmViewingMap.delete(userId);
    }

    // Re-broadcast the updated map list to every DM in the room so
    // their Scene Manager sidebars drop the deleted card. Players
    // don't see the scene manager so they don't need the update.
    const rows = db.prepare(`
      SELECT m.id, m.name, m.image_url, m.width, m.height, m.grid_size, m.created_at,
             (SELECT COUNT(*) FROM tokens t WHERE t.map_id = m.id) AS token_count
      FROM maps m
      WHERE m.session_id = ?
      ORDER BY m.created_at ASC
    `).all(ctx.room.sessionId) as Array<Record<string, unknown>>;

    const maps: MapSummary[] = rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      imageUrl: r.image_url as string | null,
      width: r.width as number,
      height: r.height as number,
      gridSize: r.grid_size as number,
      tokenCount: (r.token_count as number) ?? 0,
      createdAt: r.created_at as string,
      isPlayerMap: (r.id as string) === ctx.room.playerMapId,
    }));

    for (const player of ctx.room.players.values()) {
      if (player.role !== 'dm') continue;
      io.to(player.socketId).emit('map:list-result', {
        maps,
        playerMapId: ctx.room.playerMapId,
      });
    }
  });
}
