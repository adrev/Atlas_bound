import type { Token, TokenAura, TokenFaction } from '@dnd-vtt/shared';
import { safeParseJSON } from './safeJson.js';

/**
 * Central DB-row → Token mapper. There were four separate inline
 * mappers scattered across routes/maps.ts, socket/sceneEvents.ts,
 * socket/mapEvents.ts and socket/sessionEvents.ts. Each time a new
 * token field was added (faction, aura, ...) one of them was usually
 * forgotten, leaving clients that hit that particular code path
 * missing the new field.
 *
 * Keeping the shape in one place also means JSON columns (`conditions`,
 * `aura`) all parse through safeParseJSON uniformly — a single corrupt
 * row can't crash one code path while working on another.
 */
export function rowToToken(r: Record<string, unknown>): Token {
  const faction = ((r.faction as string | null) ?? 'neutral') as TokenFaction;
  return {
    id: r.id as string,
    mapId: r.map_id as string,
    characterId: (r.character_id as string | null) ?? null,
    name: r.name as string,
    x: r.x as number,
    y: r.y as number,
    size: r.size as number,
    imageUrl: (r.image_url as string | null) ?? null,
    color: r.color as string,
    layer: r.layer as Token['layer'],
    visible: Boolean(r.visible),
    hasLight: Boolean(r.has_light),
    lightRadius: r.light_radius as number,
    lightDimRadius: r.light_dim_radius as number,
    lightColor: r.light_color as string,
    conditions: safeParseJSON(r.conditions, [], 'tokens.conditions'),
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    faction,
    createdAt: r.created_at as string,
    aura: safeParseJSON<TokenAura | null>(r.aura, null, 'tokens.aura'),
  };
}
