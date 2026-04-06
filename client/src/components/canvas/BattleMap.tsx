import { useRef, useEffect, useState, useCallback } from 'react';
import { Stage, Layer, Text } from 'react-konva';
import { useCanvasViewport } from '../../hooks/useCanvasViewport';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { BackgroundLayer } from './layers/BackgroundLayer';
import { GridLayer } from './layers/GridLayer';
import { TokenLayer } from './layers/TokenLayer';
import { FogLayer } from './layers/FogLayer';
import { MovementRangeLayer } from './layers/MovementRangeLayer';
import { EffectLayer } from './layers/EffectLayer';
import { LightingLayer } from './layers/LightingLayer';
import { useCombatStore } from '../../stores/useCombatStore';
import { useEffectStore } from '../../stores/useEffectStore';
import { WallDrawLayer } from '../../components/dm/WallDrawTool';
import { MeasureWallLayer, WallContextMenu } from './layers/MeasureWallLayer';
import { TokenContextMenu } from './TokenContextMenu';
import { CompendiumOverlay } from '../compendium/CompendiumOverlay';
import { LootEditorOverlay } from '../loot/LootEditorOverlay';
import { TokenActionPanel } from './TokenActionPanel';
import { MapContextMenu } from './MapContextMenu';
import { TokenTooltip } from './TokenTooltip';
import { theme } from '../../styles/theme';

/* ---- Ping animation overlay ---- */
function PingAnimation({ x, y, displayName, timestamp }: {
  x: number; y: number; displayName: string; timestamp: number;
}) {
  const [opacity, setOpacity] = useState(1);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    // Animate in
    requestAnimationFrame(() => { setScale(1); });
    // Fade out after 2s
    const fadeTimer = setTimeout(() => setOpacity(0), 2000);
    // Remove from store after 3s
    const removeTimer = setTimeout(() => {
      useMapStore.getState().removePing(timestamp);
    }, 3000);
    return () => { clearTimeout(fadeTimer); clearTimeout(removeTimer); };
  }, [timestamp]);

  return (
    <div style={{
      position: 'absolute', left: x, top: y,
      transform: `translate(-50%, -50%) scale(${scale})`,
      transition: 'transform 0.4s ease-out, opacity 0.8s ease-out',
      opacity, pointerEvents: 'none', zIndex: 50,
    }}>
      {/* Outer expanding ring */}
      <div style={{
        width: 60, height: 60, borderRadius: '50%',
        border: '3px solid #d4a843',
        position: 'absolute', left: -30, top: -30,
        animation: 'pingExpand 1.5s ease-out infinite',
      }} />
      {/* Inner dot */}
      <div style={{
        width: 16, height: 16, borderRadius: '50%',
        background: '#d4a843', boxShadow: '0 0 12px #d4a843',
        position: 'absolute', left: -8, top: -8,
      }} />
      {/* Name label */}
      <div style={{
        position: 'absolute', top: 16, left: '50%',
        transform: 'translateX(-50%)', whiteSpace: 'nowrap',
        background: 'rgba(0,0,0,0.75)', color: '#d4a843',
        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      }}>
        {displayName}
      </div>
    </div>
  );
}

function PingOverlay({ stageX, stageY, stageScale }: { stageX: number; stageY: number; stageScale: number }) {
  const activePings = useMapStore((s) => s.activePings);

  if (activePings.length === 0) return null;

  return (
    <>
      {activePings.map((ping) => {
        // Convert map coords to screen coords using actual stage transform
        const screenX = ping.x * stageScale + stageX;
        const screenY = ping.y * stageScale + stageY;
        return (
          <PingAnimation
            key={ping.timestamp}
            x={screenX}
            y={screenY}
            displayName={ping.displayName}
            timestamp={ping.timestamp}
          />
        );
      })}
    </>
  );
}

export function BattleMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const { stageProps } = useCanvasViewport();
  const currentMap = useMapStore((s) => s.currentMap);
  const isDM = useSessionStore((s) => s.isDM);
  const gridOpacity = useSessionStore((s) => s.settings.gridOpacity);
  const userId = useSessionStore((s) => s.userId);
  const activeTool = useMapStore((s) => s.activeTool);
  // Read combat state via getState() to avoid re-render loops from array/object deps
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [targetingSpell, setTargetingSpellLocal] = useState<unknown>(null);

  useEffect(() => {
    const unsubCombat = useCombatStore.subscribe((s) => {
      const combatant = s.combatants[s.currentTurnIndex];
      const myTurn = s.active && !!combatant && (
        useSessionStore.getState().isDM || combatant.characterId === useSessionStore.getState().userId
      );
      setIsMyTurn(myTurn);
    });
    const unsubEffect = useEffectStore.subscribe((s) => {
      setTargetingSpellLocal(s.targetingSpell);
    });
    return () => { unsubCombat(); unsubEffect(); };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(container);
    setDimensions({
      width: container.clientWidth,
      height: container.clientHeight,
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={styles.container}>
      <Stage
        width={dimensions.width}
        height={dimensions.height}
        {...stageProps}
        onMouseMove={(e) => {
          // IMPORTANT: call the original panning handler first
          stageProps.onMouseMove?.(e);
          // Then emit canvas-mousemove for measure/wall tools
          const tool = useMapStore.getState().activeTool;
          if (tool === 'measure' || tool === 'wall') {
            const stage = e.target.getStage();
            if (!stage) return;
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
            const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;
            window.dispatchEvent(new CustomEvent('canvas-mousemove', { detail: { mapX, mapY } }));
          }
        }}
        onClick={(e) => {
          // Emit canvas-click for measure/wall tools
          if (e.target === e.target.getStage()) {
            const stage = e.target.getStage();
            if (!stage) return;
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
            const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;
            window.dispatchEvent(new CustomEvent('canvas-click', { detail: { mapX, mapY } }));
          }
        }}
      >
        {currentMap ? (
          <>
            <BackgroundLayer
              imageUrl={currentMap.imageUrl}
              width={currentMap.width}
              height={currentMap.height}
            />
            <GridLayer
              mapWidth={currentMap.width}
              mapHeight={currentMap.height}
              gridSize={currentMap.gridSize}
              gridOpacity={gridOpacity ?? 0.15}
              viewport={stageProps}
              stageWidth={dimensions.width}
              stageHeight={dimensions.height}
            />
            <TokenLayer />
            {isMyTurn && <MovementRangeLayer />}
            {targetingSpell && <EffectLayer />}
            <FogLayer
              mapWidth={currentMap.width}
              mapHeight={currentMap.height}
            />
            <LightingLayer
              mapWidth={currentMap.width}
              mapHeight={currentMap.height}
            />
            <MeasureWallLayer />
            {isDM && activeTool === 'wall' && (
              <WallDrawLayer gridSize={currentMap.gridSize} />
            )}
          </>
        ) : (
          <Layer>
            <Text
              x={dimensions.width / 2 - 100}
              y={dimensions.height / 2 - 20}
              text="No map loaded"
              fontSize={18}
              fill={theme.text.muted}
              width={200}
              align="center"
            />
            <Text
              x={dimensions.width / 2 - 150}
              y={dimensions.height / 2 + 10}
              text="Load a map from DM Tools to get started"
              fontSize={13}
              fill={theme.text.muted}
              width={300}
              align="center"
            />
          </Layer>
        )}
      </Stage>
      <PingOverlay stageX={stageProps.x} stageY={stageProps.y} stageScale={stageProps.scaleX} />
      <TokenTooltip />
      <TokenActionPanel />
      <TokenContextMenu />
      <MapContextMenu />
      <WallContextMenu />
      <CompendiumOverlay />
      <LootEditorOverlay />
      <style>{`
        @keyframes pingExpand {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    background: theme.bg.deepest,
    cursor: 'default',
  },
};
