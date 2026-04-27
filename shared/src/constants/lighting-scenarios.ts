import type { AmbientLight } from '../types/map.js';

/**
 * 5e RAW lighting scenarios. PHB p.183 + DMG p.243 spell out what
 * each environment + time of day looks like; this table encodes them
 * so the DM can pick "Outdoor — Dusk" or "Underground — Lit Corridor"
 * when activating a map and have the ambient tier + opacity match
 * the rules without typing numbers in.
 *
 * `tier` drives mechanical effects (`vision-tier.ts`):
 *   bright  → no obscurement
 *   dim     → lightly obscured (Perception sight disadvantage)
 *   dark    → heavily obscured (effectively blinded looking in)
 *   custom  → engine maps opacity bands to tiers (≤0.25 bright,
 *             0.25-0.7 dim, >0.7 dark) so a "twilight" preset can
 *             sit between dim and bright.
 *
 * `opacity` is only used when `tier === 'custom'` — it controls the
 * darkness overlay's alpha at render time. Roughly:
 *   0.10  near-bright (overcast indoors, midday under canopy)
 *   0.30  twilight (just after sunset, before dusk proper)
 *   0.45  matches the canonical 'dim' preset
 *   0.60  deep dim (heavy moonlight + clouds)
 *   0.85  matches the canonical 'dark' preset
 *   1.00  magical darkness (defeats darkvision)
 *
 * Sources annotated for traceability:
 *   PHB 183  — Vision and Light table
 *   DMG 243  — Wilderness Hazards: Heat, Cold, Weather (visibility)
 *   DMG 110  — Dungeon hazards / lighting
 *   PHB 152  — Adventuring gear: torches, lanterns, candles
 */
export interface LightingScenario {
  id: string;
  label: string;
  group: 'outdoor' | 'indoor' | 'underground' | 'magical';
  /** Short emoji for the picker. */
  icon: string;
  tier: AmbientLight;
  /** Only consulted when tier === 'custom'. */
  opacity?: number;
  /** One-liner for the picker tooltip. */
  hint: string;
  ref: string;
}

export const LIGHTING_SCENARIOS: LightingScenario[] = [
  // ── Outdoor ─────────────────────────────────────────────────
  { id: 'outdoor-noon',          label: 'Noon (clear day)',    group: 'outdoor',     icon: '☀️',  tier: 'bright', hint: 'Direct sun, full visibility — see normally to the horizon.', ref: 'PHB 183' },
  { id: 'outdoor-overcast',      label: 'Overcast Day',        group: 'outdoor',     icon: '☁️',  tier: 'custom', opacity: 0.10, hint: 'Overcast / heavy clouds — slightly muted but still bright.', ref: 'PHB 183' },
  { id: 'outdoor-twilight',      label: 'Twilight',            group: 'outdoor',     icon: '🌆',  tier: 'custom', opacity: 0.30, hint: 'Sun below horizon, sky still glowing — between bright and dim.', ref: 'PHB 183' },
  { id: 'outdoor-moonlit',       label: 'Moonlit Night',       group: 'outdoor',     icon: '🌕',  tier: 'dim',                  hint: 'Full moon — entire battlefield treated as dim light.', ref: 'PHB 183' },
  { id: 'outdoor-starlight',     label: 'Starlight',           group: 'outdoor',     icon: '✨',  tier: 'custom', opacity: 0.65, hint: 'New moon, clear sky — beyond dim, on the verge of dark.', ref: 'PHB 183' },
  { id: 'outdoor-night',         label: 'Overcast Night',      group: 'outdoor',     icon: '🌑',  tier: 'dark',                 hint: 'Moonless / clouded — heavy obscurement, darkvision required.', ref: 'PHB 183' },
  { id: 'outdoor-fog',           label: 'Heavy Fog',           group: 'outdoor',     icon: '🌫️',  tier: 'dark',                 hint: 'Fog blocks sight at any time of day — heavily obscured.', ref: 'DMG 110' },

  // ── Indoor ──────────────────────────────────────────────────
  { id: 'indoor-lit',            label: 'Well-Lit Room',       group: 'indoor',      icon: '💡',  tier: 'bright', hint: 'Hearth + lanterns + open windows — bright everywhere.', ref: 'PHB 183' },
  { id: 'indoor-candlelit',      label: 'Candlelit Hall',      group: 'indoor',      icon: '🕯️',  tier: 'dim',                  hint: 'Sparse candles / hearths — dim corridors with bright pools at the sources.', ref: 'PHB 152' },
  { id: 'indoor-tavern',         label: 'Tavern (warm)',       group: 'indoor',      icon: '🏠',  tier: 'custom', opacity: 0.20, hint: 'Hearth + lanterns, smoke-tinted air — bright with subtle warm haze.', ref: 'PHB 183' },
  { id: 'indoor-shuttered',      label: 'Shuttered Building',  group: 'indoor',      icon: '🚪',  tier: 'custom', opacity: 0.55, hint: 'Closed shutters / no fire — between dim and dark.', ref: 'PHB 183' },
  { id: 'indoor-pitch-black',    label: 'Pitch-Black Room',    group: 'indoor',      icon: '⚫',  tier: 'dark',                 hint: 'Sealed cellar / closed crypt — heavily obscured without light.', ref: 'PHB 183' },

  // ── Underground / Dungeon ───────────────────────────────────
  { id: 'underground-torchlit',  label: 'Torch-Lit Corridor',  group: 'underground', icon: '🔥',  tier: 'dim',                  hint: 'Sconces every 20 ft — bright pools + dim between, fade-out beyond.', ref: 'DMG 110' },
  { id: 'underground-cavern',    label: 'Bioluminescent Cave', group: 'underground', icon: '🍄',  tier: 'custom', opacity: 0.50, hint: 'Glowing fungi / phosphorescent moss — dim ambient, no source tokens needed.', ref: 'DMG 110' },
  { id: 'underground-dungeon',   label: 'Unlit Dungeon',       group: 'underground', icon: '🗝️',  tier: 'dark',                 hint: 'No lights at all — heavily obscured, party brings their own torches.', ref: 'DMG 110' },
  { id: 'underground-deep',      label: 'Underdark',           group: 'underground', icon: '🕸️',  tier: 'dark',                 hint: 'Deep underground, no surface light reaches — RAW dark.', ref: 'DMG 110' },

  // ── Magical / Special ──────────────────────────────────────
  { id: 'magical-daylight',      label: 'Daylight (spell)',    group: 'magical',     icon: '🌟',  tier: 'bright', hint: 'Daylight spell or similar magical bright source covers the area.', ref: 'PHB 230' },
  { id: 'magical-darkness',      label: 'Magical Darkness',    group: 'magical',     icon: '🌌',  tier: 'custom', opacity: 1.00, hint: 'Darkness spell — even darkvision can\'t pierce it.', ref: 'PHB 230' },
  { id: 'magical-faerie',        label: 'Feywild Twilight',    group: 'magical',     icon: '🧚',  tier: 'custom', opacity: 0.35, hint: 'Permanent twilight of the Feywild — soft, between bright and dim.', ref: 'DMG 49' },
  { id: 'magical-shadowfell',    label: 'Shadowfell',          group: 'magical',     icon: '👤',  tier: 'custom', opacity: 0.75, hint: 'Plane of perpetual gloom — heavy dim, oppressive but not pitch black.', ref: 'DMG 50' },
];

/** Look up a scenario by id, falling back to undefined for unknown ids. */
export function findLightingScenario(id: string): LightingScenario | undefined {
  return LIGHTING_SCENARIOS.find((s) => s.id === id);
}

/** Group helper for the picker — preserves declared order within each group. */
export function lightingScenariosByGroup(): Record<LightingScenario['group'], LightingScenario[]> {
  const out: Record<LightingScenario['group'], LightingScenario[]> = {
    outdoor: [], indoor: [], underground: [], magical: [],
  };
  for (const s of LIGHTING_SCENARIOS) out[s.group].push(s);
  return out;
}
