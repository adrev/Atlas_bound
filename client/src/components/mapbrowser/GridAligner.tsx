import { useState, useRef, useEffect, useCallback } from 'react';
import { theme } from '../../styles/theme';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_GRID_SIZE = 20;
const MAX_GRID_SIZE = 200;
const DEFAULT_GRID_SIZE = 70;
const HANDLE_RADIUS = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GridSettings {
  cellSize: number;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
}

interface GridAlignerProps {
  /** Object URL or data URL of the uploaded map image */
  imageUrl: string;
  /** Natural pixel dimensions of the image */
  imageDims: { w: number; h: number };
  /** Maximum display width for the preview */
  maxWidth?: number;
  /** Maximum display height for the preview */
  maxHeight?: number;
  /** Current grid settings (controlled) */
  grid: GridSettings;
  /** Callback when grid settings change */
  onGridChange: (grid: GridSettings) => void;
}

// ---------------------------------------------------------------------------
// GridAligner
// ---------------------------------------------------------------------------

export function GridAligner({
  imageUrl,
  imageDims,
  maxWidth = 600,
  maxHeight = 400,
  grid,
  onGridChange,
}: GridAlignerProps) {
  // Drag handles define one grid cell in the preview coordinate space.
  // handleA = top-left corner, handleB = bottom-right corner of a single cell.
  const [handleA, setHandleA] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const [handleB, setHandleB] = useState<{ x: number; y: number }>({ x: 120, y: 120 });
  const [dragging, setDragging] = useState<'a' | 'b' | null>(null);

  // Zoom / pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // -----------------------------------------------------------------------
  // Compute display dimensions for preview
  // -----------------------------------------------------------------------
  const displayDims = (() => {
    const scaleW = maxWidth / imageDims.w;
    const scaleH = maxHeight / imageDims.h;
    const scale = Math.min(scaleW, scaleH, 1);
    return { w: Math.round(imageDims.w * scale), h: Math.round(imageDims.h * scale), scale };
  })();

  // -----------------------------------------------------------------------
  // Reset handles when image changes
  // -----------------------------------------------------------------------
  useEffect(() => {
    const defaultCell = DEFAULT_GRID_SIZE * displayDims.scale;
    setHandleA({ x: 30, y: 30 });
    setHandleB({ x: 30 + defaultCell, y: 30 + defaultCell });
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [imageUrl, displayDims.scale]);

  // -----------------------------------------------------------------------
  // Derive cellSize in real image pixels from handle distance
  // -----------------------------------------------------------------------
  useEffect(() => {
    const dx = Math.abs(handleB.x - handleA.x);
    const dy = Math.abs(handleB.y - handleA.y);
    const cellPx = Math.max(dx, dy);
    const realCellSize = Math.round(cellPx / displayDims.scale);
    if (realCellSize >= MIN_GRID_SIZE && realCellSize <= MAX_GRID_SIZE) {
      onGridChange({ ...grid, cellSize: realCellSize });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleA, handleB, displayDims.scale]);

  // -----------------------------------------------------------------------
  // When the grid size slider changes, update the handle positions
  // -----------------------------------------------------------------------
  const syncHandlesFromCellSize = useCallback(
    (cellSize: number) => {
      const cellPx = cellSize * displayDims.scale;
      setHandleB({ x: handleA.x + cellPx, y: handleA.y + cellPx });
    },
    [handleA, displayDims.scale],
  );

  // -----------------------------------------------------------------------
  // Grid overlay rendering
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!overlayRef.current) return;
    const canvas = overlayRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = displayDims.w * dpr;
    canvas.height = displayDims.h * dpr;
    canvas.style.width = `${displayDims.w}px`;
    canvas.style.height = `${displayDims.h}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, displayDims.w, displayDims.h);

    const cellPx = grid.cellSize * displayDims.scale;
    const offX = (grid.offsetX * displayDims.scale) % cellPx;
    const offY = (grid.offsetY * displayDims.scale) % cellPx;

    // Grid lines
    ctx.strokeStyle = grid.color;
    ctx.globalAlpha = grid.opacity;
    ctx.lineWidth = 1;

    for (let x = offX; x <= displayDims.w; x += cellPx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, displayDims.h);
      ctx.stroke();
    }
    for (let y = offY; y <= displayDims.h; y += cellPx) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(displayDims.w, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Calibration handles
    const drawHandle = (pos: { x: number; y: number }, color: string) => {
      ctx.fillStyle = color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    // Draw cell highlight between handles
    const left = Math.min(handleA.x, handleB.x);
    const top = Math.min(handleA.y, handleB.y);
    const right = Math.max(handleA.x, handleB.x);
    const bottom = Math.max(handleA.y, handleB.y);
    ctx.fillStyle = 'rgba(212, 168, 67, 0.15)';
    ctx.strokeStyle = theme.gold.primary;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.setLineDash([]);

    drawHandle(handleA, theme.gold.primary);
    drawHandle(handleB, '#e8c455');
  }, [displayDims, grid, handleA, handleB]);

  // -----------------------------------------------------------------------
  // Coordinate helpers
  // -----------------------------------------------------------------------
  const getEventPos = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (!containerRef.current) return { x: 0, y: 0 };
      const rect = containerRef.current.getBoundingClientRect();
      // Account for zoom and pan
      return {
        x: (e.clientX - rect.left - pan.x) / zoom,
        y: (e.clientY - rect.top - pan.y) / zoom,
      };
    },
    [zoom, pan],
  );

  // -----------------------------------------------------------------------
  // Drag logic for calibration handles
  // -----------------------------------------------------------------------
  const handlePointerDown = useCallback(
    (e: React.MouseEvent) => {
      const pos = getEventPos(e);
      const distA = Math.hypot(pos.x - handleA.x, pos.y - handleA.y);
      const distB = Math.hypot(pos.x - handleB.x, pos.y - handleB.y);
      if (distA <= (HANDLE_RADIUS + 4) / zoom) {
        setDragging('a');
        e.stopPropagation();
      } else if (distB <= (HANDLE_RADIUS + 4) / zoom) {
        setDragging('b');
        e.stopPropagation();
      }
    },
    [handleA, handleB, getEventPos, zoom],
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: MouseEvent) => {
      const pos = getEventPos(e);
      const clamped = {
        x: Math.max(0, Math.min(pos.x, displayDims.w)),
        y: Math.max(0, Math.min(pos.y, displayDims.h)),
      };
      if (dragging === 'a') setHandleA(clamped);
      else setHandleB(clamped);
    };
    const handleUp = () => setDragging(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, displayDims, getEventPos]);

  // -----------------------------------------------------------------------
  // Zoom (scroll wheel)
  // -----------------------------------------------------------------------
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.min(4, Math.max(0.5, z + delta)));
    },
    [],
  );

  // -----------------------------------------------------------------------
  // Pan (middle-click or right-click drag on viewport)
  // -----------------------------------------------------------------------
  const handleViewportMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle button or right button for panning
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        setPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      }
    },
    [pan],
  );

  useEffect(() => {
    if (!panning) return;
    const handleMove = (e: MouseEvent) => {
      setPan({
        x: panStart.current.panX + (e.clientX - panStart.current.x),
        y: panStart.current.panY + (e.clientY - panStart.current.y),
      });
    };
    const handleUp = () => setPanning(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [panning]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div style={styles.section}>
      <label style={styles.label}>Grid Calibration</label>
      <p style={styles.hint}>
        Drag the two gold handles to mark one grid cell, or use the sliders below.
        Scroll to zoom, middle-click drag to pan.
      </p>

      {/* Zoomable / pannable viewport */}
      <div
        ref={viewportRef}
        style={{
          ...styles.viewport,
          width: displayDims.w,
          height: displayDims.h,
        }}
        onWheel={handleWheel}
        onMouseDown={handleViewportMouseDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          ref={containerRef}
          style={{
            ...styles.previewWrap,
            width: displayDims.w,
            height: displayDims.h,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
          onMouseDown={handlePointerDown}
        >
          <img
            src={imageUrl}
            alt="Map preview"
            style={{ width: displayDims.w, height: displayDims.h, display: 'block' }}
            draggable={false}
          />
          <canvas
            ref={overlayRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              cursor: dragging ? 'grabbing' : 'default',
            }}
          />
        </div>
      </div>

      {/* Grid controls */}
      <div style={styles.controlsRow}>
        <div style={styles.controlGroup}>
          <label style={styles.controlLabel}>
            Cell Size ({grid.cellSize}px)
          </label>
          <input
            type="range"
            min={MIN_GRID_SIZE}
            max={MAX_GRID_SIZE}
            value={grid.cellSize}
            onChange={(e) => {
              const val = Number(e.target.value);
              onGridChange({ ...grid, cellSize: val });
              syncHandlesFromCellSize(val);
            }}
            style={styles.slider}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.controlLabel}>Offset X</label>
          <input
            type="range"
            min={0}
            max={grid.cellSize}
            value={grid.offsetX}
            onChange={(e) => onGridChange({ ...grid, offsetX: Number(e.target.value) })}
            style={styles.slider}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.controlLabel}>Offset Y</label>
          <input
            type="range"
            min={0}
            max={grid.cellSize}
            value={grid.offsetY}
            onChange={(e) => onGridChange({ ...grid, offsetY: Number(e.target.value) })}
            style={styles.slider}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.controlLabel}>Grid Color</label>
          <input
            type="color"
            value={grid.color}
            onChange={(e) => onGridChange({ ...grid, color: e.target.value })}
            style={styles.colorInput}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.controlLabel}>Opacity</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={grid.opacity}
            onChange={(e) => onGridChange({ ...grid, opacity: Number(e.target.value) })}
            style={styles.slider}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.controlLabel}>Zoom ({Math.round(zoom * 100)}%)</label>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            style={styles.slider}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: theme.text.secondary,
    fontFamily: theme.font.body,
  },
  hint: {
    fontSize: 11,
    color: theme.text.muted,
    margin: 0,
    fontFamily: theme.font.body,
  },
  viewport: {
    position: 'relative',
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    border: `1px solid ${theme.border.default}`,
    userSelect: 'none',
    cursor: 'default',
  },
  previewWrap: {
    position: 'relative',
  },
  controlsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
  },
  controlGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 80,
  },
  controlLabel: {
    fontSize: 11,
    color: theme.text.muted,
    fontFamily: theme.font.body,
  },
  slider: {
    width: 100,
    accentColor: theme.gold.primary,
  },
  colorInput: {
    width: 32,
    height: 24,
    padding: 0,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: 'transparent',
    cursor: 'pointer',
  },
};
