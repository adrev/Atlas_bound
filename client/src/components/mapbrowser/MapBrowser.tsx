import { useState, useEffect } from 'react';
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
}

export function MapBrowser({ onMapLoaded }: MapBrowserProps) {
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
        <button style={styles.uploadBtn} onClick={() => setUploadOpen(true)}>
          <span style={styles.uploadIcon}>+</span>
          Upload Custom Map
        </button>
      </div>

      {/* Custom / Saved Maps */}
      {savedMaps.length > 0 && (
        <>
          <div style={styles.sectionTitle}>Your Maps ({savedMaps.length})</div>
          <div style={styles.savedGrid}>
            {savedMaps.map((map) => {
              // Prebuilt maps store imageUrl = null in the DB because
              // the image is a client-side asset. Fall back to the
              // prebuilt thumbnail lookup by name so the card actually
              // shows something instead of "No image".
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
            })}
          </div>
          <div style={styles.divider} />
        </>
      )}

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
  uploadBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 20px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.gold.border}`,
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  },
  uploadIcon: {
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1,
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
