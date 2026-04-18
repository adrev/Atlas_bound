import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_KBRT_THEME,
  type KbrtThemeId,
  loadSavedKbrtTheme,
  saveKbrtTheme,
} from './themes';

/**
 * State hook that owns the active KBRT theme for the redesign subtree.
 *
 * The hook returns the current theme id plus a setter that also persists
 * the choice to localStorage. Callers are expected to spread the returned
 * `id` into a `data-theme` attribute on whatever `.kbrt` root they mount:
 *
 *     const { theme, setTheme } = useKbrtTheme();
 *     return <div className="kbrt" data-theme={theme}>...</div>;
 *
 * Scoping the attribute to the `.kbrt` root (not the document root) keeps
 * the redesign opt-in while the migration is underway — pages that haven't
 * been restyled yet see the legacy theme from `styles/theme.ts`.
 */
export function useKbrtTheme(): {
  theme: KbrtThemeId;
  setTheme: (id: KbrtThemeId) => void;
} {
  const [theme, setThemeState] = useState<KbrtThemeId>(DEFAULT_KBRT_THEME);

  useEffect(() => {
    setThemeState(loadSavedKbrtTheme());
  }, []);

  const setTheme = useCallback((id: KbrtThemeId) => {
    setThemeState(id);
    saveKbrtTheme(id);
  }, []);

  return { theme, setTheme };
}
