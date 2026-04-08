import { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { emitLoadMap } from '../../socket/emitters';
import { PrebuiltMapGallery } from './PrebuiltMapGallery';
import { MapUpload } from './MapUpload';
import { getMapThumbnail } from '../../utils/prebuiltMapImages';

interface SavedMap {
  id: string;
  name: string;
  imageUrl: string | null;
  width: number;
  height: number;
  gridSize: number;
  gridType: string;
  createdAt: string;
}

interface MapBrowserProps {
  onMapLoaded?: () => void;
  /** Optional dismiss handler. When provided, a close X is shown
   *  next to the Upload button in the header. Omit for the initial
   *  "no map yet" state where the DM must pick before closing. */
  onClose?: () => void;
}

export function MapBrowser({ onMapLoaded, onClose }: MapBrowserProps) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [savedMaps, setSavedMaps] = useState<SavedMap[]>([]);
  const sessionId = useSessionStore((s) => s.sessionId);
  const setMap = useMapStore((s) => s.setMap);
  const setCurrentMapId = useSessionStore((s) => s.setCurrentMapId);

  // Fetch saved maps for this session
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/maps`)
      .then((r) => r.ok ? r.json() : [])
      .then((maps) => setSavedMaps(maps))
      .catch(() => {});
  }, [sessionId, uploadOpen]); // refetch when upload modal closes

  const handleLoadSaved = (map: SavedMap) => {
    setCurrentMapId(map.id);
    setMap({
      id: map.id,
      name: map.name,
      imageUrl: map.imageUrl,
      width: map.width,
      height: map.height,
      gridSize: map.gridSize,
      gridType: (map.gridType as 'square' | 'hex') || 'square',
      gridOffsetX: 0,
      gridOffsetY: 0,
    });
    emitLoadMap(map.id);
    onMapLoaded?.();
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>Map Browser</h2>
          <p style={styles.subtitle}>Select a pre-built map or upload your own</p>
        </div>
        <div style={styles.headerActions}>
          <button
            style={styles.uploadBtn}
            onClick={() => setUploadOpen(true)}
            onMouseEnter={(e) => { e.currentTarget.style.background = `linear-gradient(135deg, ${theme.gold.dim}, ${theme.gold.bright})`; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = theme.gold.bg; }}
          >
            <Plus size={14} strokeWidth={2.5} />
            Upload Custom Map
          </button>
          {onClose && (
            <button
              style={styles.closeBtn}
              onClick={onClose}
              title="Close"
              aria-label="Close map browser"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = theme.bg.hover;
                e.currentTarget.style.color = theme.gold.bright;
                e.currentTarget.style.borderColor = theme.gold.primary;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = theme.bg.elevated;
                e.currentTarget.style.color = theme.gold.primary;
                e.currentTarget.style.borderColor = theme.gold.border;
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/*
        Split saved maps into two sections:
          • Recent Maps — scenes loaded into this session from the
            prebuilt library (imageUrl is null because the asset lives
            client-side). Shows what the DM has actually been using.
          • My Maps — user-uploaded custom images (imageUrl is set).
            Scoped like Homebrew in the compendium so the DM can find
            their own uploads without scrolling past prebuilts.
      */}
      {(() => {
        const uploadedMaps = savedMaps.filter((m) => !!m.imageUrl);
        const recentMaps = savedMaps.filter((m) => !m.imageUrl);
        const renderCard = (map: SavedMap) => {
          const thumbSrc = getMapThumbnail(map);
          return (
            <div key={map.id} style={styles.savedCard}>
              <div style={styles.savedThumb}>
                {thumbSrc ? (
                  <img src={thumbSrc} alt={map.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', background: theme.bg.elevated, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.muted, fontSize: 11 }}>No image</div>
                )}
              </div>
              <div style={styles.savedInfo}>
                <div style={{ fontWeight: 600, color: theme.text.primary, fontSize: 13 }}>{map.name}</div>
                <div style={{ fontSize: 10, color: theme.text.muted }}>{Math.round(map.width / map.gridSize)}x{Math.round(map.height / map.gridSize)} grid</div>
              </div>
              <button style={styles.loadBtn} onClick={() => handleLoadSaved(map)}>Load</button>
            </div>
          );
        };
        return (
          <>
            {recentMaps.length > 0 && (
              <>
                <div style={styles.sectionTitle}>Recent Maps ({recentMaps.length})</div>
                <div style={styles.savedGrid}>{recentMaps.map(renderCard)}</div>
                <div style={styles.divider} />
              </>
            )}
            {uploadedMaps.length > 0 && (
              <>
                <div style={styles.sectionTitle}>My Maps ({uploadedMaps.length})</div>
                <div style={styles.savedGrid}>{uploadedMaps.map(renderCard)}</div>
                <div style={styles.divider} />
              </>
            )}
          </>
        );
      })()}

      <div style={styles.sectionTitle}>Pre-Built Maps</div>
      <PrebuiltMapGallery onMapLoaded={onMapLoaded} />

      <MapUpload
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onMapCreated={() => { setUploadOpen(false); onMapLoaded?.(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: 20,
    background: theme.bg.deepest,
    minHeight: '100%',
    fontFamily: theme.font.body,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 22,
    fontFamily: theme.font.display,
    color: theme.gold.primary,
    letterSpacing: '0.02em',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 13,
    color: theme.text.secondary,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  uploadBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 20px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.gold.border}`,
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
    whiteSpace: 'nowrap',
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    padding: 0,
    background: theme.bg.elevated,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.gold.primary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
    flexShrink: 0,
  },
  divider: {
    height: 1,
    background: `linear-gradient(90deg, transparent, ${theme.border.default}, transparent)`,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: theme.gold.dim,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  savedGrid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  savedCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 8px',
    background: theme.bg.card,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
  },
  savedThumb: {
    width: 60,
    height: 40,
    borderRadius: 6,
    overflow: 'hidden' as const,
    flexShrink: 0,
  },
  savedInfo: {
    flex: 1,
    minWidth: 0,
  },
  loadBtn: {
    padding: '4px 14px',
    fontSize: 11,
    fontWeight: 600,
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.gold.primary,
    cursor: 'pointer',
    flexShrink: 0,
  },
};
