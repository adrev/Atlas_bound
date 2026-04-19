import { useEffect, useRef, useState } from 'react';
import { Target } from 'lucide-react';
import type { Drawing } from '@dnd-vtt/shared';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitDrawingCreate } from '../../socket/emitters';
import { showToast } from '../ui';
import { theme } from '../../styles/theme';

/**
 * R9 follow-up — DM-only AoE preset palette. A small floating button
 * on the canvas top-left; clicking it opens a grid of 5e-common AoE
 * footprints (fireball 20ft, bolt 100ft, cube 10ft, etc.). Clicking a
 * preset creates a shared Drawing anchored on the DM's currently
 * selected token, or the map's center if no token is selected. The
 * existing chat command `!aoe` handles the keyboard path; this one
 * is the quick-pointer path.
 *
 * No arm-then-click state machine here — we discarded that early draft
 * because stitching a custom pointer handler into Konva without
 * disturbing the spell-target flow turned into scope creep. Place at
 * anchor + let the DM erase / re-place if the spot is wrong.
 */

type Shape = 'circle' | 'square' | 'line';

interface Preset {
  id: string;
  label: string;
  shape: Shape;
  feet: number;
  color: string;
  hint: string;
}

const PRESETS: Preset[] = [
  { id: 'fireball',   label: 'Fireball',    shape: 'circle', feet: 20, color: '#e74c3c', hint: 'Fireball / sphere — 20ft radius' },
  { id: 'sphere-10',  label: 'Sphere 10',   shape: 'circle', feet: 10, color: '#e67e22', hint: 'Radius 10ft' },
  { id: 'cone-15',    label: 'Cone 15',     shape: 'circle', feet: 15, color: '#f1c40f', hint: 'Cone approximation — 15ft' },
  { id: 'line-30',    label: 'Line 30',     shape: 'line',   feet: 30, color: '#3498db', hint: 'Line — 30ft (east from anchor)' },
  { id: 'bolt-100',   label: 'Bolt 100',    shape: 'line',   feet: 100, color: '#9b59b6', hint: 'Lightning bolt — 100ft line' },
  { id: 'cube-10',    label: 'Cube 10',     shape: 'square', feet: 10, color: '#27ae60', hint: 'Cube — 10ft side' },
];

export function AoePalette() {
  const isDM = useSessionStore((s) => s.isDM);
  const currentMap = useMapStore((s) => s.currentMap);
  const selectedTokenId = useMapStore((s) => s.selectedTokenId);
  const tokens = useMapStore((s) => s.tokens);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!isDM || !currentMap) return null;

  const placePreset = (preset: Preset) => {
    // Anchor: selected token, or map center if nothing selected.
    const selected = selectedTokenId ? tokens[selectedTokenId] : null;
    const anchorX = selected?.x ?? currentMap.width / 2;
    const anchorY = selected?.y ?? currentMap.height / 2;

    const gridSize = currentMap.gridSize || 70;
    const pxPerFt = gridSize / 5;
    const sizePx = preset.feet * pxPerFt;

    let kind: Drawing['kind'];
    let geometry: Drawing['geometry'];
    if (preset.shape === 'circle') {
      kind = 'circle';
      geometry = { circle: { x: anchorX, y: anchorY, radius: sizePx } };
    } else if (preset.shape === 'square') {
      kind = 'rect';
      geometry = {
        rect: { x: anchorX - sizePx / 2, y: anchorY - sizePx / 2, width: sizePx, height: sizePx },
      };
    } else {
      kind = 'line';
      geometry = { points: [anchorX, anchorY, anchorX + sizePx, anchorY] };
    }

    const drawing: Drawing = {
      id: crypto.randomUUID(),
      mapId: currentMap.id,
      creatorUserId: 'dm',
      creatorRole: 'dm',
      kind,
      visibility: 'shared',
      color: preset.color,
      strokeWidth: 3,
      geometry,
      gridSnapped: true,
      createdAt: Date.now(),
      fadeAfterMs: null,
    };
    emitDrawingCreate(drawing);
    setOpen(false);
    showToast({
      emoji: '🎯',
      message: selected
        ? `${preset.label} placed at ${selected.name}. Use the draw eraser to clear.`
        : `${preset.label} placed at map center. Select a token first to anchor AoEs.`,
      variant: 'info',
      duration: 3000,
    });
  };

  return (
    <div ref={rootRef} style={styles.wrapper}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="AoE templates — anchors on selected token"
        aria-expanded={open}
        style={{
          ...styles.trigger,
          background: open ? theme.gold.bg : 'rgba(10, 10, 18, 0.8)',
          color: open ? theme.gold.bright : theme.gold.primary,
        }}
      >
        <Target size={14} />
        <span style={styles.triggerLabel}>AoE</span>
      </button>
      {open && (
        <div style={styles.grid}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => placePreset(p)}
              title={p.hint}
              style={{ ...styles.preset, borderLeft: `3px solid ${p.color}` }}
            >
              <span style={styles.presetLabel}>{p.label}</span>
              <span style={styles.presetMeta}>{p.feet}ft · {p.shape}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'absolute',
    top: 64,
    left: 12,
    zIndex: 41,
    pointerEvents: 'auto',
  },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.gold.border}`,
    backdropFilter: 'blur(8px)',
    cursor: 'pointer',
    fontFamily: theme.font.body,
    transition: `all ${theme.motion.fast}`,
  },
  triggerLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  grid: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 6,
    padding: 8,
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 6,
    minWidth: 220,
    background: `linear-gradient(180deg, ${theme.bg.deepest} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
  },
  preset: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '6px 10px',
    background: 'transparent',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  presetLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: theme.text.primary,
    letterSpacing: '0.04em',
  },
  presetMeta: {
    fontSize: 9,
    color: theme.text.muted,
  },
};
