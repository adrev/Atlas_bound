import { useState, useRef, useEffect, useCallback } from 'react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import {
  emitLoadMap, emitPreviewLoadMap, emitListMaps,
} from '../../socket/emitters';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCEPTED_TYPES = '.jpg,.jpeg,.png,.webp';
const DEFAULT_GRID_SIZE = 70;
const MIN_GRID_SIZE = 20;
const MAX_GRID_SIZE = 200;
const PREVIEW_MAX_W = 600;
const PREVIEW_MAX_H = 400;
const HANDLE_RADIUS = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GridSettings {
  cellSize: number;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
}

// ---------------------------------------------------------------------------
// MapUpload
// ---------------------------------------------------------------------------

interface MapUploadProps {
  open: boolean;
  onClose: () => void;
  onMapCreated?: () => void;
}

export function MapUpload({ open, onClose, onMapCreated }: MapUploadProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const isDM = useSessionStore((s) => s.isDM);
  const playerMapId = useMapStore((s) => s.playerMapId);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
  const [mapName, setMapName] = useState('');
  const [grid, setGrid] = useState<GridSettings>({
    cellSize: DEFAULT_GRID_SIZE,
    offsetX: 0,
    offsetY: 0,
    color: '#ffffff',
    opacity: 0.25,
  });

  // Drag handles define one grid cell in the preview coordinate space.
  // handleA = top-left corner, handleB = bottom-right corner of a single cell.
  const [handleA, setHandleA] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const [handleB, setHandleB] = useState<{ x: number; y: number }>({ x: 120, y: 120 });
  const [dragging, setDragging] = useState<'a' | 'b' | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // -----------------------------------------------------------------------
  // Compute display dimensions for preview
  // -----------------------------------------------------------------------
  const displayDims = (() => {
    if (!imageDims) return null;
    const scaleW = PREVIEW_MAX_W / imageDims.w;
    const scaleH = PREVIEW_MAX_H / imageDims.h;
    const scale = Math.min(scaleW, scaleH, 1);
    return { w: Math.round(imageDims.w * scale), h: Math.round(imageDims.h * scale), scale };
  })();

  // -----------------------------------------------------------------------
  // Derive cellSize in real image pixels from handle distance
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!displayDims) return;
    const dx = Math.abs(handleB.x - handleA.x);
    const dy = Math.abs(handleB.y - handleA.y);
    const cellPx = Math.max(dx, dy);
    const realCellSize = Math.round(cellPx / displayDims.scale);
    if (realCellSize >= MIN_GRID_SIZE && realCellSize <= MAX_GRID_SIZE) {
      setGrid((g) => ({ ...g, cellSize: realCellSize }));
    }
  }, [handleA, handleB, displayDims]);

  // -----------------------------------------------------------------------
  // File handling
  // -----------------------------------------------------------------------
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setMapName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
    setError(null);

    const url = URL.createObjectURL(f);
    setPreviewUrl(url);

    const img = new Image();
    img.onload = () => {
      setImageDims({ w: img.naturalWidth, h: img.naturalHeight });
      // Reset handles to a sensible default
      const scaleW = PREVIEW_MAX_W / img.naturalWidth;
      const scaleH = PREVIEW_MAX_H / img.naturalHeight;
      const scale = Math.min(scaleW, scaleH, 1);
      const defaultCell = DEFAULT_GRID_SIZE * scale;
      setHandleA({ x: 30, y: 30 });
      setHandleB({ x: 30 + defaultCell, y: 30 + defaultCell });
    };
    img.src = url;
  }, []);

  // -----------------------------------------------------------------------
  // Grid overlay rendering
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!overlayRef.current || !displayDims) return;
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
  // Drag logic
  // -----------------------------------------------------------------------
  const getEventPos = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (!containerRef.current) return { x: 0, y: 0 };
      const rect = containerRef.current.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    [],
  );

  const handlePointerDown = useCallback(
    (e: React.MouseEvent) => {
      const pos = getEventPos(e);
      const distA = Math.hypot(pos.x - handleA.x, pos.y - handleA.y);
      const distB = Math.hypot(pos.x - handleB.x, pos.y - handleB.y);
      if (distA <= HANDLE_RADIUS + 4) setDragging('a');
      else if (distB <= HANDLE_RADIUS + 4) setDragging('b');
    },
    [handleA, handleB, getEventPos],
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: MouseEvent) => {
      const pos = getEventPos(e);
      const clamped = {
        x: Math.max(0, Math.min(pos.x, displayDims?.w ?? 600)),
        y: Math.max(0, Math.min(pos.y, displayDims?.h ?? 400)),
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
  // Upload / create map
  // -----------------------------------------------------------------------
  const handleCreate = useCallback(async () => {
    if (!sessionId || !file) return;
    if (!mapName.trim()) {
      setError('Please enter a map name.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('name', mapName.trim());
      formData.append('width', String(imageDims?.w ?? 1400));
      formData.append('height', String(imageDims?.h ?? 1050));
      formData.append('gridSize', String(grid.cellSize));
      formData.append('gridType', 'square');

      const res = await fetch(`/api/sessions/${sessionId}/maps`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `Upload failed: ${res.status}`);
      }

      const data = await res.json();

      // Routing decision:
      //   • DM + existing ribbon → PREVIEW load (don't yank players)
      //   • DM + no ribbon yet → ACTIVATE load (first map of session)
      //   • Non-DM → legacy path (shouldn't normally happen)
      if (isDM && playerMapId) {
        emitPreviewLoadMap(data.id);
      } else {
        emitLoadMap(data.id);
      }
      // Bump the scene manager so the newly uploaded map shows up.
      emitListMaps();
      onMapCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  }, [sessionId, file, mapName, imageDims, grid, isDM, playerMapId, onMapCreated, onClose]);

  // -----------------------------------------------------------------------
  // Cleanup preview URL
  // -----------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  if (!open) return null;

  return (
    <div style={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Upload Custom Map</h2>
          <button style={styles.closeBtn} onClick={onClose}>
            &times;
          </button>
        </div>

        {/* File input */}
        <div style={styles.section}>
          <label style={styles.label}>Map Image</label>
          <input
            type="file"
            accept={ACCEPTED_TYPES}
            onChange={handleFileChange}
            style={styles.fileInput}
          />
          <span style={styles.hint}>JPG, PNG, or WebP up to 20 MB</span>
        </div>

        {/* Preview + grid overlay */}
        {previewUrl && displayDims && (
          <div style={styles.section}>
            <label style={styles.label}>Grid Calibration</label>
            <p style={styles.hint}>
              Drag the two gold handles to mark one grid cell. The grid auto-adjusts.
            </p>
            <div
              ref={containerRef}
              style={{
                ...styles.previewWrap,
                width: displayDims.w,
                height: displayDims.h,
              }}
              onMouseDown={handlePointerDown}
            >
              <img
                src={previewUrl}
                alt="Map preview"
                style={{ width: displayDims.w, height: displayDims.h, display: 'block' }}
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

            {/* Grid controls */}
            <div style={styles.controlsRow}>
              <div style={styles.controlGroup}>
                <label style={styles.controlLabel}>Cell Size (px)</label>
                <input
                  type="number"
                  value={grid.cellSize}
                  min={MIN_GRID_SIZE}
                  max={MAX_GRID_SIZE}
                  onChange={(e) =>
                    setGrid((g) => ({ ...g, cellSize: Number(e.target.value) || DEFAULT_GRID_SIZE }))
                  }
                  style={styles.numberInput}
                />
              </div>
              <div style={styles.controlGroup}>
                <label style={styles.controlLabel}>Offset X</label>
                <input
                  type="range"
                  min={0}
                  max={grid.cellSize}
                  value={grid.offsetX}
                  onChange={(e) => setGrid((g) => ({ ...g, offsetX: Number(e.target.value) }))}
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
                  onChange={(e) => setGrid((g) => ({ ...g, offsetY: Number(e.target.value) }))}
                  style={styles.slider}
                />
              </div>
              <div style={styles.controlGroup}>
                <label style={styles.controlLabel}>Grid Color</label>
                <input
                  type="color"
                  value={grid.color}
                  onChange={(e) => setGrid((g) => ({ ...g, color: e.target.value }))}
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
                  onChange={(e) => setGrid((g) => ({ ...g, opacity: Number(e.target.value) }))}
                  style={styles.slider}
                />
              </div>
            </div>
          </div>
        )}

        {/* Map name */}
        <div style={styles.section}>
          <label style={styles.label}>Map Name</label>
          <input
            type="text"
            value={mapName}
            onChange={(e) => { e.stopPropagation(); setMapName(e.target.value); }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Enter map name..."
            style={{ ...styles.textInput, fontSize: 16, padding: '10px 14px', fontWeight: 600 }}
            autoComplete="off"
          />
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {/* Actions */}
        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...styles.createBtn,
              opacity: !file || loading ? 0.5 : 1,
            }}
            disabled={!file || loading}
            onClick={handleCreate}
          >
            {loading ? 'Uploading...' : 'Create Map'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.xl,
    padding: 24,
    maxWidth: 680,
    width: '95vw',
    maxHeight: '90vh',
    overflowY: 'auto',
    boxShadow: theme.shadow.lg,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontFamily: theme.font.display,
    color: theme.gold.primary,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: theme.text.muted,
    fontSize: 24,
    cursor: 'pointer',
    lineHeight: 1,
    padding: '0 4px',
  },
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
  fileInput: {
    fontSize: 13,
    color: theme.text.primary,
    fontFamily: theme.font.body,
  },
  previewWrap: {
    position: 'relative',
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    border: `1px solid ${theme.border.default}`,
    userSelect: 'none',
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
  numberInput: {
    width: 70,
    padding: '4px 6px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.base,
    color: theme.text.primary,
    fontSize: 13,
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
  textInput: {
    padding: '8px 12px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.base,
    color: theme.text.primary,
    fontSize: 14,
    fontFamily: theme.font.body,
    outline: 'none',
  },
  error: {
    padding: '8px 12px',
    borderRadius: theme.radius.sm,
    backgroundColor: `${theme.danger}20`,
    border: `1px solid ${theme.danger}50`,
    color: theme.danger,
    fontSize: 13,
    fontFamily: theme.font.body,
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    padding: '8px 18px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: 'transparent',
    color: theme.text.secondary,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
  },
  createBtn: {
    padding: '8px 22px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.gold.border}`,
    background: `linear-gradient(135deg, ${theme.gold.dim}, ${theme.gold.primary})`,
    color: '#0a0a12',
    fontSize: 13,
    fontWeight: 700,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
};
