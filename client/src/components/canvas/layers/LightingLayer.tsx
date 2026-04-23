import { useMemo } from 'react';
import { Group, Rect, Shape, Circle, Ring } from 'react-konva';
import type { Token } from '@dnd-vtt/shared';
import { computeVisibilityPolygon } from '@dnd-vtt/shared';
import { useMapStore } from '../../../stores/useMapStore';
import { useSessionStore } from '../../../stores/useSessionStore';

interface LightingLayerProps {
  mapWidth: number;
  mapHeight: number;
}

/** Warm torch-like colors for mundane light sources. Hot near the
 *  source, gentle warm glow at the dim edge. */
const TORCH_GRADIENT_INNER = 'rgba(255, 230, 170, 0.55)';
const TORCH_GRADIENT_OUTER = 'rgba(255, 190, 120, 0.08)';

/** Magical lights. Prior mix was too aggressively blue and read as a
 *  tinted circle rather than "illumination". Lean into a near-white
 *  core with a faint lavender halo — the color still reads as arcane
 *  but the lit area actually looks lit, not blue-filtered. */
const MAGIC_GRADIENT_INNER = 'rgba(245, 240, 255, 0.55)';
const MAGIC_GRADIENT_OUTER = 'rgba(180, 190, 230, 0.08)';

/** Default darkness overlay alpha */
const DARKNESS_ALPHA = 0.85;

/** Detect if a light color looks "cool" (blue/purple) vs "warm" (yellow/red/white) */
function isMagicLight(color: string): boolean {
  if (!color) return false;
  const lc = color.toLowerCase();
  // Named-color shortcuts
  if (
    lc.includes('blue') ||
    lc.includes('cyan') ||
    lc.includes('purple') ||
    lc.includes('violet') ||
    lc.includes('magenta')
  ) return true;
  // Hex: #RRGGBB — treat as "magic" when the blue channel clearly
  // dominates the red channel (cool hue). This correctly flags light
  // colors like #8cb4ff, #3498db, #6699ff, #9b59b6 (purple) as magic,
  // while torch yellows like #ffcc44 and warm whites stay mundane.
  const hex = lc.replace(/[^0-9a-f]/g, '');
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (b > r + 20 && b >= g - 40) return true;
  }
  return false;
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
    <Group listening={false}>
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
    </Group>
  );
}

/**
 * Cuts the bright and dim light visibility polygons from the darkness overlay.
 */
function LightCutout({ light }: { light: ComputedLight }) {
  // Erase strengths tuned so bright reads as ~95% clear and dim reads
  // as a distinct mid-tier (~55% clear). The prior 0.9 / 0.4 pair left
  // bright not quite white-out and dim indistinguishable from
  // unlit-but-previously-seen territory. With 0.98 / 0.55 there's a
  // clear three-tier ladder: bright ≫ dim ≫ unlit.
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
            ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
          }}
          listening={false}
        />
      )}

      {/* Bright light area: near-full cut */}
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
            ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
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
    <>
      {/* Dim halo tint — gives the dim ring a warm wash instead of
       *  leaving it as plain grey partially-erased darkness. Renders
       *  FIRST so the bright tint sits on top and stays dominant
       *  inside its own polygon. */}
      {light.dimPoly.length >= 6 && (
        <Shape
          sceneFunc={(ctx) => {
            const cx = light.token.x;
            const cy = light.token.y;
            const radius = light.token.lightDimRadius;
            if (radius <= 0) return;

            ctx.beginPath();
            ctx.moveTo(light.dimPoly[0], light.dimPoly[1]);
            for (let i = 2; i < light.dimPoly.length; i += 2) {
              ctx.lineTo(light.dimPoly[i], light.dimPoly[i + 1]);
            }
            ctx.closePath();

            // Dim-only glow: starts transparent at the bright radius,
            // adds a faint warm/cool wash as it approaches the dim edge,
            // then fades out entirely. Using a radial gradient that's
            // clipped to the dim polygon gets us the softness without
            // bleeding past walls.
            const innerRatio = Math.min(
              0.99,
              Math.max(0, light.token.lightRadius / radius),
            );
            const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            gradient.addColorStop(0, 'rgba(0,0,0,0)');
            gradient.addColorStop(innerRatio, 'rgba(0,0,0,0)');
            gradient.addColorStop(Math.min(1, innerRatio + 0.15), outerColor);
            gradient.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.fillStyle = gradient;
            ctx.fill();
          }}
          listening={false}
        />
      )}

      {/* Bright tint — radial gradient inside the bright polygon. */}
      <Shape
        sceneFunc={(ctx) => {
          const cx = light.token.x;
          const cy = light.token.y;
          const radius = light.token.lightRadius;

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
    </>
  );
}

/**
 * DM-only indicator rings showing light source radius at a glance.
 */
function LightIndicator({ light }: { light: ComputedLight }) {
  const { token } = light;
  // Indicator rings were previously opaque-enough to read as part of
  // the lighting itself (a visible blue circle) rather than a DM
  // overlay. Dropped stroke alpha + widened the dash so the rings
  // read as faint scaffolding, not as the light's silhouette.
  const ringStroke = light.isMagic
    ? 'rgba(210, 220, 255, 0.18)'
    : 'rgba(255, 220, 160, 0.22)';
  const dimRingStroke = light.isMagic
    ? 'rgba(210, 220, 255, 0.08)'
    : 'rgba(255, 220, 160, 0.10)';

  return (
    <>
      {/* Bright radius indicator */}
      <Circle
        x={token.x}
        y={token.y}
        radius={token.lightRadius}
        stroke={ringStroke}
        strokeWidth={1}
        dash={[3, 6]}
        listening={false}
      />
      {/* Dim ring fill — keep it subtle so it doesn't compete with the
       *  radial-gradient tint above. */}
      <Ring
        x={token.x}
        y={token.y}
        innerRadius={token.lightRadius}
        outerRadius={token.lightDimRadius}
        fill={light.isMagic ? 'rgba(210, 220, 255, 0.03)' : 'rgba(255, 220, 160, 0.03)'}
        listening={false}
      />
      <Circle
        x={token.x}
        y={token.y}
        radius={token.lightDimRadius}
        stroke={dimRingStroke}
        strokeWidth={1}
        dash={[3, 8]}
        listening={false}
      />
    </>
  );
}
