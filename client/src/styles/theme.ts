/**
 * Atlas Bound — "Dungeon Master Vibe" design tokens.
 *
 * This is the single source of truth for all colors, spacing, type,
 * motion, and elevation in the app. Components should never hardcode
 * hex values or pixel sizes — always import from here.
 *
 * The legacy `bg`, `gold`, `text`, `border`, `danger`, `hp`, `radius`,
 * `shadow`, `font` tokens remain UNCHANGED for backward compatibility
 * with components that haven't been migrated to the new primitives yet.
 * New code should prefer the expanded tokens (`space`, `type`, `motion`,
 * `focus`, `parchment`, `goldGlow`, `dangerGlow`, `ornate`, `state`).
 */
export const theme = {
  // ── Surfaces ────────────────────────────────────────────────
  bg: {
    deepest: '#0a0a12',
    deep: '#12121e',
    base: '#1a1a2e',
    card: '#1e1e32',
    elevated: '#252540',
    hover: '#2e2e4a',
  },

  // ── Gold (primary brand accent) ─────────────────────────────
  gold: {
    primary: '#d4a843',
    dim: '#c9952a',
    bright: '#e8c455',
    bg: 'rgba(212, 168, 67, 0.1)',
    border: 'rgba(212, 168, 67, 0.3)',
  },

  // ── Text ────────────────────────────────────────────────────
  text: {
    primary: '#e8e6e3',
    secondary: '#a09b94',
    muted: '#6b6660',
    gold: '#d4a843',
  },

  // ── Borders ─────────────────────────────────────────────────
  border: {
    default: '#3a3a52',
    light: '#4a4a62',
    gold: 'rgba(212, 168, 67, 0.4)',
  },

  // ── Semantic colors (legacy — prefer `state` below) ─────────
  danger: '#c0392b',
  dangerDim: '#a0301f',
  heal: '#27ae60',
  healDim: '#1e8449',
  purple: '#9b59b6',
  blue: '#3498db',
  whisper: '#8e44ad',
  hp: {
    full: '#27ae60',
    half: '#f39c12',
    low: '#c0392b',
  },

  // ── Corners ─────────────────────────────────────────────────
  radius: {
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
  },

  // ── Elevation (box shadows) ─────────────────────────────────
  shadow: {
    sm: '0 1px 3px rgba(0, 0, 0, 0.4)',
    md: '0 4px 12px rgba(0, 0, 0, 0.5)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.6)',
    gold: '0 0 12px rgba(212, 168, 67, 0.3)',
  },

  // ── Typography (legacy) ─────────────────────────────────────
  font: {
    body: "'Segoe UI', system-ui, -apple-system, sans-serif",
    display: "Georgia, 'Times New Roman', serif",
  },

  // ═══════════════════════════════════════════════════════════
  //                   EXPANDED TOKENS (NEW)
  // ═══════════════════════════════════════════════════════════

  // ── Spacing scale (4px base unit) ───────────────────────────
  // Import as: theme.space.md, etc. Use in place of raw numbers.
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
  // Each entry is a fully specified text style. Spread into a
  // style object: `style={{ ...theme.type.h1, color: theme.gold.primary }}`
  //
  // `h3` is the "section label" style — uppercase, gold dim,
  // letter-spaced — used across Sidebar tabs and DM Tools sections.
  type: {
    display: {
      fontSize: 22,
      fontWeight: 700,
      fontFamily: "Georgia, 'Times New Roman', serif",
      letterSpacing: '0.01em',
    } as const,
    h1: {
      fontSize: 18,
      fontWeight: 700,
      fontFamily: "Georgia, 'Times New Roman', serif",
    } as const,
    h2: {
      fontSize: 14,
      fontWeight: 700,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    } as const,
    h3: {
      fontSize: 11,
      fontWeight: 700,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      textTransform: 'uppercase' as const,
      letterSpacing: '0.08em',
    } as const,
    body: {
      fontSize: 13,
      fontWeight: 400,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    } as const,
    small: {
      fontSize: 11,
      fontWeight: 400,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    } as const,
    micro: {
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    } as const,
  },

  // ── Motion (animation timing) ───────────────────────────────
  // Import as: `transition: theme.motion.normal`
  motion: {
    fast: '0.12s ease',
    normal: '0.18s ease',
    slow: '0.3s ease',
  },

  // ── Focus ring (a11y) ───────────────────────────────────────
  // Apply to interactive elements on `:focus-visible`.
  focus: {
    ring: '0 0 0 2px rgba(212, 168, 67, 0.5)',
    ringDanger: '0 0 0 2px rgba(192, 57, 43, 0.5)',
  },

  // ── DM Vibe: warm parchment accents ─────────────────────────
  parchment: '#2a2418',
  parchmentEdge: '#3d3220',

  // ── DM Vibe: layered gold glow ──────────────────────────────
  // For primary buttons, ribbon cards, spell-slot highlights.
  goldGlow: {
    soft: '0 0 8px rgba(232, 196, 85, 0.25)',
    medium: '0 0 16px rgba(232, 196, 85, 0.4)',
    strong: '0 0 24px rgba(232, 196, 85, 0.55)',
  },

  // ── DM Vibe: danger glow ────────────────────────────────────
  // For critical hit results, OA modal, end-combat confirmations.
  dangerGlow: '0 0 14px rgba(192, 57, 43, 0.45)',

  // ── DM Vibe: ornate dividers ────────────────────────────────
  // Gradient divider used between sections for a more immersive
  // fantasy feel. Use on dividers that separate major sections;
  // don't overuse on dense screens.
  ornate: {
    divider:
      'linear-gradient(90deg, transparent, rgba(212,168,67,0.4) 30%, rgba(232,196,85,0.55) 50%, rgba(212,168,67,0.4) 70%, transparent)',
  },

  // ── Consolidated state colors ───────────────────────────────
  // Prefer these over the legacy top-level `danger`, `heal`, etc.
  // Used by Toast variants, Badge colors, HP bar tiers.
  state: {
    success: '#27ae60',
    successBg: 'rgba(39, 174, 96, 0.15)',
    warning: '#f39c12',
    warningBg: 'rgba(243, 156, 18, 0.15)',
    danger: '#c0392b',
    dangerBg: 'rgba(192, 57, 43, 0.15)',
    info: '#3498db',
    infoBg: 'rgba(52, 152, 219, 0.15)',
    dead: '#4a4040',
  },
} as const;
