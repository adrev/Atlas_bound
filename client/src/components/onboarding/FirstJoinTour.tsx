import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { theme } from '../../styles/theme';

/**
 * P6 — Four-step first-join tour. Shown once per browser (localStorage
 * gate). A player opening the app for the first time gets a quick
 * rundown of the map, their token, the dice tray, and the action bar
 * — no copy about the sidebar panels because those are discoverable
 * and vary by DM settings.
 *
 * No library dependency — a single positioned card that the user can
 * step through with Next or dismiss with Skip. Trigger from AppShell
 * after the first session:state-sync lands (or immediately on mount
 * for desktop, since the canvas is visible without a character link).
 */

const STORAGE_KEY = 'kbrt.tour.firstJoin.completed';

interface Step {
  title: string;
  body: string;
  emoji: string;
}

const STEPS: Step[] = [
  {
    emoji: '🗺️',
    title: 'Your battle map',
    body: 'Scroll to zoom. Drag to pan. The DM can swap maps mid-session — you\'ll see a smooth transition when they do.',
  },
  {
    emoji: '🧍',
    title: 'Your token',
    body: 'Click your token to open your character panel with HP, AC, spells, inventory, and combat actions.',
  },
  {
    emoji: '🎲',
    title: 'Rolling dice',
    body: 'Use the dice tray in the bottom right for quick rolls, or type `/r 1d20+5` in chat for formula rolls. Roll20-style commands like !damage, !cond, !aoe are in the chat too.',
  },
  {
    emoji: '⚔️',
    title: 'Quick actions',
    body: 'The Actions button at the bottom opens Dodge, Dash, Disengage, Hide, Help, and Ready. Use them on your turn during combat.',
  },
];

function isTourCompleted(): boolean {
  if (typeof window === 'undefined') return true;
  try { return window.localStorage.getItem(STORAGE_KEY) === '1'; }
  catch { return true; }
}

function markCompleted() {
  try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
}

export function FirstJoinTour() {
  const [shown, setShown] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (isTourCompleted()) return;
    // Delay one tick so the session shell has painted before the tour
    // pops in — avoids flashing over the initial blank canvas.
    const t = window.setTimeout(() => setShown(true), 600);
    return () => window.clearTimeout(t);
  }, []);

  if (!shown) return null;
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  const close = () => {
    markCompleted();
    setShown(false);
  };

  return (
    <div style={styles.backdrop}>
      <div style={styles.card} role="dialog" aria-label="First-join tour">
        <button
          onClick={close}
          style={styles.close}
          title="Dismiss tour"
          aria-label="Dismiss tour"
        >
          <X size={14} />
        </button>

        <div style={styles.stepProgress}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                ...styles.dot,
                background: i === stepIndex ? theme.gold.primary : theme.border.default,
              }}
            />
          ))}
        </div>

        <div style={styles.emoji}>{step.emoji}</div>
        <div style={styles.title}>{step.title}</div>
        <div style={styles.body}>{step.body}</div>

        <div style={styles.actions}>
          <button onClick={close} style={styles.skip}>Skip</button>
          {!isLast ? (
            <button
              onClick={() => setStepIndex((i) => i + 1)}
              style={styles.primary}
            >
              Next
            </button>
          ) : (
            <button onClick={close} style={styles.primary}>Let's play</button>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(10, 8, 6, 0.55)',
    zIndex: 200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'fadeIn 0.3s ease',
  },
  card: {
    position: 'relative',
    width: 420,
    maxWidth: 'calc(100vw - 32px)',
    padding: '28px 24px 20px',
    background: `linear-gradient(180deg, ${theme.bg.deepest} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.lg,
    boxShadow: '0 20px 60px rgba(0,0,0,0.55), 0 0 40px rgba(232, 196, 85, 0.12)',
    textAlign: 'center',
  },
  close: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: theme.text.muted,
    cursor: 'pointer',
    borderRadius: theme.radius.sm,
  },
  stepProgress: {
    display: 'flex',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 16,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    transition: `all ${theme.motion.normal}`,
  },
  emoji: {
    fontSize: 40,
    marginBottom: 8,
  },
  title: {
    fontFamily: theme.font.display,
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: theme.gold.primary,
    marginBottom: 8,
  },
  body: {
    fontSize: 13,
    lineHeight: 1.5,
    color: theme.text.secondary,
    marginBottom: 20,
  },
  actions: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  skip: {
    padding: '8px 14px',
    fontSize: 12,
    fontFamily: theme.font.body,
    background: 'transparent',
    border: 'none',
    color: theme.text.muted,
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
  },
  primary: {
    padding: '10px 20px',
    fontFamily: theme.font.display,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: theme.bg.base,
    background: theme.gold.primary,
    border: `1px solid ${theme.gold.primary}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
  },
};
