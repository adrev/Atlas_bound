/**
 * KBRT Illuminated Tome — 5 swappable themes.
 *
 * Source of truth for theme definitions. The actual CSS lives in `./theme.css`
 * under `.kbrt[data-theme="<id>"]` selectors. This file is the TypeScript view
 * used by the Tweaks panel (swatches) and the `useKbrtTheme` hook.
 */
export type KbrtThemeId = 'tome' | 'parchment' | 'noir' | 'grove' | 'codex';

export interface KbrtThemeMeta {
  id: KbrtThemeId;
  name: string;
  description: string;
  swatchBg: string;
  swatchAccent: string;
}

export const KBRT_THEMES: readonly KbrtThemeMeta[] = [
  {
    id: 'tome',
    name: 'Tome',
    description: 'Dark parchment, Cinzel + Spectral, gold accents',
    swatchBg: 'linear-gradient(135deg, #0a0604, #2a1a0c)',
    swatchAccent: '#e0b44f',
  },
  {
    id: 'parchment',
    name: 'Parch',
    description: 'Light parchment, IM Fell English, blood-red accents',
    swatchBg: 'linear-gradient(135deg, #f3e3bc, #c9a063)',
    swatchAccent: '#8a1e1a',
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'High-contrast monochrome, red danger accents',
    swatchBg: 'linear-gradient(135deg, #0e0c0c, #3a1a18)',
    swatchAccent: '#c9423a',
  },
  {
    id: 'grove',
    name: 'Grove',
    description: 'Dark forest green, Marcellus display, burnt orange',
    swatchBg: 'linear-gradient(135deg, #0a1109, #2a4020)',
    swatchAccent: '#d48a3d',
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Deep indigo, Cormorant body, violet accents',
    swatchBg: 'linear-gradient(135deg, #06061a, #1a1a4a)',
    swatchAccent: '#9d7dff',
  },
] as const;

export const DEFAULT_KBRT_THEME: KbrtThemeId = 'tome';

const KBRT_THEME_STORAGE_KEY = 'kbrt_theme_v1';

export function loadSavedKbrtTheme(): KbrtThemeId {
  if (typeof window === 'undefined') return DEFAULT_KBRT_THEME;
  try {
    const saved = window.localStorage.getItem(KBRT_THEME_STORAGE_KEY);
    if (saved && KBRT_THEMES.some((t) => t.id === saved)) {
      return saved as KbrtThemeId;
    }
  } catch {
    // localStorage disabled or quota — fall through to default
  }
  return DEFAULT_KBRT_THEME;
}

export function saveKbrtTheme(id: KbrtThemeId): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KBRT_THEME_STORAGE_KEY, id);
  } catch {
    // localStorage disabled — non-fatal, theme just won't persist
  }
}
