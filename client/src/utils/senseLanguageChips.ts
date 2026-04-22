import type { CSSProperties } from 'react';

/**
 * Senses + Languages chip helpers shared between the creature
 * preview card (DM Tools → Creatures) and the full compendium
 * detail popup. Raw monster data stores both as comma-joined
 * prose like "darkvision 60 ft., passive Perception 15" — we
 * split into chips + color by family so polyglot monsters
 * (Corrupted Unicorn speaks Celestial + Elvish + Sylvan + telepathy)
 * are visually scannable rather than a prose blob.
 */

export function splitCommaList(raw: string): string[] {
  return raw
    .split(/[,;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Per-sense accent. Darkvision cold blue, truesight prismatic gold,
 * blindsight neutral, tremorsense earthy brown, passive perception
 * gentle gold so it reads as a "summary" rather than an active sense.
 */
export function accentForSense(entry: string): CSSProperties {
  const lower = entry.toLowerCase();
  if (lower.includes('truesight')) return { color: '#f1c40f', borderColor: '#f1c40f44', background: '#f1c40f14' };
  if (lower.includes('blindsight')) return { color: '#bdc3c7', borderColor: '#bdc3c744', background: '#bdc3c714' };
  if (lower.includes('tremorsense')) return { color: '#b07942', borderColor: '#b0794244', background: '#b0794214' };
  if (lower.includes('darkvision')) return { color: '#5dade2', borderColor: '#5dade244', background: '#5dade214' };
  if (lower.includes('passive perception')) return { color: '#e8c455', borderColor: '#e8c45544', background: '#e8c45514' };
  return { color: '#95a5a6', borderColor: '#95a5a644', background: '#95a5a614' };
}

/**
 * Per-language accent. Celestial gold, Infernal / Abyssal red,
 * Draconic orange, Elvish / Sylvan green, Dwarvish / Giant amber,
 * Undercommon / Deep Speech purple, Primordial dialects cool blue.
 * Telepathy gets a violet treatment since it's technically a
 * communication channel, not a language.
 */
export function accentForLanguage(entry: string): CSSProperties {
  const lower = entry.toLowerCase();
  if (/telepathy/.test(lower)) return { color: '#bb8fce', borderColor: '#bb8fce44', background: '#bb8fce14' };
  if (/celestial/.test(lower)) return { color: '#f7dc6f', borderColor: '#f7dc6f44', background: '#f7dc6f14' };
  if (/infernal|abyssal/.test(lower)) return { color: '#e74c3c', borderColor: '#e74c3c44', background: '#e74c3c14' };
  if (/draconic/.test(lower)) return { color: '#e67e22', borderColor: '#e67e2244', background: '#e67e2214' };
  if (/elvish|sylvan/.test(lower)) return { color: '#58d68d', borderColor: '#58d68d44', background: '#58d68d14' };
  if (/dwarvish|giant/.test(lower)) return { color: '#b9770e', borderColor: '#b9770e44', background: '#b9770e14' };
  if (/undercommon|deep speech/.test(lower)) return { color: '#9b59b6', borderColor: '#9b59b644', background: '#9b59b614' };
  if (/primordial|auran|ignan|terran|aquan/.test(lower)) return { color: '#5dade2', borderColor: '#5dade244', background: '#5dade214' };
  if (/common/.test(lower)) return { color: '#95a5a6', borderColor: '#95a5a644', background: '#95a5a614' };
  return { color: '#aeb6bf', borderColor: '#aeb6bf44', background: '#aeb6bf14' };
}

/** Base pill style for senses / languages — combine with an accent. */
export const SENSE_LANG_CHIP_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 10,
  fontWeight: 600,
  padding: '2px 7px',
  borderRadius: 4,
  border: '1px solid',
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
};
