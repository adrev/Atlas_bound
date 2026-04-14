import { useState, useEffect, useCallback } from 'react';
import { theme } from '../../styles/theme';

/**
 * MapTransition — a full-screen overlay that plays a cinematic
 * fade-to-black transition when the DM switches the active map.
 *
 * Animation sequence:
 *   1. Current view fades to black  (300ms)
 *   2. Map name appears in gold     (800ms)
 *   3. Fade in to new map           (500ms)
 *
 * Total duration: ~1600ms
 *
 * Listens for `map-transition-start` CustomEvent with detail:
 *   { mapName: string }
 * Fired from the socket listener when a non-preview map:loaded arrives.
 */
export function MapTransition() {
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [mapName, setMapName] = useState('');
  const [phase, setPhase] = useState<'idle' | 'fade-out' | 'show-name' | 'fade-in'>('idle');

  const startTransition = useCallback((name: string) => {
    setMapName(name);
    setIsTransitioning(true);
    setPhase('fade-out');

    // Phase 1: fade to black (300ms)
    setTimeout(() => {
      setPhase('show-name');

      // Phase 2: show name on black screen (800ms)
      setTimeout(() => {
        setPhase('fade-in');

        // Phase 3: fade in new map (500ms)
        setTimeout(() => {
          setIsTransitioning(false);
          setPhase('idle');
        }, 500);
      }, 800);
    }, 300);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mapName?: string };
      startTransition(detail?.mapName || 'Unknown');
    };
    window.addEventListener('map-transition-start', handler);
    return () => window.removeEventListener('map-transition-start', handler);
  }, [startTransition]);

  if (!isTransitioning) return null;

  return (
    <div style={overlayStyles.wrapper}>
      {/* Black overlay */}
      <div
        style={{
          ...overlayStyles.overlay,
          opacity: phase === 'fade-out' ? 1 : phase === 'show-name' ? 1 : 0,
          transition: phase === 'fade-out'
            ? 'opacity 300ms ease-in'
            : phase === 'fade-in'
              ? 'opacity 500ms ease-out'
              : 'none',
        }}
      />

      {/* Map name text — only visible during show-name phase */}
      {(phase === 'show-name' || phase === 'fade-in') && (
        <div
          style={{
            ...overlayStyles.nameContainer,
            opacity: phase === 'show-name' ? 1 : 0,
            transition: phase === 'fade-in' ? 'opacity 400ms ease-out' : 'opacity 200ms ease-in',
          }}
        >
          <div style={overlayStyles.nameText}>{mapName}</div>
          <div style={overlayStyles.nameUnderline} />
        </div>
      )}

      <style>{`
        @keyframes mapNameSlideIn {
          from { transform: translateY(10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

const overlayStyles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'absolute',
    inset: 0,
    zIndex: 60,
    pointerEvents: 'none',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    background: '#000',
    opacity: 0,
  },
  nameContainer: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
    animation: 'mapNameSlideIn 300ms ease-out',
  },
  nameText: {
    fontSize: 32,
    fontWeight: 700,
    fontFamily: theme.font.display,
    color: theme.gold.primary,
    textShadow: `0 0 20px rgba(212, 168, 67, 0.6), 0 0 40px rgba(212, 168, 67, 0.3)`,
    letterSpacing: '0.06em',
    textAlign: 'center',
    padding: '0 24px',
  },
  nameUnderline: {
    width: 120,
    height: 2,
    marginTop: 12,
    background: `linear-gradient(90deg, transparent, ${theme.gold.primary}, transparent)`,
    opacity: 0.6,
  },
};
