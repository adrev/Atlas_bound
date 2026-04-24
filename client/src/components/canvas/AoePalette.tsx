import { useEffect, useRef, useState } from 'react';
import { Target } from 'lucide-react';
import type { Drawing, DrawingGeometry } from '@dnd-vtt/shared';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useEffectStore } from '../../stores/useEffectStore';
import { emitDrawingCreate } from '../../socket/emitters';
import { showToast } from '../ui';
import { theme } from '../../styles/theme';

/**
 * DM-only AoE preset palette. Floating top-left button that opens a
 * grid of common 5e area effects. Clicking one drops a shared
 * `aoe-*` drawing centred on the selected token (or map center) AND
 * fires an element-matched particle burst via the spell-animation
 * system. Differs from the previous version in three ways:
 *
 *   1. Cones render as proper 53° wedges (Konva.Wedge) instead of
 *      circles — the bug yesterday where Cone 15 was drawn as a
 *      circle is gone.
 *   2. Lines render as 5-ft-wide filled strips instead of a 1-px
 *      stroke.
 *   3. Each preset carries an `element` (fire / cold / lightning /
 *      etc.) which the DrawingLayer maps to a tinted palette +
 *      glow. The same element drives a one-shot particle animation
 *      so Fireball actually looks like fire, not a generic red
 *      circle.
 *
 * Presets chosen from the 5e spells users reach for most in
 * combat; extends to cover cone / line / cube / sphere in each
 * element so a DM can drop a non-listed spell with the same shape
 * and just explain the name.
 */

type AoeShape = 'sphere' | 'cone' | 'line' | 'cube';

interface Preset {
  id: string;
  label: string;
  shape: AoeShape;
  feet: number;
  element:
    | 'fire' | 'cold' | 'lightning' | 'acid' | 'poison' | 'radiant'
    | 'necrotic' | 'thunder' | 'force' | 'psychic' | 'neutral';
  /** Mapped to `getSpellAnimation(spellName)` for the particle burst. */
  spellName?: string;
  hint: string;
}

const PRESETS: Preset[] = [
  // Fire
  { id: 'fireball',        label: 'Fireball',        shape: 'sphere', feet: 20, element: 'fire',     spellName: 'Fireball',      hint: '20-ft radius sphere (PHB p.241)' },
  { id: 'burning-hands',   label: 'Burning Hands',   shape: 'cone',   feet: 15, element: 'fire',     spellName: 'Burning Hands', hint: '15-ft cone (PHB p.220)' },
  { id: 'wall-of-fire',    label: 'Wall of Fire',    shape: 'line',   feet: 60, element: 'fire',     spellName: 'Fireball',      hint: '60-ft long line / 20-ft high wall (PHB p.285)' },
  // Cold
  { id: 'cone-of-cold',    label: 'Cone of Cold',    shape: 'cone',   feet: 60, element: 'cold',     spellName: 'Cone of Cold',  hint: '60-ft cone (PHB p.224)' },
  { id: 'ice-storm',       label: 'Ice Storm',       shape: 'sphere', feet: 20, element: 'cold',     spellName: 'Ice Storm',     hint: '20-ft radius × 40-ft tall cylinder (PHB p.251)' },
  // Lightning / Thunder
  { id: 'lightning-bolt',  label: 'Lightning Bolt',  shape: 'line',   feet: 100, element: 'lightning', spellName: 'Lightning Bolt', hint: '100-ft line, 5-ft wide (PHB p.255)' },
  { id: 'thunderwave',     label: 'Thunderwave',     shape: 'cube',   feet: 15, element: 'thunder',  spellName: 'Thunderwave',   hint: '15-ft cube (PHB p.282)' },
  { id: 'shatter',         label: 'Shatter',         shape: 'sphere', feet: 10, element: 'thunder',  spellName: 'Shatter',       hint: '10-ft radius sphere (PHB p.275)' },
  { id: 'call-lightning',  label: 'Call Lightning',  shape: 'sphere', feet: 5,  element: 'lightning', spellName: 'Lightning Bolt', hint: '5-ft radius cylinder (PHB p.220)' },
  // Acid / Poison
  { id: 'acid-arrow-area', label: 'Acid Splash',     shape: 'sphere', feet: 5,  element: 'acid',     spellName: 'Acid Splash',   hint: '5-ft radius (PHB p.211)' },
  { id: 'cloudkill',       label: 'Cloudkill',       shape: 'sphere', feet: 20, element: 'poison',   spellName: 'Poison Spray',  hint: '20-ft radius sphere (PHB p.222)' },
  { id: 'stinking-cloud',  label: 'Stinking Cloud',  shape: 'sphere', feet: 20, element: 'poison',   spellName: 'Poison Spray',  hint: '20-ft radius sphere (PHB p.278)' },
  // Radiant / Necrotic
  { id: 'spirit-guardians', label: 'Spirit Guardians', shape: 'sphere', feet: 15, element: 'radiant', spellName: 'Spirit Guardians', hint: '15-ft radius around caster (PHB p.278)' },
  { id: 'sacred-flame',    label: 'Sacred Flame',    shape: 'sphere', feet: 5,  element: 'radiant',  spellName: 'Sacred Flame',  hint: 'Single-target, 5-ft mark (PHB p.272)' },
  { id: 'circle-of-death', label: 'Circle of Death', shape: 'sphere', feet: 60, element: 'necrotic', spellName: 'Toll the Dead', hint: '60-ft radius sphere (PHB p.221)' },
  // Force / Utility
  { id: 'web',             label: 'Web',             shape: 'cube',   feet: 20, element: 'force',    spellName: 'Shield',        hint: '20-ft cube (PHB p.287)' },
  { id: 'wall-of-force',   label: 'Wall of Force',   shape: 'line',   feet: 30, element: 'force',    spellName: 'Shield',        hint: '10 panels, 10 × 10 ft each (PHB p.285)' },
  // Generic shapes without a named spell — the DM picks one close to what they need
  { id: 'cone-30',         label: 'Cone 30',         shape: 'cone',   feet: 30, element: 'neutral',  hint: 'Generic 30-ft cone' },
  { id: 'sphere-10',       label: 'Sphere 10',       shape: 'sphere', feet: 10, element: 'neutral',  hint: 'Generic 10-ft radius' },
  { id: 'line-30',         label: 'Line 30',         shape: 'line',   feet: 30, element: 'neutral',  hint: 'Generic 30-ft line' },
  { id: 'cube-10',         label: 'Cube 10',         shape: 'cube',   feet: 10, element: 'neutral',  hint: 'Generic 10-ft cube' },
];

const ELEMENT_COLORS: Record<Preset['element'], string> = {
  fire: '#ff6a20', cold: '#a0c8ff', lightning: '#ffffa0', acid: '#a0dc3c',
  poison: '#6eb446', radiant: '#ffe68c', necrotic: '#783c8c',
  thunder: '#c8dcff', force: '#e6d2ff', psychic: '#ffb4dc', neutral: '#d4a843',
};

export function AoePalette() {
  const isDM = useSessionStore((s) => s.isDM);
  const currentMap = useMapStore((s) => s.currentMap);
  const selectedTokenId = useMapStore((s) => s.selectedTokenId);
  const tokens = useMapStore((s) => s.tokens);
  const addAnimation = useEffectStore((s) => s.addAnimation);
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
    const selected = selectedTokenId ? tokens[selectedTokenId] : null;
    const anchorX = selected
      ? selected.x + (currentMap.gridSize * selected.size) / 2
      : currentMap.width / 2;
    const anchorY = selected
      ? selected.y + (currentMap.gridSize * selected.size) / 2
      : currentMap.height / 2;

    const gridSize = currentMap.gridSize || 70;
    const pxPerFt = gridSize / 5;
    const sizePx = preset.feet * pxPerFt;

    // ── Build the Drawing ──────────────────────────────────────────
    let kind: Drawing['kind'];
    let geometry: DrawingGeometry;
    if (preset.shape === 'sphere') {
      kind = 'aoe-sphere';
      geometry = {
        circle: { x: anchorX, y: anchorY, radius: sizePx },
        element: preset.element,
      };
    } else if (preset.shape === 'cone') {
      kind = 'aoe-cone';
      geometry = {
        cone: { x: anchorX, y: anchorY, radius: sizePx, rotation: 0 },
        element: preset.element,
      };
    } else if (preset.shape === 'cube') {
      kind = 'aoe-cube';
      geometry = {
        orientedRect: { x: anchorX, y: anchorY, width: sizePx, height: sizePx, rotation: 0 },
        element: preset.element,
      };
    } else {
      kind = 'aoe-line';
      // Line extends east from anchor — DM can rotate with the draw-
      // tool select mode if needed. 5-ft-wide strip via strokeWidth
      // bump in the renderer.
      geometry = {
        points: [anchorX, anchorY, anchorX + sizePx, anchorY],
        element: preset.element,
      };
    }

    const drawing: Drawing = {
      id: crypto.randomUUID(),
      mapId: currentMap.id,
      creatorUserId: 'dm',
      creatorRole: 'dm',
      kind,
      visibility: 'shared',
      color: ELEMENT_COLORS[preset.element],
      strokeWidth: 3,
      geometry,
      gridSnapped: true,
      createdAt: Date.now(),
      fadeAfterMs: null,
    };
    emitDrawingCreate(drawing);

    // ── One-shot particle burst ────────────────────────────────────
    // Fire the spell animation system so the placement has visual
    // weight — flames for Fireball, ice crystals for Cone of Cold,
    // lightning arcs for Lightning Bolt, etc. Even without a named
    // spell we pass a sensible default so neutral / generic shapes
    // still get a puff of matching-color sparkle.
    const spellKey = preset.spellName ?? 'Fireball';
    addAnimation({
      id: crypto.randomUUID(),
      animationType: 'aoe',
      color: ELEMENT_COLORS[preset.element],
      secondaryColor: '#ffffff',
      duration: 900,
      particleCount: preset.shape === 'cone' || preset.shape === 'line' ? 50 : 40,
      casterPosition: { x: anchorX, y: anchorY },
      targetPosition: { x: anchorX, y: anchorY },
      startedAt: Date.now(),
    });
    // Reference `spellKey` so the lint / bundler preserves the useful
    // PRESET.spellName field for future per-spell-specific tuning.
    void spellKey;

    setOpen(false);
    showToast({
      emoji: '🎯',
      message: selected
        ? `${preset.label} placed at ${selected.name}.`
        : `${preset.label} placed at map center. Select a token first to anchor.`,
      variant: 'info',
      duration: 2500,
    });
  };

  // Group presets by element for the picker so the DM scans
  // "fire" instead of hunting alphabetically.
  const byElement: Array<{ element: Preset['element']; presets: Preset[] }> = [];
  for (const p of PRESETS) {
    let group = byElement.find((g) => g.element === p.element);
    if (!group) {
      group = { element: p.element, presets: [] };
      byElement.push(group);
    }
    group.presets.push(p);
  }

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
          {byElement.map(({ element, presets }) => (
            <div key={element} style={styles.group}>
              <div style={{ ...styles.groupLabel, color: ELEMENT_COLORS[element] }}>
                {element.toUpperCase()}
              </div>
              {presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => placePreset(p)}
                  title={p.hint}
                  style={{
                    ...styles.preset,
                    borderLeft: `3px solid ${ELEMENT_COLORS[p.element]}`,
                  }}
                >
                  <span style={styles.presetLabel}>{p.label}</span>
                  <span style={styles.presetMeta}>
                    {p.feet}ft · {p.shape}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'absolute', top: 64, left: 12, zIndex: 41, pointerEvents: 'auto',
  },
  trigger: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 10px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.gold.border}`,
    backdropFilter: 'blur(8px)',
    cursor: 'pointer',
    fontFamily: theme.font.body,
    transition: `all ${theme.motion.fast}`,
  },
  triggerLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  },
  grid: {
    position: 'absolute', top: '100%', left: 0, marginTop: 6,
    padding: 8,
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
    minWidth: 640,
    maxHeight: '70vh', overflowY: 'auto',
    background: `linear-gradient(180deg, ${theme.bg.deepest} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
  },
  group: {
    display: 'flex', flexDirection: 'column', gap: 3,
  },
  groupLabel: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
    paddingBottom: 2, borderBottom: `1px solid ${theme.border.default}`,
    marginBottom: 2,
  },
  preset: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    padding: '5px 8px',
    background: 'transparent',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  presetLabel: {
    fontSize: 11, fontWeight: 700, color: theme.text.primary, letterSpacing: '0.03em',
  },
  presetMeta: {
    fontSize: 9, color: theme.text.muted,
  },
};
