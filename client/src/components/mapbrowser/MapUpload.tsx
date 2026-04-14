import { useState, useEffect, useCallback } from 'react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import {
  emitLoadMap, emitPreviewLoadMap, emitListMaps,
} from '../../socket/emitters';
import { GridAligner } from './GridAligner';
import type { GridSettings } from './GridAligner';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCEPTED_TYPES = '.jpg,.jpeg,.png,.webp';
const DEFAULT_GRID_SIZE = 70;

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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    };
    img.src = url;
  }, []);

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

        {/* Grid alignment overlay */}
        {previewUrl && imageDims && (
          <GridAligner
            imageUrl={previewUrl}
            imageDims={imageDims}
            grid={grid}
            onGridChange={setGrid}
          />
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
