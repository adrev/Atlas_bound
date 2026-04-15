import { useState, useCallback } from 'react';
import { theme } from '../../styles/theme';
import { createMap } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import {
  emitLoadMap, emitPreviewLoadMap, emitListMaps,
} from '../../socket/emitters';
import { PREBUILT_MAPS, type MapCategory, type PrebuiltMap } from '../../data/prebuiltMaps';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'combat' | 'dungeon' | 'social' | 'rest';

const CATEGORY_LABELS: Record<MapCategory, string> = {
  combat: 'Combat',
  social: 'Social',
  dungeon: 'Dungeon',
  rest: 'Rest',
};

const CATEGORY_COLORS: Record<MapCategory, string> = {
  combat: '#c0392b',
  social: '#2980b9',
  dungeon: '#8e44ad',
  rest: '#27ae60',
};

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'combat', label: 'Combat / Encounters' },
  { key: 'dungeon', label: 'Dungeon / Lairs' },
  { key: 'social', label: 'Social / City' },
  { key: 'rest', label: 'Rest / Camp' },
];

// ---------------------------------------------------------------------------
// Seeded random number generator (mulberry32)
// ---------------------------------------------------------------------------
// MapThumbnail component
// ---------------------------------------------------------------------------

function MapThumbnail({ map }: { map: PrebuiltMap }) {
  return (
    <img
      src={map.imageFile}
      alt={map.name}
      style={{
        width: 260,
        height: 160,
        display: 'block',
        borderRadius: theme.radius.md,
        objectFit: 'cover',
      }}
      loading="lazy"
    />
  );
}

// ---------------------------------------------------------------------------
// PrebuiltMapGallery
// ---------------------------------------------------------------------------

interface PrebuiltMapGalleryProps {
  onMapLoaded?: () => void;
}

export function PrebuiltMapGallery({ onMapLoaded }: PrebuiltMapGalleryProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const settings = useSessionStore((s) => s.settings);
  const isDM = useSessionStore((s) => s.isDM);
  const playerMapId = useMapStore((s) => s.playerMapId);

  const [filter, setFilter] = useState<FilterTab>('all');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredMaps = PREBUILT_MAPS.filter((m) => {
    if (filter === 'all') return true;
    if (filter === 'combat') return m.category === 'combat';
    if (filter === 'dungeon') return m.category === 'dungeon';
    if (filter === 'rest') return m.category === 'rest';
    return m.category === 'social';
  });

  const handleLoad = useCallback(
    async (map: PrebuiltMap) => {
      if (!sessionId) return;
      setLoadingId(map.id);
      setError(null);

      try {
        const gridSize = settings.gridSize || 70;
        const mapWidth = map.gridCols * gridSize;
        const mapHeight = map.gridRows * gridSize;
        // Pass prebuiltKey so the server dedups by name — clicking
        // Goblin Camp twice returns the same row and preserves any
        // walls / fog / tokens the DM set up the first time.
        const result = await createMap(sessionId, {
          name: map.name,
          width: mapWidth,
          height: mapHeight,
          gridSize,
          prebuiltKey: map.id,
        });

        // Routing decision:
        //   • DM, and the session already has a ribbon → PREVIEW load
        //     (don't yank the players off their current map).
        //   • DM, no ribbon yet → ACTIVATE load (first map of the
        //     session; nothing to interrupt).
        //   • Non-DM (shouldn't normally happen, but for safety) →
        //     use the legacy `map:load` path.
        if (isDM && playerMapId) {
          emitPreviewLoadMap(result.id);
        } else {
          emitLoadMap(result.id);
        }
        // Refresh the scene manager so the new (or deduped) map
        // appears in the sidebar for the DM.
        emitListMaps();
        onMapLoaded?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load map');
      } finally {
        setLoadingId(null);
      }
    },
    [sessionId, settings.gridSize, isDM, playerMapId, onMapLoaded],
  );

  return (
    <div style={styles.container}>
      {/* Filter tabs */}
      <div style={styles.tabs}>
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            style={{
              ...styles.tab,
              ...(filter === tab.key ? styles.tabActive : {}),
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Map grid */}
      <div style={styles.grid}>
        {filteredMaps.map((map) => (
          <div key={map.id} style={styles.card}>
            <MapThumbnail map={map} />

            <div style={styles.cardBody}>
              <div style={styles.cardHeader}>
                <span style={styles.mapName}>{map.name}</span>
                <span
                  style={{
                    ...styles.badge,
                    backgroundColor: `${CATEGORY_COLORS[map.category]}30`,
                    color: CATEGORY_COLORS[map.category],
                    border: `1px solid ${CATEGORY_COLORS[map.category]}50`,
                  }}
                >
                  {CATEGORY_LABELS[map.category]}
                </span>
              </div>

              <p style={styles.description}>{map.description}</p>

              <div style={styles.cardFooter}>
                <span style={styles.gridInfo}>
                  {map.gridCols} x {map.gridRows} grid
                </span>
                <button
                  style={{
                    ...styles.loadButton,
                    opacity: loadingId === map.id ? 0.6 : 1,
                  }}
                  disabled={loadingId !== null}
                  onClick={() => handleLoad(map)}
                >
                  {loadingId === map.id ? 'Loading...' : 'Load Map'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  tabs: {
    display: 'flex',
    gap: 6,
    padding: '0 2px',
  },
  tab: {
    padding: '6px 14px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: 'transparent',
    color: theme.text.secondary,
    fontSize: 13,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  tabActive: {
    background: theme.gold.bg,
    // Use the full `border` shorthand (not just `borderColor`) so we
    // don't mix shorthand+longhand on the same element across renders —
    // React warns and it can drop the border entirely on some browsers.
    border: `1px solid ${theme.gold.border}`,
    color: theme.gold.primary,
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 14,
  },
  card: {
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.card,
    overflow: 'hidden',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  cardBody: {
    padding: '10px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  mapName: {
    fontSize: 14,
    fontWeight: 600,
    color: theme.text.primary,
    fontFamily: theme.font.display,
  },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 20,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    fontFamily: theme.font.body,
    whiteSpace: 'nowrap' as const,
  },
  description: {
    fontSize: 12,
    color: theme.text.secondary,
    margin: 0,
    lineHeight: 1.4,
    fontFamily: theme.font.body,
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  gridInfo: {
    fontSize: 11,
    color: theme.text.muted,
    fontFamily: theme.font.body,
  },
  loadButton: {
    padding: '5px 14px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.gold.border}`,
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
};
