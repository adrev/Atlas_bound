import { useRef, useEffect, useState, useCallback } from 'react';
import { Stage, Layer, Text } from 'react-konva';
import { useCanvasViewport } from '../../hooks/useCanvasViewport';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useDrawStore } from '../../stores/useDrawStore';
import { BackgroundLayer } from './layers/BackgroundLayer';
import { GridLayer } from './layers/GridLayer';
import { TokenLayer } from './layers/TokenLayer';
import { FogLayer } from './layers/FogLayer';
import { MovementRangeLayer } from './layers/MovementRangeLayer';
import { EffectLayer } from './layers/EffectLayer';
import { DrawingLayer } from './layers/DrawingLayer';
import { LightingLayer } from './layers/LightingLayer';
import { SpellAnimationLayer } from '../animations/SpellAnimation';
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
import { DrawToolbar } from './DrawToolbar';
import { emitDrawingStream, emitDrawingStreamEnd } from '../../socket/emitters';
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
  const { stageProps, setViewport: setCanvasViewport } = useCanvasViewport();
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

  /* ── Fit-to-map on load ──────────────────────────────────────────
     When a new map loads (or the user loads the first map), center
     the camera on the middle of the map and zoom so the whole map
     fits the visible viewport with a small margin. This runs
     whenever currentMap.id changes. It does NOT re-run when the
     user pans or zooms — we only "home" on the initial load. */
  const initialFitMapId = useRef<string | null>(null);
  useEffect(() => {
    if (!currentMap) return;
    if (dimensions.width < 200 || dimensions.height < 200) return;
    // Only fit once per map id, so panning after load doesn't get
    // undone by a re-run of this effect on unrelated renders.
    if (initialFitMapId.current === currentMap.id) return;
    initialFitMapId.current = currentMap.id;

    const MARGIN = 40; // pixels of breathing room around the map
    const availW = Math.max(100, dimensions.width - MARGIN * 2);
    const availH = Math.max(100, dimensions.height - MARGIN * 2);
    const scale = Math.min(availW / currentMap.width, availH / currentMap.height);
    // Center: screenX = worldX * scale + x  →  x = screenX - worldX * scale.
    // We want the MAP CENTER at the CONTAINER CENTER.
    const mapCenterX = currentMap.width / 2;
    const mapCenterY = currentMap.height / 2;
    const x = dimensions.width / 2 - mapCenterX * scale;
    const y = dimensions.height / 2 - mapCenterY * scale;
    setCanvasViewport({ x, y, scale });
  }, [currentMap?.id, dimensions.width, dimensions.height, setCanvasViewport, currentMap]);

  /* ── External "center on token" / "center on map position" ──────
     Other components (InitiativeTracker, context menu, etc.) fire a
     `canvas-center-on` CustomEvent with either a tokenId or raw
     mapX/mapY. We read the token's current world coordinates, work
     out the offset that lands them in the middle of the visible
     viewport at the current zoom, and push it into the local
     useCanvasViewport state so the camera jumps there. */
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        tokenId?: string;
        mapX?: number;
        mapY?: number;
      };
      const map = useMapStore.getState().currentMap;
      if (!map) return;

      let worldX: number | undefined;
      let worldY: number | undefined;
      if (detail.tokenId) {
        const tok = useMapStore.getState().tokens[detail.tokenId] as any;
        if (!tok) return;
        const grid = map.gridSize || 70;
        // Center on the middle of the token, not its top-left corner.
        worldX = tok.x + (grid * (tok.size || 1)) / 2;
        worldY = tok.y + (grid * (tok.size || 1)) / 2;
      } else if (typeof detail.mapX === 'number' && typeof detail.mapY === 'number') {
        worldX = detail.mapX;
        worldY = detail.mapY;
      }
      if (worldX === undefined || worldY === undefined) return;

      const containerEl = containerRef.current;
      if (!containerEl) return;
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;

      // Preserve the current zoom. screenX = worldX * scale + viewport.x,
      // so to center we want screenX = w/2 → viewport.x = w/2 - worldX * scale.
      setCanvasViewport((prev) => ({
        ...prev,
        x: w / 2 - worldX! * prev.scale,
        y: h / 2 - worldY! * prev.scale,
      }));
    };
    window.addEventListener('canvas-center-on', handler as EventListener);
    return () => window.removeEventListener('canvas-center-on', handler as EventListener);
  }, [setCanvasViewport]);

  // ── Draw-mode mouse pipeline ─────────────────────────────────
  // When isDrawMode is on, stage clicks/drags drive the draw store
  // instead of panning / selecting tokens. isDrawing.current tracks
  // whether we're mid-stroke so mousemove knows to append.
  //
  // Streaming: while the stroke is mid-drag, emitDrawingStream is
  // called rAF-throttled so other clients see the line being drawn
  // live. On mouseup the stroke is committed via useDrawStore.
  const isStrokeDrawing = useRef(false);
  const streamRafQueued = useRef(false);

  const streamInProgressNow = useCallback(() => {
    const store = useDrawStore.getState();
    const inProg = store.drawingInProgress;
    if (!inProg) return;
    if (inProg.kind === 'text') return;
    const currentUserId = useSessionStore.getState().userId ?? '';
    emitDrawingStream({
      tempId: inProg.tempId,
      creatorUserId: currentUserId,
      kind: inProg.kind,
      visibility: inProg.visibility,
      color: inProg.color,
      strokeWidth: inProg.strokeWidth,
      geometry: inProg.geometry,
    });
  }, []);

  const scheduleStreamEmit = useCallback(() => {
    if (streamRafQueued.current) return;
    streamRafQueued.current = true;
    requestAnimationFrame(() => {
      streamRafQueued.current = false;
      streamInProgressNow();
    });
  }, [streamInProgressNow]);

  return (
    <div ref={containerRef} style={styles.container}>
      <Stage
        width={dimensions.width}
        height={dimensions.height}
        {...stageProps}
        onMouseDown={(e) => {
          // Draw mode: start a new stroke on empty-stage clicks with
          // tool != select/text. Text tool is handled via onClick below.
          const drawState = useDrawStore.getState();
          if (drawState.isDrawMode && e.evt.button === 0) {
            const stage = e.target.getStage();
            if (stage && (e.target === stage || drawState.activeTool !== 'select')) {
              // Selection tool clicks on shapes are handled by the
              // DrawingLayer itself. We only start a stroke on non-
              // select tools regardless of what was clicked.
              if (drawState.activeTool !== 'select' && drawState.activeTool !== 'text') {
                const pointer = stage.getPointerPosition();
                if (pointer) {
                  const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
                  const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;
                  drawState.beginStroke(mapX, mapY);
                  isStrokeDrawing.current = true;
                  // Don't call the panning handler — we've consumed
                  // this event for drawing.
                  return;
                }
              }
              // Select tool on empty canvas clears selection
              if (drawState.activeTool === 'select' && e.target === stage) {
                drawState.selectDrawing(null);
              }
            }
          }
          stageProps.onMouseDown?.(e);
        }}
        onMouseMove={(e) => {
          // Draw mode: extend in-progress stroke
          const drawState = useDrawStore.getState();
          if (drawState.isDrawMode && isStrokeDrawing.current) {
            const stage = e.target.getStage();
            if (!stage) return;
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
            const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;
            drawState.updateStroke(mapX, mapY);
            scheduleStreamEmit();
            return;
          }

          // IMPORTANT: call the original panning handler first
          stageProps.onMouseMove?.(e);
          const stage = e.target.getStage();
          if (!stage) return;
          const pointer = stage.getPointerPosition();
          if (!pointer) return;
          const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
          const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;

          // Spell aim mode: track cursor for AoE template preview
          const aim = useEffectStore.getState().targetingSpell;
          if (aim) {
            const tokens = useMapStore.getState().tokens;
            const casterToken = tokens[aim.casterTokenId] as any;
            if (aim.aoeType === 'cone' || aim.aoeType === 'line') {
              // Self-range or aimed cone/line: origin = caster, rotation = direction to mouse
              if (casterToken) {
                useEffectStore.getState().setTargetPosition({ x: casterToken.x, y: casterToken.y });
                const angle = Math.atan2(mapY - casterToken.y, mapX - casterToken.x) * 180 / Math.PI;
                useEffectStore.getState().setTargetRotation(angle);
              }
            } else {
              // Sphere/cube: origin = cursor (placement)
              useEffectStore.getState().setTargetPosition({ x: mapX, y: mapY });
            }
          }

          // Then emit canvas-mousemove for measure/wall tools
          const tool = useMapStore.getState().activeTool;
          if (tool === 'measure' || tool === 'wall') {
            window.dispatchEvent(new CustomEvent('canvas-mousemove', { detail: { mapX, mapY } }));
          }
        }}
        onMouseUp={(e) => {
          // Draw mode: commit in-progress stroke
          if (isStrokeDrawing.current) {
            isStrokeDrawing.current = false;
            const drawState = useDrawStore.getState();
            if (drawState.drawingInProgress) {
              drawState.commitStroke();
            }
            return;
          }
          stageProps.onMouseUp?.(e);
        }}
        onClick={(e) => {
          // Draw mode: text tool plants a label on click
          const drawState = useDrawStore.getState();
          if (drawState.isDrawMode && drawState.activeTool === 'text') {
            const stage = e.target.getStage();
            if (!stage) return;
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
            const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;
            // eslint-disable-next-line no-alert
            const text = prompt('Enter label text:');
            if (text && text.trim()) {
              // Seed a text in-progress stroke and commit it.
              useDrawStore.setState({
                drawingInProgress: {
                  tempId: Math.random().toString(36).slice(2),
                  kind: 'text',
                  color: drawState.activeColor,
                  strokeWidth: drawState.activeWidth,
                  visibility: drawState.activeVisibility,
                  geometry: {
                    text: {
                      x: mapX,
                      y: mapY,
                      content: text.trim(),
                      fontSize: Math.max(12, drawState.activeWidth * 6),
                    },
                  },
                  gridSnapped: false,
                },
              });
              drawState.commitStroke();
            }
            return;
          }

          // Spell aim mode: confirm cast at cursor
          const aim = useEffectStore.getState().targetingSpell;
          if (aim && (e.target === e.target.getStage() || true)) {
            const stage = e.target.getStage();
            if (stage) {
              const pointer = stage.getPointerPosition();
              if (pointer) {
                const mapX = (pointer.x - stageProps.x) / stageProps.scaleX;
                const mapY = (pointer.y - stageProps.y) / stageProps.scaleY;
                const rotation = useEffectStore.getState().targetRotation;
                window.dispatchEvent(new CustomEvent('aoe-spell-confirm', {
                  detail: { mapX, mapY, rotation },
                }));
                return;
              }
            }
          }

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
            {/* DM / player drawings — rendered ABOVE tokens so
                annotations and arrows are never occluded. */}
            <DrawingLayer />
            {/* Spell animations (projectiles, AoE bursts, buff swirls,
                melee swings) — rendered on top of everything else so
                they're always visible during cast resolution. The
                SpellAnimationLayer subscribes to useEffectStore's
                activeAnimations array and auto-removes each animation
                when it completes. */}
            <Layer listening={false}>
              <SpellAnimationLayer />
            </Layer>
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
      <DrawToolbar />
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
