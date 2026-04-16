import { theme } from '../../../styles/theme';

/**
 * Shared color palette for all the TokenActionPanel subcomponents.
 * Lives here so both the main panel and the extracted sections
 * (DeadState, Traits, CreatureSpells, SensesLanguages, \u2026) share one
 * source of truth instead of each redefining their own.
 */
export const C = {
  bg: theme.bg.deep,
  bgCard: theme.bg.card,
  bgHover: theme.bg.hover,
  border: theme.border.default,
  borderDim: theme.border.default,
  text: theme.text.primary,
  textSec: theme.text.secondary,
  textMuted: theme.text.muted,
  red: theme.state.danger,
  green: theme.state.success,
  gold: theme.gold.primary,
  blue: theme.blue,
  purple: theme.purple,
};
