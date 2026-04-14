import { useState, useRef, useEffect, useCallback } from 'react';
import { theme } from '../../styles/theme';
import { createMap } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import {
  emitLoadMap, emitPreviewLoadMap, emitListMaps,
} from '../../socket/emitters';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MapCategory = 'combat' | 'social' | 'dungeon' | 'rest';
type FilterTab = 'all' | 'combat' | 'social' | 'rest';

// Maps are hosted on GCS (same bucket as tokens/music/spells/items)
const MAPS_CDN = 'https://storage.googleapis.com/atlas-bound-data/maps';

interface PrebuiltMap {
  id: string;
  name: string;
  description: string;
  category: MapCategory;
  gridCols: number;
  gridRows: number;
  seed: number;
  imageFile: string;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// Curated prebuilt library. Each map has a clear story anchor (entry point,
// branching paths, natural cover, focal point). Images hosted on GCS.
const PREBUILT_MAPS: PrebuiltMap[] = [
  { id: 'apothecary-shop', name: 'Apothecary Shop', description: 'Cluttered shop with potions and herbs', category: 'social', gridCols: 15, gridRows: 15, seed: 1313, imageFile: `${MAPS_CDN}/apothecary-shop.png` },
  { id: 'elfsong-tavern', name: 'The Elfsong Tavern', description: 'Cozy two-floor inn with bar and hearth', category: 'social', gridCols: 25, gridRows: 20, seed: 909, imageFile: `${MAPS_CDN}/elfsong-tavern.png` },
  { id: 'cathedral-lathander', name: 'Cathedral of Lathander', description: 'Grand worship hall with stained glass', category: 'social', gridCols: 35, gridRows: 30, seed: 1111, imageFile: `${MAPS_CDN}/cathedral-lathander.png` },
  { id: 'druid-grove', name: 'Druid Grove', description: 'Sacred grove with stone circle', category: 'combat', gridCols: 35, gridRows: 35, seed: 303, imageFile: `${MAPS_CDN}/druid-grove.png` },
  { id: 'forest-road-ambush', name: 'Forest Road Ambush', description: 'Wooded path with fallen trees', category: 'combat', gridCols: 40, gridRows: 20, seed: 707, imageFile: `${MAPS_CDN}/forest-road-ambush.png` },
  { id: 'moonrise-towers', name: 'Moonrise Towers', description: 'Dark fortress courtyard', category: 'dungeon', gridCols: 40, gridRows: 40, seed: 404, imageFile: `${MAPS_CDN}/moonrise-towers.png` },
];

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
  { key: 'combat', label: 'Combat / Wilderness' },
  { key: 'social', label: 'Social / Interior' },
  { key: 'rest', label: 'Rest / Camp' },
];

// ---------------------------------------------------------------------------
// Seeded random number generator (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural canvas thumbnail generator
// ---------------------------------------------------------------------------

const PALETTE: Record<MapCategory, { bg: string; grid: string; features: string[] }> = {
  combat: {
    bg: '#2a3a1e',
    grid: 'rgba(60, 80, 40, 0.4)',
    features: ['#4a5a2e', '#3d4e25', '#556b2f', '#6b7f3f', '#8b6914', '#5c4a1e'],
  },
  social: {
    bg: '#3a2e1e',
    grid: 'rgba(90, 70, 50, 0.4)',
    features: ['#5a4a35', '#6b5b46', '#4e3e2e', '#7a6a50', '#8b7960', '#d4a843'],
  },
  dungeon: {
    bg: '#1a1a28',
    grid: 'rgba(50, 50, 80, 0.35)',
    features: ['#2a2a3e', '#3a3a55', '#4e2a5e', '#5a3a6e', '#6a4a7e', '#2e4a5a'],
  },
  rest: {
    bg: '#1f2e1a',
    grid: 'rgba(60, 90, 50, 0.35)',
    features: ['#2e4a28', '#3e5a35', '#8b6914', '#a67c1f', '#5a4a35', '#3e5a2e'],
  },
};

function generateThumbnail(
  canvas: HTMLCanvasElement,
  map: PrebuiltMap,
  width: number,
  height: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  const palette = PALETTE[map.category];
  const rng = mulberry32(map.seed);

  // Background
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  // Subtle noise texture
  for (let i = 0; i < 300; i++) {
    const x = rng() * width;
    const y = rng() * height;
    const a = rng() * 0.15;
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Feature rectangles (rooms / terrain patches)
  const featureCount = 4 + Math.floor(rng() * 6);
  for (let i = 0; i < featureCount; i++) {
    const color = palette.features[Math.floor(rng() * palette.features.length)];
    const fx = rng() * width * 0.8;
    const fy = rng() * height * 0.8;
    const fw = 20 + rng() * (width * 0.35);
    const fh = 20 + rng() * (height * 0.35);
    const radius = 2 + rng() * 4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(fx, fy, fw, fh, radius);
    ctx.fill();
  }

  // Small accent details (circles for pools / fires / objects)
  const detailCount = 3 + Math.floor(rng() * 5);
  for (let i = 0; i < detailCount; i++) {
    const dx = rng() * width;
    const dy = rng() * height;
    const dr = 3 + rng() * 8;
    const alpha = 0.3 + rng() * 0.5;
    ctx.fillStyle =
      map.category === 'dungeon'
        ? `rgba(100, 180, 220, ${alpha})`
        : map.category === 'combat'
          ? `rgba(200, 120, 30, ${alpha})`
          : `rgba(212, 168, 67, ${alpha})`;
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Grid lines
  const cellW = width / map.gridCols;
  const cellH = height / map.gridRows;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 0.5;
  for (let col = 1; col < map.gridCols; col++) {
    const x = col * cellW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let row = 1; row < map.gridRows; row++) {
    const y = row * cellH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Vignette overlay
  const gradient = ctx.createRadialGradient(
    width / 2, height / 2, width * 0.25,
    width / 2, height / 2, width * 0.7,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

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
    if (filter === 'combat') return m.category === 'combat' || m.category === 'dungeon';
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
    borderColor: theme.gold.border,
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
