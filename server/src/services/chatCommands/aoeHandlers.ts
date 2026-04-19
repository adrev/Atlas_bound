import type { Drawing, Token } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection.js';
import {
  registerChatCommand,
  whisperToCaller,
  isDM,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * R9 — AoE template chat command. Drops a Drawing at the caller's
 * token (or a named target) sized in feet, for use as an AoE
 * measurement overlay during combat.
 *
 *   !aoe <shape> <size_ft> [color] [target]
 *       shape ∈ circle | square | line | cone
 *       size  = radius (circle/cone) or side-length (square) or
 *               length (line), in feet
 *       color = hex like #ff3b3b (default depends on caller's role)
 *       target = optional token name to anchor at — defaults to the
 *               caller's most recent PC token on this map.
 *
 * Shapes map onto the existing Drawing union:
 *   circle / cone → drawing kind='circle'       (cone is approximated
 *                                                as a circle today;
 *                                                rotation/arc rendering
 *                                                is follow-up work)
 *   square        → drawing kind='rect' centered on anchor
 *   line          → drawing kind='line' pointing east (DM can rotate)
 *
 * AoEs use shared visibility so everyone can see them. They persist
 * (not ephemeral) so the DM can re-use them across rounds; use the
 * drawing toolbar's erase tool to remove. Feet→pixels uses the map's
 * cached grid size (5 ft per cell).
 */

type Shape = 'circle' | 'square' | 'line' | 'cone';

const SHAPE_ALIASES: Record<string, Shape> = {
  circle: 'circle', sphere: 'circle', radius: 'circle',
  square: 'square', cube: 'square', box: 'square',
  line: 'line',
  cone: 'cone',
};

function resolveAnchor(ctx: PlayerContext, name: string): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  if (!name) {
    // Default: caller's PC on current map. DMs calling without a
    // target still need *some* origin; pick any of their tokens or
    // bail out.
    const own = all.filter((t) => t.ownerUserId === ctx.player.userId);
    if (own.length > 0) {
      own.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return own[0];
    }
    return null;
  }
  const needle = name.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

async function handleAoe(c: ChatCommandContext): Promise<boolean> {
  // Only DMs can drop AoEs for others; players can drop AoEs anchored
  // to their own tokens. This matches Roll20's DM-centric AoE workflow
  // while still letting casters preview their spell radius.
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!aoe: usage `!aoe <circle|square|line|cone> <size_ft> [#color] [target]`');
    return true;
  }

  const shapeRaw = parts.shift()!.toLowerCase();
  const shape = SHAPE_ALIASES[shapeRaw];
  if (!shape) {
    whisperToCaller(c.io, c.ctx, `!aoe: unknown shape “${shapeRaw}”. Allowed: circle, square, line, cone.`);
    return true;
  }

  const sizeFt = parseInt(parts.shift()!, 10);
  if (!Number.isFinite(sizeFt) || sizeFt <= 0 || sizeFt > 500) {
    whisperToCaller(c.io, c.ctx, '!aoe: size must be between 1 and 500 feet.');
    return true;
  }

  // Optional color. Accept #rgb / #rrggbb. Anything else is treated as
  // part of the target-name argument that follows.
  let color: string | undefined;
  if (parts.length > 0 && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(parts[0])) {
    color = parts.shift()!;
  }
  if (!color) color = isDM(c.ctx) ? '#c0392b' : '#3498db';

  const targetName = parts.join(' ').trim();
  // Non-DMs can only anchor AoEs to their OWN tokens to prevent abuse
  // (mark a DM-private NPC to reveal its position). DMs can anchor
  // anywhere.
  const anchor = resolveAnchor(c.ctx, targetName);
  if (!anchor) {
    whisperToCaller(c.io, c.ctx, '!aoe: no anchor token found — specify a target or place one of your PCs on the map first.');
    return true;
  }
  if (!isDM(c.ctx) && anchor.ownerUserId !== c.ctx.player.userId) {
    whisperToCaller(c.io, c.ctx, '!aoe: you can only anchor AoEs to your own tokens.');
    return true;
  }

  // Feet → pixels. The map's cached grid size is the pixel span of a
  // single 5ft cell. If the cache is empty (e.g. map wasn't opened
  // via scene:load yet), fall back to the schema default of 70.
  const mapId = anchor.mapId;
  const gridPx = c.ctx.room.mapGridSizes.get(mapId) ?? 70;
  const ftPerCell = 5;
  const pxPerFt = gridPx / ftPerCell;
  const sizePx = sizeFt * pxPerFt;

  let kind: Drawing['kind'];
  let geometry: Drawing['geometry'];
  switch (shape) {
    case 'circle':
    case 'cone':
      // Cone is approximated as a circle for now — the DM can rotate
      // / trim manually with the drawing tools. Full cone geometry is
      // follow-up work that will likely reuse the spell-target system.
      kind = 'circle';
      geometry = { circle: { x: anchor.x, y: anchor.y, radius: sizePx } };
      break;
    case 'square':
      kind = 'rect';
      geometry = {
        rect: {
          x: anchor.x - sizePx / 2,
          y: anchor.y - sizePx / 2,
          width: sizePx,
          height: sizePx,
        },
      };
      break;
    case 'line':
      kind = 'line';
      // Line points east from the anchor. Two endpoints as a flat
      // [x1,y1,x2,y2] matches the Drawing geometry contract.
      geometry = { points: [anchor.x, anchor.y, anchor.x + sizePx, anchor.y] };
      break;
  }

  const drawing: Drawing = {
    id: uuidv4(),
    mapId,
    creatorUserId: c.ctx.player.userId,
    creatorRole: c.ctx.player.role,
    kind,
    visibility: 'shared',
    color,
    strokeWidth: 3,
    geometry,
    gridSnapped: true,
    createdAt: Date.now(),
    fadeAfterMs: null,
  };

  c.ctx.room.drawings.set(drawing.id, drawing);

  try {
    await pool.query(`
      INSERT INTO drawings (
        id, map_id, creator_user_id, creator_role, kind, visibility,
        color, stroke_width, geometry, grid_snapped, created_at, fade_after_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      drawing.id, drawing.mapId, drawing.creatorUserId, drawing.creatorRole,
      drawing.kind, drawing.visibility, drawing.color, drawing.strokeWidth,
      JSON.stringify(drawing.geometry), drawing.gridSnapped ? 1 : 0,
      drawing.createdAt, drawing.fadeAfterMs,
    ]);
  } catch (err) {
    console.warn('[!aoe] DB insert failed:', err);
  }

  // Broadcast to the whole room. Visibility='shared' means everyone
  // on the map sees it — matches the DM-led AoE workflow.
  c.io.to(c.ctx.room.sessionId).emit('drawing:created', drawing);

  whisperToCaller(
    c.io, c.ctx,
    `!aoe: placed ${shape} ${sizeFt}ft at ${anchor.name}. Use the eraser in the draw toolbar to clear.`,
  );
  return true;
}

registerChatCommand('aoe', handleAoe);
