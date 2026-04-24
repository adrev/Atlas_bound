/**
 * 5e RAW light-source specifications. PHB p.183 ("Vision and Light")
 * defines every mundane + magical light source by a bright-radius +
 * dim-radius pair; we encode them here so DMs can attach a torch to
 * a token and have the LightingLayer render per-RAW automatically
 * rather than typing numbers each time.
 *
 * Both radii are in FEET (not pixels). The LightingLayer converts
 * via gridSize × (feet/5) at render time.
 *
 * Ranges from PHB + SRD:
 *   Candle              5 ft bright / +5 ft dim   (PHB 152, 2 cp)
 *   Torch               20 ft bright / +20 ft dim (PHB 152, 1 cp)
 *   Lamp (oil)          15 ft bright / +30 ft dim (PHB 152, 5 sp)
 *   Hooded lantern      30 ft bright / +30 ft dim (PHB 152, 5 gp)
 *   Bullseye lantern    60 ft cone bright / +60 ft dim (PHB 152)
 *   Light cantrip       20 ft bright / +20 ft dim (PHB 255)
 *   Faerie Fire         —— outlines target only, no light
 *   Dancing Lights      10 ft per mote, moved as bonus action (PHB 230)
 *   Daylight            60 ft bright / +60 ft dim (PHB 230)
 *   Continual Flame     20 ft bright / +20 ft dim (= torch, PHB 227)
 *
 * Note `dim` in 5e is the ADDITIONAL distance beyond bright. Our
 * token schema stores `lightDimRadius` as the absolute outer edge
 * from the center (bright + dim combined), so the preset values
 * here include that addition already — e.g. a torch is
 * `{ bright: 20, dim: 40 }` not `{ bright: 20, dim: 20 }`.
 */
export interface LightSourcePreset {
  id: string;
  /** Display name for the DM picker. */
  label: string;
  /** Short emoji icon for the token / menu. */
  icon: string;
  /** Bright-light radius, feet from center. */
  bright: number;
  /** Dim-light outer radius, feet from center (bright + dim combined). */
  dim: number;
  /** Hex color for the glow tint. Torch = warm amber, spells = cool. */
  color: string;
  /** Whether the emitting object is typically animate (ignite flicker). */
  flicker?: boolean;
  /** Page reference to the rule so the wiki can link back. */
  ref?: string;
}

export const LIGHT_SOURCE_PRESETS: LightSourcePreset[] = [
  { id: 'candle',            label: 'Candle',              icon: '🕯️',  bright: 5,  dim: 10,  color: '#ffcc88', flicker: true,  ref: 'PHB 152' },
  { id: 'torch',             label: 'Torch',               icon: '🔥',  bright: 20, dim: 40,  color: '#ffaa55', flicker: true,  ref: 'PHB 152' },
  { id: 'lamp',              label: 'Lamp (oil)',          icon: '🪔',  bright: 15, dim: 45,  color: '#ffcc88', flicker: true,  ref: 'PHB 152' },
  { id: 'hooded-lantern',    label: 'Hooded Lantern',      icon: '🏮',  bright: 30, dim: 60,  color: '#ffcc66', flicker: false, ref: 'PHB 152' },
  { id: 'bullseye-lantern',  label: 'Bullseye Lantern',    icon: '🔦',  bright: 60, dim: 120, color: '#ffdd99', flicker: false, ref: 'PHB 152' },
  { id: 'light-cantrip',     label: 'Light (cantrip)',     icon: '✨',  bright: 20, dim: 40,  color: '#8cb4ff', flicker: false, ref: 'PHB 255' },
  { id: 'dancing-lights',    label: 'Dancing Lights',      icon: '💫',  bright: 10, dim: 20,  color: '#b4c8ff', flicker: false, ref: 'PHB 230' },
  { id: 'continual-flame',   label: 'Continual Flame',     icon: '🕯️',  bright: 20, dim: 40,  color: '#ffaa66', flicker: false, ref: 'PHB 227' },
  { id: 'daylight',          label: 'Daylight',            icon: '☀️',  bright: 60, dim: 120, color: '#fff8dd', flicker: false, ref: 'PHB 230' },
  { id: 'fire-pit',          label: 'Fire Pit',            icon: '🔥',  bright: 20, dim: 40,  color: '#ff7733', flicker: true,  ref: 'DMG 110' },
  { id: 'bonfire',           label: 'Bonfire',             icon: '🏕️',  bright: 30, dim: 60,  color: '#ff8844', flicker: true,  ref: 'Create Bonfire EEPC' },
];

/**
 * Look up a preset by the token name. Useful for auto-suggesting a
 * light source when the DM spawns a "Torch" or "Lantern" token —
 * they get the correct 5e radii applied instantly rather than typing
 * numbers into the sidebar.
 */
export function findLightPresetForName(name: string): LightSourcePreset | undefined {
  const n = name.toLowerCase();
  return LIGHT_SOURCE_PRESETS.find((p) =>
    n.includes(p.label.toLowerCase().split(' ')[0]),
  );
}
