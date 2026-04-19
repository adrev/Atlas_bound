import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useKbrtTheme } from './useKbrtTheme';
import { KBRT_THEMES, type KbrtThemeId } from './themes';

/**
 * Floating tweaks panel — toggles the active KBRT theme (and could
 * grow ornament / seal / sidebar-side knobs from the design-handoff
 * TWEAKS state later). Rendered in a portal-style fixed container
 * so it floats above everything, matching .tweaks in KBRT.html.
 *
 * The theme switch applies immediately because useKbrtTheme writes
 * the data-theme attribute to the `.kbrt` root we mount on
 * <html> in main.tsx. localStorage persistence is handled by the
 * hook itself, so reloads keep the player's choice.
 */
export function TweaksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, setTheme } = useKbrtTheme();

  // Keep the document's data-theme in sync whenever the hook state
  // changes — the setter updates React state + localStorage, this
  // effect pushes it onto the DOM so CSS variables swap live.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Tome tweaks"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 150,
        width: 288,
        background: 'var(--bg-panel, #140e07)',
        border: '1px solid var(--border-line-strong, rgba(199,150,50,0.55))',
        borderRadius: 4,
        boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-line, rgba(199,150,50,0.3))',
          fontFamily: 'var(--font-display)',
          fontSize: 13,
          letterSpacing: '3px',
          color: 'var(--accent, #e0b44f)',
          textTransform: 'uppercase',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>Tweaks</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tweaks"
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 24,
            height: 24,
            borderRadius: 3,
            background: 'transparent',
            border: '1px solid transparent',
            color: 'var(--text-secondary, #a89271)',
            cursor: 'pointer',
          }}
        >
          <X size={12} />
        </button>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 10,
              letterSpacing: '2px',
              color: 'var(--text-secondary, #a89271)',
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            Theme
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {KBRT_THEMES.map((t) => (
              <ThemeSwatch
                key={t.id}
                id={t.id}
                name={t.name}
                bg={t.swatchBg}
                accent={t.swatchAccent}
                active={theme === t.id}
                onClick={() => setTheme(t.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemeSwatch({
  id,
  name,
  bg,
  accent,
  active,
  onClick,
}: {
  id: KbrtThemeId;
  name: string;
  bg: string;
  accent: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`Switch to ${name}`}
      style={{
        position: 'relative',
        height: 38,
        borderRadius: 3,
        cursor: 'pointer',
        overflow: 'hidden',
        border: `2px solid ${active ? '#fff' : 'transparent'}`,
        background: bg,
        padding: 0,
        boxShadow: active ? '0 0 0 1px rgba(0,0,0,0.5)' : 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 6px ${accent}`,
        }}
      />
      <span
        style={{
          position: 'absolute',
          bottom: 2,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: 'var(--font-display)',
          fontSize: 8,
          color: '#fff',
          textShadow: '0 1px 2px rgba(0,0,0,0.9)',
          letterSpacing: '1px',
        }}
      >
        {/* id is unused externally but still available for keyed test hooks */}
        <span data-kbrt-theme-id={id}>{name}</span>
      </span>
    </button>
  );
}
