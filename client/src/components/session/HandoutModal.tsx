import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { theme } from '../../styles/theme';

export interface HandoutPayload {
  title: string;
  content: string;
  imageUrl?: string;
  fromDM: boolean;
}

/** Global handout queue — pushed to by the socket listener, read by the modal. */
let _handoutQueue: HandoutPayload[] = [];
let _notifyModal: (() => void) | null = null;

/** Called from the socket listener to push a new handout. */
export function pushHandout(payload: HandoutPayload) {
  _handoutQueue = [..._handoutQueue, payload];
  _notifyModal?.();
}

/**
 * Dramatic full-screen handout modal. Renders the top handout in the
 * queue; dismissing it reveals the next one (if any arrived while the
 * first was showing).
 */
export function HandoutModal() {
  const [, forceRender] = useState(0);

  // Subscribe so pushHandout triggers a re-render
  _notifyModal = useCallback(() => {
    forceRender((n) => n + 1);
  }, []);

  if (_handoutQueue.length === 0) return null;

  const handout = _handoutQueue[0];

  const dismiss = () => {
    _handoutQueue = _handoutQueue.slice(1);
    forceRender((n) => n + 1);
  };

  return (
    <div style={styles.overlay} onClick={dismiss}>
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <button style={styles.closeBtn} onClick={dismiss}>
          <X size={16} />
        </button>

        <h2 style={styles.title}>{handout.title}</h2>

        {handout.imageUrl && (
          <img
            src={handout.imageUrl}
            alt={handout.title}
            style={styles.image}
          />
        )}

        {handout.content && (
          <div style={styles.content}>{handout.content}</div>
        )}

        <button style={styles.dismissBtn} onClick={dismiss}>
          Close
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.88)',
    zIndex: 300,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'fadeIn 0.3s ease',
  },
  card: {
    position: 'relative',
    maxWidth: 560,
    width: '90%',
    maxHeight: '85vh',
    overflowY: 'auto',
    background: `linear-gradient(180deg, ${theme.bg.card} 0%, ${theme.bg.deep} 100%)`,
    border: `2px solid ${theme.gold.primary}`,
    borderRadius: theme.radius.lg,
    padding: '32px 28px 24px',
    boxShadow: `${theme.goldGlow.strong}, ${theme.shadow.lg}`,
    textAlign: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    color: theme.text.muted,
    cursor: 'pointer',
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    fontFamily: "Georgia, 'Times New Roman', serif",
    color: theme.gold.bright,
    margin: '0 0 16px',
    textShadow: '0 0 12px rgba(232, 196, 85, 0.4)',
  },
  image: {
    maxWidth: '100%',
    maxHeight: 340,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.gold.border}`,
    marginBottom: 16,
    objectFit: 'contain' as const,
  },
  content: {
    fontSize: 14,
    lineHeight: 1.7,
    color: theme.text.secondary,
    whiteSpace: 'pre-wrap',
    textAlign: 'left',
    marginBottom: 20,
  },
  dismissBtn: {
    padding: '8px 28px',
    fontSize: 13,
    fontWeight: 700,
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    color: theme.gold.primary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
};
