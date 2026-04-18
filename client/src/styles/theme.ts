/**
 * Atlas Bound — "Illuminated Tome" design tokens.
 *
 * Values that have a CSS-variable equivalent in globals.css /
 * kbrt/theme.css return the `var(--token)` REFERENCE instead of a
 * literal hex. That means `style={{ color: theme.gold.primary }}`
 * renders as `color: var(--gold)`, which re-cascades whenever the
 * user flips a theme via the Tweaks panel. No component migration
 * required.
 *
 * Derived values (shadows, gradients, rgba overlays) stay as literal
 * strings — they compose from multiple sources, and the browser can
 * safely reference `var(...)` inside a shadow / gradient anyway.
 *
 * Shape is preserved so existing call sites keep working: `theme.bg`,
 * `theme.gold`, `theme.text`, `theme.state`, etc.
 *
 * A 5-theme variant (Tome / Parchment / Noir / Grove / Codex) is
 * layered on top by kbrt/theme.css overriding the same variables
 * inside each `[data-theme=…]` block.
 */
export const theme = {
  // ── Surfaces (Tome "ink" ladder) ────────────────────────────
  bg: {
    deepest: 'var(--bg-deepest)',
    deep: 'var(--bg-deep)',
    base: 'var(--bg-base)',
    card: 'var(--bg-card)',
    elevated: 'var(--bg-elevated)',
    hover: 'var(--bg-hover)',
  },

  // ── Gilt (primary brand accent) ─────────────────────────────
  gold: {
    primary: 'var(--gold)',
    dim: 'var(--gold-dim)',
    bright: 'var(--gold-bright)',
    bg: 'var(--gold-bg)',
    border: 'var(--gold-border)',
  },

  // ── Text — warm parchment cream ─────────────────────────────
  text: {
    primary: 'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    muted: 'var(--text-muted)',
    gold: 'var(--text-gold)',
  },

  // ── Borders ─────────────────────────────────────────────────
  border: {
    default: 'var(--border)',
    light: 'var(--border-light)',
    gold: 'var(--border-gold)',
  },

  // ── Semantic colors ─────────────────────────────────────────
  danger: 'var(--danger)',
  dangerDim: 'var(--danger-dim)',
  heal: 'var(--heal)',
  healDim: 'var(--heal-dim)',
  purple: 'var(--accent-purple)',
  blue: 'var(--accent-blue)',
  whisper: 'var(--whisper-purple)',
  hp: {
    full: 'var(--hp-full)',
    half: 'var(--hp-half)',
    low: 'var(--hp-low)',
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

  // ── Typography (reads live from the themed CSS vars) ────────
  font: {
    body: 'var(--font-body)',
    display: 'var(--font-display)',
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
  // Uses `var(--font-…)` so Cinzel / Spectral swap on theme change.
  type: {
    display: {
      fontSize: 22,
      fontWeight: 700,
      fontFamily: 'var(--font-display)',
      letterSpacing: '0.12em',
    } as const,
    h1: {
      fontSize: 18,
      fontWeight: 700,
      fontFamily: 'var(--font-display)',
      letterSpacing: '0.08em',
    } as const,
    h2: {
      fontSize: 14,
      fontWeight: 700,
      fontFamily: 'var(--font-display)',
      letterSpacing: '0.05em',
    } as const,
    h3: {
      fontSize: 11,
      fontWeight: 700,
      fontFamily: 'var(--font-display)',
      textTransform: 'uppercase' as const,
      letterSpacing: '0.18em',
    } as const,
    body: {
      fontSize: 13,
      fontWeight: 400,
      fontFamily: 'var(--font-body)',
    } as const,
    small: {
      fontSize: 11,
      fontWeight: 400,
      fontFamily: 'var(--font-body)',
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
  // Each has a BG pair. Non-gilt states keep their semantic color
  // across themes (success = green, danger = red) so HP / combat
  // cues don't invert visually when the Parchment / Codex theme
  // swaps the surface palette.
  state: {
    success: '#7aa266',
    successBg: 'rgba(122, 162, 102, 0.18)',
    warning: '#d4a843',
    warningBg: 'rgba(212, 168, 67, 0.18)',
    danger: 'var(--danger)',
    dangerBg: 'rgba(201, 66, 58, 0.18)',
    info: '#6aa9d1',
    infoBg: 'rgba(106, 169, 209, 0.18)',
    dead: '#4a3420',
  },
} as const;
