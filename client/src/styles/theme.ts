/**
 * Atlas Bound — "Illuminated Tome" design tokens.
 *
 * Rebased onto the KBRT Tome palette during the design overhaul.
 * Legacy token shapes (`bg.deepest`, `gold.primary`, etc.) are preserved
 * so every component that spreads these through inline styles picks up
 * the new look automatically. The expanded tokens (`space`, `type`,
 * `motion`, `parchment`, `goldGlow`, `ornate`, `state`) were already
 * used for "DM Vibe" accents and keep their meaning under the new palette.
 *
 * Cross-reference: `styles/globals.css` exposes the same palette as CSS
 * variables for class-based styling, and `kbrt/theme.css` layers the full
 * 5-theme system (Tome / Parchment / Noir / Grove / Codex) inside any
 * `.kbrt` subtree.
 */
export const theme = {
  // ── Surfaces (Tome "ink" ladder) ────────────────────────────
  bg: {
    deepest: '#0a0604',
    deep: '#140e07',
    base: '#1a120a',
    card: '#1e1509',
    elevated: '#241810',
    hover: '#2f2216',
  },

  // ── Gilt (primary brand accent) ─────────────────────────────
  gold: {
    primary: '#e0b44f',
    dim: '#c79632',
    bright: '#f2d27a',
    bg: 'rgba(224, 180, 79, 0.12)',
    border: 'rgba(224, 180, 79, 0.35)',
  },

  // ── Text — warm parchment cream ─────────────────────────────
  text: {
    primary: '#ead6a8',
    secondary: '#a89271',
    muted: '#6b5a3f',
    gold: '#e0b44f',
  },

  // ── Borders ─────────────────────────────────────────────────
  border: {
    default: 'rgba(199, 150, 50, 0.30)',
    light: 'rgba(199, 150, 50, 0.55)',
    gold: 'rgba(224, 180, 79, 0.55)',
  },

  // ── Semantic colors (legacy — prefer `state` below) ─────────
  danger: '#c9423a',
  dangerDim: '#9d2a23',
  heal: '#7aa266',
  healDim: '#4c6c3f',
  purple: '#9e7bc6',
  blue: '#6aa9d1',
  whisper: '#9e7bc6',
  hp: {
    full: '#7aa266',
    half: '#d4a843',
    low: '#c9423a',
  },

  // ── Corners ─────────────────────────────────────────────────
  radius: {
    sm: 2,
    md: 4,
    lg: 6,
    xl: 10,
  },

  // ── Elevation (box shadows) ─────────────────────────────────
  shadow: {
    sm: '0 1px 3px rgba(0, 0, 0, 0.5)',
    md: '0 4px 12px rgba(0, 0, 0, 0.55)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.65)',
    gold: '0 0 14px rgba(224, 180, 79, 0.35)',
  },

  // ── Typography (Tome display + body) ────────────────────────
  font: {
    body: "'Spectral', 'Georgia', serif",
    display: "'Cinzel', 'Trajan Pro', serif",
  },

  // ═══════════════════════════════════════════════════════════
  //                   EXPANDED TOKENS
  // ═══════════════════════════════════════════════════════════

  // ── Spacing scale (4px base unit) ───────────────────────────
  space: {
    xxs: 2,
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16,
    xxl: 24,
    xxxl: 32,
  },

  // ── Type scale ──────────────────────────────────────────────
  // h3 is the "section label" style — uppercase, gold, letter-spaced.
  type: {
    display: {
      fontSize: 22,
      fontWeight: 700,
      fontFamily: "'Cinzel', 'Trajan Pro', serif",
      letterSpacing: '0.12em',
    } as const,
    h1: {
      fontSize: 18,
      fontWeight: 700,
      fontFamily: "'Cinzel', 'Trajan Pro', serif",
      letterSpacing: '0.08em',
    } as const,
    h2: {
      fontSize: 14,
      fontWeight: 700,
      fontFamily: "'Cinzel', 'Trajan Pro', serif",
      letterSpacing: '0.05em',
    } as const,
    h3: {
      fontSize: 11,
      fontWeight: 700,
      fontFamily: "'Cinzel', 'Trajan Pro', serif",
      textTransform: 'uppercase' as const,
      letterSpacing: '0.18em',
    } as const,
    body: {
      fontSize: 13,
      fontWeight: 400,
      fontFamily: "'Spectral', 'Georgia', serif",
    } as const,
    small: {
      fontSize: 11,
      fontWeight: 400,
      fontFamily: "'Spectral', 'Georgia', serif",
    } as const,
    micro: {
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'Inter', system-ui, sans-serif",
      letterSpacing: '0.1em',
      textTransform: 'uppercase' as const,
    } as const,
  },

  // ── Motion ──────────────────────────────────────────────────
  motion: {
    fast: '0.12s ease',
    normal: '0.15s ease',
    slow: '0.3s ease',
  },

  // ── Focus ring (a11y) ───────────────────────────────────────
  focus: {
    ring: '0 0 0 2px rgba(224, 180, 79, 0.55)',
    ringDanger: '0 0 0 2px rgba(201, 66, 58, 0.55)',
  },

  // ── Warm parchment accents ──────────────────────────────────
  parchment: '#2a1a0c',
  parchmentEdge: '#3d2416',

  // ── Layered gilt glow ───────────────────────────────────────
  goldGlow: {
    soft: '0 0 8px rgba(242, 210, 122, 0.28)',
    medium: '0 0 16px rgba(242, 210, 122, 0.42)',
    strong: '0 0 24px rgba(242, 210, 122, 0.6)',
  },

  // ── Danger / blood glow ─────────────────────────────────────
  dangerGlow: '0 0 14px rgba(201, 66, 58, 0.5)',

  // ── Ornate gold dividers ────────────────────────────────────
  ornate: {
    divider:
      'linear-gradient(90deg, transparent, rgba(224, 180, 79, 0.4) 30%, rgba(242, 210, 122, 0.6) 50%, rgba(224, 180, 79, 0.4) 70%, transparent)',
  },

  // ── Consolidated state colors ───────────────────────────────
  state: {
    success: '#7aa266',
    successBg: 'rgba(122, 162, 102, 0.18)',
    warning: '#d4a843',
    warningBg: 'rgba(212, 168, 67, 0.18)',
    danger: '#c9423a',
    dangerBg: 'rgba(201, 66, 58, 0.18)',
    info: '#6aa9d1',
    infoBg: 'rgba(106, 169, 209, 0.18)',
    dead: '#4a3420',
  },
} as const;
