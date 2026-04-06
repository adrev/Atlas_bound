import { useMemo } from 'react';
import { Layer, Rect, Shape, Circle, Ring } from 'react-konva';
import type { Token } from '@dnd-vtt/shared';
import { computeVisibilityPolygon } from '@dnd-vtt/shared';
import { useMapStore } from '../../../stores/useMapStore';
import { useSessionStore } from '../../../stores/useSessionStore';

interface LightingLayerProps {
  mapWidth: number;
  mapHeight: number;
}

/** Warm torch-like colors for mundane light sources */
const TORCH_GRADIENT_INNER = 'rgba(255, 200, 100, 0.6)';
const TORCH_GRADIENT_OUTER = 'rgba(255, 160, 50, 0.15)';

/** Cool blue-tinged colors for magical light sources */
const MAGIC_GRADIENT_INNER = 'rgba(140, 180, 255, 0.5)';
const MAGIC_GRADIENT_OUTER = 'rgba(80, 120, 220, 0.12)';

/** Default darkness overlay alpha */
const DARKNESS_ALPHA = 0.85;

/** Detect if a light color looks "cool" (blue/purple) vs "warm" (yellow/red/white) */
function isMagicLight(color: string): boolean {
  // Simple heuristic: blues and purples are magic, everything else is torch
  const lc = color.toLowerCase();
  return (
    lc.includes('blue') ||
    lc.includes('#00') ||
    lc.includes('#33') ||
    lc.includes('cyan') ||
    lc.includes('purple') ||
    lc.includes('violet') ||
    lc === '#3498db' ||
    lc === '#9b59b6'
  );
}

interface ComputedLight {
  token: Token;
  brightPoly: number[];
  dimPoly: number[];
  isMagic: boolean;
}

/**
 * LightingLayer provides dynamic lighting based on token light sources and walls.
 *
 * Rendering approach:
 * 1. A full-map darkness overlay is drawn
 * 2. For each light-emitting token, visibility polygons are computed via raycasting
 * 3. Bright light areas are cut from the darkness with 'destination-out'
 * 4. Dim light areas are cut at reduced opacity
 * 5. Colored light tints are drawn on top for atmosphere
 *
 * DM mode: shows all lighting with indicator rings around light sources.
 * Player mode: only shows visibility from the player's own token(s).
 */
export function LightingLayer({ mapWidth, mapHeight }: LightingLayerProps) {
  const tokens = useMapStore((s) => s.tokens);
  const walls = useMapStore((s) => s.walls);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const enableLighting = useSessionStore((s) => s.settings.enableDynamicLighting);

  // Find all tokens that emit light
  const lightTokens = useMemo(() => {
    const all = Object.values(tokens).filter((t) => t.hasLight && t.visible);
    if (isDM) return all;
    // Player mode: only show lights from tokens owned by the player
    // plus all visible light sources (they can see effects of other lights)
    return all;
  }, [tokens, isDM]);

  // Compute visibility polygons for each light source
  const computedLights = useMemo<ComputedLight[]>(() => {
    return lightTokens.map((token) => {
      const origin = { x: token.x, y: token.y };
      const brightPoly = computeVisibilityPolygon(origin, walls, token.lightRadius);
      const dimPoly = computeVisibilityPolygon(origin, walls, token.lightDimRadius);
      return {
        token,
        brightPoly,
        dimPoly,
        isMagic: isMagicLight(token.lightColor),
      };
    });
  }, [lightTokens, walls]);

  // In player mode, compute what the player's token(s) can see
  const playerVisibility = useMemo<number[] | null>(() => {
    if (isDM) return null;
    const playerTokens = Object.values(tokens).filter(
      (t) => t.ownerUserId === userId && t.visible
    );
    if (playerTokens.length === 0) return null;

    // Merge visibility of all player tokens (union of visibility polygons)
    // For simplicity, we use the first player token's visibility
    // A proper implementation would union all polygons
    const primary = playerTokens[0];
    const sightRange = primary.hasLight ? primary.lightDimRadius : 300;
    return computeVisibilityPolygon({ x: primary.x, y: primary.y }, walls, sightRange);
  }, [tokens, walls, isDM, userId]);

  if (!enableLighting) return null;

  return (
    <Layer listening={false}>
      {/* Darkness overlay covering the entire map */}
      <Rect
        x={0}
        y={0}
        width={mapWidth}
        height={mapHeight}
        fill={`rgba(0, 0, 0, ${DARKNESS_ALPHA})`}
      />

      {/* Cut out lit areas from the darkness */}
      {computedLights.map((light, idx) => (
        <LightCutout key={`light-${light.token.id}-${idx}`} light={light} />
      ))}

      {/* In player mode, also cut out the player's personal vision */}
      {!isDM && playerVisibility && (
        <VisionCutout points={playerVisibility} alpha={0.7} />
      )}

      {/* Colored light tints for atmosphere (rendered above darkness cuts) */}
      {computedLights.map((light, idx) => (
        <LightTint key={`tint-${light.token.id}-${idx}`} light={light} />
      ))}

      {/* DM mode: indicator rings around light sources */}
      {isDM &&
        computedLights.map((light, idx) => (
          <LightIndicator key={`ind-${light.token.id}-${idx}`} light={light} />
        ))}
    </Layer>
  );
}

/**
 * Cuts the bright and dim light visibility polygons from the darkness overlay.
 */
function LightCutout({ light }: { light: ComputedLight }) {
  return (
    <>
      {/* Dim light area: partial cut (semi-transparent erase) */}
      {light.dimPoly.length >= 6 && (
        <Shape
          sceneFunc={(ctx) => {
            ctx.beginPath();
            ctx.moveTo(light.dimPoly[0], light.dimPoly[1]);
            for (let i = 2; i < light.dimPoly.length; i += 2) {
              ctx.lineTo(light.dimPoly[i], light.dimPoly[i + 1]);
            }
            ctx.closePath();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
          }}
          listening={false}
        />
      )}

      {/* Bright light area: full cut */}
      {light.brightPoly.length >= 6 && (
        <Shape
          sceneFunc={(ctx) => {
            ctx.beginPath();
            ctx.moveTo(light.brightPoly[0], light.brightPoly[1]);
            for (let i = 2; i < light.brightPoly.length; i += 2) {
              ctx.lineTo(light.brightPoly[i], light.brightPoly[i + 1]);
            }
            ctx.closePath();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
          }}
          listening={false}
        />
      )}
    </>
  );
}

/**
 * Cuts a player vision polygon from the darkness so they can see their area.
 */
function VisionCutout({ points, alpha }: { points: number[]; alpha: number }) {
  if (points.length < 6) return null;

  return (
    <Shape
      sceneFunc={(ctx) => {
        ctx.beginPath();
        ctx.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) {
          ctx.lineTo(points[i], points[i + 1]);
        }
        ctx.closePath();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }}
      listening={false}
    />
  );
}

/**
 * Renders a colored tint over the bright light area for atmospheric effect.
 * Uses warm orange for torch/fire and cool blue for magical light.
 */
function LightTint({ light }: { light: ComputedLight }) {
  if (light.brightPoly.length < 6) return null;

  const innerColor = light.isMagic ? MAGIC_GRADIENT_INNER : TORCH_GRADIENT_INNER;
  const outerColor = light.isMagic ? MAGIC_GRADIENT_OUTER : TORCH_GRADIENT_OUTER;

  return (
    <Shape
      sceneFunc={(ctx) => {
        const cx = light.token.x;
        const cy = light.token.y;
        const radius = light.token.lightRadius;

        // Draw the bright polygon with a radial gradient tint
        ctx.beginPath();
        ctx.moveTo(light.brightPoly[0], light.brightPoly[1]);
        for (let i = 2; i < light.brightPoly.length; i += 2) {
          ctx.lineTo(light.brightPoly[i], light.brightPoly[i + 1]);
        }
        ctx.closePath();

        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, innerColor);
        gradient.addColorStop(1, outerColor);

        ctx.fillStyle = gradient;
        ctx.fill();
      }}
      listening={false}
    />
  );
}

/**
 * DM-only indicator rings showing light source radius at a glance.
 */
function LightIndicator({ light }: { light: ComputedLight }) {
  const { token } = light;

  return (
    <>
      {/* Bright radius indicator */}
      <Circle
        x={token.x}
        y={token.y}
        radius={token.lightRadius}
        stroke={light.isMagic ? 'rgba(100, 150, 255, 0.3)' : 'rgba(255, 200, 80, 0.3)'}
        strokeWidth={1}
        dash={[6, 4]}
        listening={false}
      />
      {/* Dim radius indicator */}
      <Ring
        x={token.x}
        y={token.y}
        innerRadius={token.lightRadius}
        outerRadius={token.lightDimRadius}
        fill={light.isMagic ? 'rgba(100, 150, 255, 0.05)' : 'rgba(255, 200, 80, 0.05)'}
        listening={false}
      />
      <Circle
        x={token.x}
        y={token.y}
        radius={token.lightDimRadius}
        stroke={light.isMagic ? 'rgba(100, 150, 255, 0.15)' : 'rgba(255, 200, 80, 0.15)'}
        strokeWidth={1}
        dash={[4, 6]}
        listening={false}
      />
    </>
  );
}
