import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { theme } from '../../styles/theme';
import { FeedbackModal } from './FeedbackModal';

/**
 * Floating "Got feedback?" button — sticks bottom-right of the viewport
 * and opens the FeedbackModal. Mounted once in AppShell so it's reachable
 * from every screen (lobby, in-session, character sheet open, etc.).
 *
 * Visual: low-opacity gold pill until hover, then full opacity. Stays
 * out of the way during play but is always reachable for the rare
 * "I want to suggest something" impulse.
 */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Send feedback or suggest a feature"
        aria-label="Send feedback"
        style={{
          position: 'fixed',
          bottom: 76,            // sits above the BottomBar (64 px) + 12 px gap
          right: 16,
          zIndex: 80,            // below modals (100+) but above sidebars
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          background: hover
            ? `linear-gradient(135deg, ${theme.gold.dim}, ${theme.gold.primary})`
            : `linear-gradient(135deg, ${theme.bg.elevated}, ${theme.bg.deep})`,
          color: hover ? '#0a0a12' : theme.gold.primary,
          border: `1px solid ${theme.gold.border}`,
          borderRadius: 999,
          fontFamily: theme.font.body,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.4px',
          opacity: hover ? 1 : 0.55,
          cursor: 'pointer',
          boxShadow: hover ? theme.goldGlow.medium : '0 2px 6px rgba(0,0,0,0.5)',
          transition: `all ${theme.motion.fast}`,
        }}
      >
        <Lightbulb size={14} />
        <span>Feedback</span>
      </button>
      <FeedbackModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
