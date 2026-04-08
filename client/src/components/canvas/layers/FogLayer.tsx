import { useMemo } from 'react';
import { Layer, Rect, Shape } from 'react-konva';
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
 */
export function FogLayer({ mapWidth, mapHeight }: FogLayerProps) {
  const isDM = useSessionStore((s) => s.isDM);
  const enableFog = useSessionStore((s) => s.settings.enableFogOfWar);
  const tokens = useMapStore((s) => s.tokens);
  const userId = useSessionStore((s) => s.userId);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);

  // Find all tokens owned by this player (heroes)
  const heroTokens = useMemo(() => {
    return Object.values(tokens).filter(
      (t) => t.ownerUserId === userId && t.visible
    );
  }, [tokens, userId]);

  // Find all lit tokens (anyone carrying a torch / has Light spell on them).
  // These reveal fog around themselves regardless of ownership.
  const litTokens = useMemo(() => {
    return Object.values(tokens).filter(
      (t) => t.visible && t.hasLight && (t.lightDimRadius > 0 || t.lightRadius > 0),
    );
  }, [tokens]);

  // GM never sees fog. (Hook calls above must still run to keep hook order
  // stable between DM and player renders.)
  if (isDM || !enableFog) return null;

  // Vision radius in pixels (8 grid cells = 40ft vision by default)
  const visionRadius = gridSize * 8;

  return (
    <Layer listening={false}>
      {/* Base fog: covers entire map */}
      <Rect
        x={0}
        y={0}
        width={mapWidth}
        height={mapHeight}
        fill="rgba(0, 0, 0, 0.85)"
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
    </Layer>
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
