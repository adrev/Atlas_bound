import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/globals.css';
import './kbrt/theme.css';
import { loadSavedKbrtTheme } from './kbrt/themes';

// Apply the KBRT Illuminated Tome class + saved theme to the document
// root BEFORE React mounts. That:
//   - activates every `.kbrt` CSS rule in kbrt/theme.css so the five
//     swappable palettes (tome / parchment / noir / grove / codex)
//     are available everywhere, not just inside a scoped subtree;
//   - prevents the FOUC where legacy defaults flash before React
//     mounts a <KbrtRoot> wrapper.
// Safe to run at module load because this file is only imported in the
// browser entry; the `typeof document` guard is defensive in case SSR
// ever renders the bundle.
if (typeof document !== 'undefined') {
  document.documentElement.classList.add('kbrt');
  document.documentElement.setAttribute('data-theme', loadSavedKbrtTheme());
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <ErrorBoundary>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ErrorBoundary>
);
