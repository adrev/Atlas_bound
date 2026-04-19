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
import { ZoneLayer } from '../../components/dm/ZoneTool';
import { MeasureWallLayer, WallContextMenu } from './layers/MeasureWallLayer';
import { TokenContextMenu } from './TokenContextMenu';
import { CompendiumOverlay } from '../compendium/CompendiumOverlay';
import { LootEditorOverlay } from '../loot/LootEditorOverlay';
import { TokenActionPanel } from './TokenActionPanel';
import { GroupActionBar } from './GroupActionBar';
import { MapContextMenu } from './MapContextMenu';
import { TokenTooltip } from './TokenTooltip';
import { DrawToolbar } from './DrawToolbar';
import { InitiativeOverlay } from './InitiativeOverlay';
import { emitDrawingStream, emitDrawingStreamEnd } from '../../socket/emitters';
import { askPrompt } from '../ui';
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

  // Global Escape → clear token selection. Skip while the user is
  // typing into an input/textarea/contenteditable so we don't wipe
  // selection when they're just bailing on a chat message or a rename.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      if (active) {
        const tag = active.tagName.toLowerCase();
        const editable = (active as HTMLElement).isContentEditable;
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || editable) return;
      }
      const mapState = useMapStore.getState();
      if (mapState.selectedTokenIds.length > 0 || mapState.selectedTokenId) {
        mapState.selectToken(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Draw-mode mouse pipeline ─────────────────────────────────
  // When isDrawMode is on, stage clicks/drags drive the draw store
  // instead of panning / selecting tokens. isDrawing.current tracks
  // whether we're mid-stroke so mousemove knows to append.
  //
  // Streaming: while the stroke is mid-drag, emitDrawingStream is
  // throttled so other clients see the line being drawn live without
  // drowning the socket (a rAF-only throttle fired 60 events/sec during
  // hard draws — now one every ~100 ms = ~10 fps for the preview, with
  // the local client still rendering full-fidelity at 60 fps).
  const DRAW_STREAM_INTERVAL_MS = 100;
  const isStrokeDrawing = useRef(false);
  const lastStreamEmitAt = useRef(0);
  const streamTimeoutRef = useRef<number | null>(null);

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
    lastStreamEmitAt.current = performance.now();
  }, []);

  const scheduleStreamEmit = useCallback(() => {
    const now = performance.now();
    const since = now - lastStreamEmitAt.current;
    if (since >= DRAW_STREAM_INTERVAL_MS) {
      // Enough time has passed; fire immediately.
      if (streamTimeoutRef.current != null) {
        window.clearTimeout(streamTimeoutRef.current);
        streamTimeoutRef.current = null;
      }
      streamInProgressNow();
      return;
    }
    // Already scheduled — coalesce.
    if (streamTimeoutRef.current != null) return;
    streamTimeoutRef.current = window.setTimeout(() => {
      streamTimeoutRef.current = null;
      streamInProgressNow();
    }, DRAW_STREAM_INTERVAL_MS - since);
  }, [streamInProgressNow]);

  // Drag-drop from the DM creature / compendium panels. The card
  // writes the monster slug to dataTransfer under a custom MIME type;
  // on drop we convert the container-relative pixel position into
  // map-space and dispatch a window event. The CreatureLibrary (DM
  // tab) listens for that event, fetches the full monster row, and
  // routes through its existing placement flow. Library has to be
  // mounted (DM Tools → Creatures) for the event to land — this is
  // v1, good enough for the workflow where a DM drags creatures in
  // while the library is open.
  const handleMapDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('application/x-kbrt-creature')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleMapDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const slug = e.dataTransfer.getData('application/x-kbrt-creature');
      if (!slug) return;
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const mapX = (px - stageProps.x) / stageProps.scaleX;
      const mapY = (py - stageProps.y) / stageProps.scaleY;
      window.dispatchEvent(
        new CustomEvent('kbrt-creature-drop', { detail: { slug, x: mapX, y: mapY } }),
      );
    },
    [stageProps.x, stageProps.y, stageProps.scaleX, stageProps.scaleY],
  );

  return (
    <div
      ref={containerRef}
      style={styles.container}
      onDragOver={handleMapDragOver}
      onDrop={handleMapDrop}
    >
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
            void askPrompt({
              title: 'Add label',
              message: 'Text to place on the map.',
              placeholder: 'Label',
              maxLength: 256,
            }).then((text) => {
              if (!text) return;
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
                      content: text,
                      fontSize: Math.max(12, drawState.activeWidth * 6),
                    },
                  },
                  gridSnapped: false,
                },
              });
              useDrawStore.getState().commitStroke();
            });
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
            {/*
              Layer consolidation (2026-04). Konva warns at 6+ layers
              and recommends 3-5 because each layer is a separate canvas
              + draw call. We previously mounted 8-12 layers (one per
              feature). Now there are 4 grouped layers:

                Base    — map image + grid (static, listening=false)
                Tokens  — interactive token sprites + movement range
                Overlays — fog + lighting darkness masks (listening=false)
                Tools   — measure / walls / zones / drawings / FX / spell anims

              Each former Layer component now returns a fragment or
              Group; the per-shape `listening={false}` flags inside
              still gate pointer events correctly because Konva walks
              the topmost listening shape, not the topmost listening
              layer.
            */}
            <Layer listening={false}>
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
            </Layer>

            <Layer>
              <TokenLayer />
              {isMyTurn && <MovementRangeLayer />}
            </Layer>

            <Layer listening={false}>
              <FogLayer
                mapWidth={currentMap.width}
                mapHeight={currentMap.height}
              />
              <LightingLayer
                mapWidth={currentMap.width}
                mapHeight={currentMap.height}
              />
            </Layer>

            {/* Tools layer — measure, walls, zones, spell-target template,
                drawings, and spell animations. Drawings rendered above
                tokens so annotations and arrows are never occluded.
                Spell animations rendered last so casts always pop. */}
            <Layer>
              <MeasureWallLayer />
              {isDM && activeTool === 'wall' && (
                <WallDrawLayer gridSize={currentMap.gridSize} />
              )}
              {isDM && <ZoneLayer />}
              {targetingSpell && <EffectLayer />}
              <DrawingLayer />
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
      {/* P7 — DM-only empty-state CTA. Instead of a blank canvas when a
          fresh session has no map, surface a direct path into MapBrowser
          so the DM can pick a pre-built map without hunting through
          sidebar tabs. Players still get the Konva "No map loaded" text
          (they can't load maps themselves). */}
      {!currentMap && isDM && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
              padding: '32px 40px',
              background: 'rgba(12,10,8,0.85)',
              border: `1px solid ${theme.gold.border}`,
              borderRadius: theme.radius.md,
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
              maxWidth: 440,
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 32, opacity: 0.65 }}>🗺️</div>
            <div style={{
              fontFamily: theme.font.display,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: theme.gold.primary,
            }}>
              No Map Loaded
            </div>
            <div style={{ fontSize: 13, color: theme.text.secondary, lineHeight: 1.5 }}>
              Pick a pre-built map or upload your own to begin the session.
            </div>
            <button
              onClick={() => window.dispatchEvent(new Event('open-map-browser'))}
              style={{
                marginTop: 4,
                padding: '10px 24px',
                fontFamily: theme.font.display,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: theme.bg.base,
                background: theme.gold.primary,
                border: `1px solid ${theme.gold.primary}`,
                borderRadius: theme.radius.sm,
                cursor: 'pointer',
                boxShadow: `0 0 12px ${theme.gold.border}`,
              }}
            >
              Browse Maps
            </button>
          </div>
        </div>
      )}
      <InitiativeOverlay />
      <PingOverlay stageX={stageProps.x} stageY={stageProps.y} stageScale={stageProps.scaleX} />
      <TokenTooltip />
      <TokenActionPanel />
      <GroupActionBar />
      <TokenContextMenu />
      <MapContextMenu />
      <WallContextMenu />
      <CompendiumOverlay />
      <LootEditorOverlay />
      <DrawToolbar />

      {/* Tome map-frame chrome — vignette + four corner filigrees +
          decorative inset border. Pointer-events:none so nothing in
          this layer intercepts Konva events. */}
      <MapFrameVignette />
      <MapFrameCorner position="tl" />
      <MapFrameCorner position="tr" />
      <MapFrameCorner position="bl" />
      <MapFrameCorner position="br" />

      <style>{`
        @keyframes pingExpand {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

/**
 * Soft radial vignette sitting on top of the Konva stage. Never
 * intercepts pointer events — it's purely cosmetic to match the
 * Tome map-frame look (see design-handoff KBRT.html .map-frame::before).
 */
function MapFrameVignette() {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 5,
        background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
        boxShadow: 'inset 0 0 60px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(0,0,0,0.4)',
      }}
    />
  );
}

/**
 * Gilt corner filigree from design-handoff KBRT.html. Renders as a
 * 64x64 SVG in one of the four corners; CSS transforms mirror it so
 * a single path looks symmetric across all four. pointer-events:none
 * so clicks pass through to the Konva stage.
 */
function MapFrameCorner({ position }: { position: 'tl' | 'tr' | 'bl' | 'br' }) {
  const basePos: React.CSSProperties = (() => {
    switch (position) {
      case 'tl': return { top: 0, left: 0 };
      case 'tr': return { top: 0, right: 0, transform: 'scaleX(-1)' };
      case 'bl': return { bottom: 0, left: 0, transform: 'scaleY(-1)' };
      case 'br': return { bottom: 0, right: 0, transform: 'scale(-1, -1)' };
    }
  })();
  return (
    <svg
      aria-hidden
      viewBox="0 0 64 64"
      fill="none"
      stroke="var(--gold)"
      strokeWidth="1.2"
      style={{
        position: 'absolute',
        width: 64,
        height: 64,
        pointerEvents: 'none',
        zIndex: 8,
        opacity: 0.7,
        ...basePos,
      }}
    >
      <path d="M0 8 Q6 8 10 14 Q14 20 14 28 Q14 34 10 38 Q6 42 0 42" />
      <path d="M8 0 Q8 6 14 10 Q20 14 28 14 Q34 14 38 10 Q42 6 42 0" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M18 18 Q24 24 30 24 Q36 24 36 18" />
      <path d="M18 18 Q24 24 24 30 Q24 36 18 36" />
      <path d="M4 4 Q10 10 18 18" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    background: theme.bg.deepest,
    cursor: 'default',
    position: 'relative',
  },
};
