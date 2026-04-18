import type { ReactNode } from 'react';
import { useKbrtTheme } from './useKbrtTheme';

/**
 * Root wrapper that opts a subtree into the KBRT Illuminated Tome theme.
 *
 * All redesigned pages (login, lobby, game session) mount inside this. The
 * `data-theme` attribute drives the CSS variable overrides in `theme.css`.
 * Until legacy components are fully migrated, this wrapper stays scoped so
 * the rest of the app keeps its current look.
 */
export function KbrtRoot({ children }: { children: ReactNode }): JSX.Element {
  const { theme } = useKbrtTheme();
  return (
    <div className="kbrt" data-theme={theme}>
      {children}
    </div>
  );
}
