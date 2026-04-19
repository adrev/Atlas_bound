import { useMemo, useRef } from 'react';
import { Group, Rect, Shape } from 'react-konva';
import { useMapStore } from '../../../stores/useMapStore';
import { useSessionStore } from '../../../stores/useSessionStore';

interface FogLayerProps {
  mapWidth: number;
  mapHeight: number;
}

/**
 * Vision-based Fog of War (BG3 style):
 * - GM never sees fog — always has full map visibility
 * - Players see fog everywhere EXCEPT around hero tokens they own
 *   AND around any visible lit tokens (torches, Light spell, etc.)
 * - Fog auto-reveals in a radius around each player's token
 * - Lit objects also reveal the fog around them so players can see
 *   what a torch or Light spell illuminates
 * - No manual fog painting needed
 *
 * DM Vision Preview:
 * - When fogPreviewCharacterId is set, the DM sees a gold ring
 *   overlay on the map showing that character's vision radius.
 *   The DM still has full visibility — this is just an overlay hint.
 */
export function FogLayer({ mapWidth, mapHeight }: FogLayerProps) {
  const isDM = useSessionStore((s) => s.isDM);
  const enableFog = useSessionStore((s) => s.settings.enableFogOfWar);
  const dmSeesPlayerFog = useSessionStore((s) => !!s.settings.dmSeesPlayerFog);
  const tokens = useMapStore((s) => s.tokens);
  const userId = useSessionStore((s) => s.userId);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const fogPreviewCharacterId = useMapStore((s) => s.fogPreviewCharacterId);

  // Find all tokens owned by this player (heroes). When the DM has
  // opted into "see player fog" mode, we treat every PC token (any
  // human owner) as a vision source so the DM gets the union of what
  // the party can see. Without that flag the DM still bypasses fog
  // entirely so their map vision isn't accidentally constrained.
  const heroTokens = useMemo(() => {
    return Object.values(tokens).filter((t) => {
      if (!t.visible) return false;
      if (isDM && dmSeesPlayerFog) return !!t.ownerUserId;
      return t.ownerUserId === userId;
    });
  }, [tokens, userId, isDM, dmSeesPlayerFog]);

  // Find all lit tokens (anyone carrying a torch / has Light spell on them).
  // These reveal fog around themselves regardless of ownership.
  const litTokens = useMemo(() => {
    return Object.values(tokens).filter(
      (t) => t.visible && t.hasLight && (t.lightDimRadius > 0 || t.lightRadius > 0),
    );
  }, [tokens]);

  // Find the token being previewed (DM-only feature)
  const previewToken = useMemo(() => {
    if (!fogPreviewCharacterId) return null;
    return Object.values(tokens).find(
      (t) => t.characterId === fogPreviewCharacterId && t.visible,
    ) ?? null;
  }, [tokens, fogPreviewCharacterId]);

  // Vision radius in pixels (8 grid cells = 40ft vision by default)
  const visionRadius = gridSize * 8;

  // DM vision-preview overlay — rendered even when fog is off, because
  // the DM might want to see what a player *would* see.
  if (isDM && !dmSeesPlayerFog) {
    if (!previewToken) return null;
    const cx = previewToken.x + (gridSize * previewToken.size) / 2;
    const cy = previewToken.y + (gridSize * previewToken.size) / 2;
    return (
      <Group listening={false}>
        <VisionPreviewOverlay
          cx={cx}
          cy={cy}
          radius={visionRadius}
          mapWidth={mapWidth}
          mapHeight={mapHeight}
        />
      </Group>
    );
  }

  if (!enableFog) return null;

  // DM viewing player fog gets a lighter overlay — the point is to
  // *see* what the players can't, so the map underneath stays readable.
  // Players get the full 85% black.
  const fogAlpha = isDM && dmSeesPlayerFog ? 0.45 : 0.85;

  return (
    <Group listening={false}>
      {/* Base fog: covers entire map */}
      <Rect
        x={0}
        y={0}
        width={mapWidth}
        height={mapHeight}
        fill={`rgba(0, 0, 0, ${fogAlpha})`}
      />

      {/* Cut out vision circles around each hero token */}
      {heroTokens.map((token) => (
        <VisionCutout
          key={token.id}
          x={token.x + (gridSize * token.size) / 2}
          y={token.y + (gridSize * token.size) / 2}
          radius={visionRadius}
        />
      ))}

      {/* Cut out light-source circles around lit tokens. A Light spell
          cast on an object or ally reveals the fog in that area for the
          whole party. Radius uses the token's dim light radius (the
          outer edge of what the light actually illuminates). */}
      {litTokens.map((token) => (
        <VisionCutout
          key={`light-${token.id}`}
          x={token.x + (gridSize * token.size) / 2}
          y={token.y + (gridSize * token.size) / 2}
          radius={Math.max(token.lightDimRadius, token.lightRadius, gridSize * 2)}
        />
      ))}

      {/* If player has no tokens placed yet, show a message-like dim overlay */}
      {heroTokens.length === 0 && litTokens.length === 0 && (
        <Rect
          x={0}
          y={0}
          width={mapWidth}
          height={mapHeight}
          fill="rgba(0, 0, 0, 0)"
          listening={false}
        />
      )}
    </Group>
  );
}

/**
 * Circular vision cutout using destination-out compositing.
 * Creates a smooth radial fade from clear center to foggy edges.
 */
function VisionCutout({ x, y, radius }: { x: number; y: number; radius: number }) {
  return (
    <Shape
      sceneFunc={(ctx) => {
        ctx.globalCompositeOperation = 'destination-out';

        // Create radial gradient for soft vision edge
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');     // fully clear at center
        gradient.addColorStop(0.6, 'rgba(255, 255, 255, 1)');   // still clear
        gradient.addColorStop(0.85, 'rgba(255, 255, 255, 0.5)'); // dim light zone
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');      // fully fogged at edge

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.globalCompositeOperation = 'source-over';
      }}
      listening={false}
    />
  );
}

// ── DM Vision Preview Overlay ──────────────────────────────────
// Gold-tinted semi-transparent overlay showing what a specific
// player character can see. The area outside the vision radius is
// darkened; the vision circle has a pulsing gold border.

const GOLD_RING = 'rgba(212, 168, 67, 0.7)';
const GOLD_FILL = 'rgba(212, 168, 67, 0.06)';
const DARK_OVERLAY = 'rgba(0, 0, 0, 0.45)';

function VisionPreviewOverlay({
  cx,
  cy,
  radius,
  mapWidth,
  mapHeight,
}: {
  cx: number;
  cy: number;
  radius: number;
  mapWidth: number;
  mapHeight: number;
}) {
  // Animate a pulsing ring using a simple frame counter.
  // We track a Konva Shape ref and use Konva's built-in animation.
  const shapeRef = useRef<any>(null);

  return (
    <>
      {/* Dark overlay outside the vision circle */}
      <Shape
        sceneFunc={(ctx) => {
          // Draw the full map rectangle, then subtract the vision circle.
          ctx.beginPath();
          ctx.rect(0, 0, mapWidth, mapHeight);
          ctx.arc(cx, cy, radius, 0, Math.PI * 2, true); // counter-clockwise = subtract
          ctx.closePath();
          ctx.fillStyle = DARK_OVERLAY;
          ctx.fill();
        }}
        listening={false}
      />

      {/* Soft gold fill inside the circle */}
      <Shape
        sceneFunc={(ctx) => {
          const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
          gradient.addColorStop(0, GOLD_FILL);
          gradient.addColorStop(0.85, GOLD_FILL);
          gradient.addColorStop(1, 'rgba(212, 168, 67, 0)');
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fillStyle = gradient;
          ctx.fill();
        }}
        listening={false}
      />

      {/* Gold ring border — pulsing via Konva animation */}
      <Shape
        ref={shapeRef}
        sceneFunc={(ctx, shape) => {
          // Pulse the ring opacity between 0.4 and 0.9
          const t = (Date.now() % 2000) / 2000; // 0..1 over 2 seconds
          const pulse = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));

          // Outer ring
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = `rgba(212, 168, 67, ${pulse})`;
          ctx.stroke();

          // Inner bright ring
          ctx.beginPath();
          ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
          ctx.lineWidth = 1;
          ctx.strokeStyle = `rgba(232, 196, 85, ${pulse * 0.6})`;
          ctx.stroke();

          // Request next frame to keep the animation running
          shape.getLayer()?.batchDraw();
        }}
        listening={false}
      />
    </>
  );
}
