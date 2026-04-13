import { useState, useEffect, useCallback } from 'react';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitReadyResponse } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

/**
 * Ready Check modal.
 *
 * Shown to players (not the DM) when the DM initiates a ready check
 * before combat. Displays a countdown timer and a big "Ready!" button.
 * Auto-dismisses when combat starts or the ready check clears.
 */
export function ReadyCheckModal() {
  const readyCheck = useCombatStore((s) => s.readyCheck);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const [secondsLeft, setSecondsLeft] = useState(15);
  const [responded, setResponded] = useState(false);

  // Reset responded state when a new ready check starts
  useEffect(() => {
    if (readyCheck?.active) {
      setResponded(false);
    }
  }, [readyCheck?.active, readyCheck?.deadline]);

  // Countdown timer
  useEffect(() => {
    if (!readyCheck?.active) return;

    const tick = () => {
      const remaining = Math.max(0, Math.ceil((readyCheck.deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [readyCheck?.active, readyCheck?.deadline]);

  const handleReady = useCallback(() => {
    emitReadyResponse(true);
    setResponded(true);
  }, []);

  // Don't show for DM or when no ready check is active
  console.log('[READY CHECK MODAL] render check', {
    active: readyCheck?.active,
    isDM,
    userId,
    willRender: !!readyCheck?.active && !isDM,
  });
  if (!readyCheck?.active || isDM) return null;

  const alreadyReady = responded || (userId ? readyCheck.responses[userId] === true : false);

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <span style={{ fontSize: 28 }}>&#9876;</span>
          <div>
            <div style={styles.title}>DM is starting combat!</div>
            <div style={styles.subtitle}>
              Get ready for initiative
            </div>
          </div>
        </div>

        {/* Countdown */}
        <div style={styles.countdownSection}>
          <div style={styles.countdownRing}>
            <svg width={72} height={72} viewBox="0 0 72 72">
              <circle
                cx={36} cy={36} r={30}
                fill="none"
                stroke={theme.border.default}
                strokeWidth={4}
              />
              <circle
                cx={36} cy={36} r={30}
                fill="none"
                stroke={secondsLeft <= 5 ? theme.danger : theme.gold.primary}
                strokeWidth={4}
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 30}
                strokeDashoffset={2 * Math.PI * 30 * (1 - secondsLeft / 15)}
                transform="rotate(-90 36 36)"
                style={{ transition: 'stroke-dashoffset 0.25s linear, stroke 0.3s ease' }}
              />
            </svg>
            <span style={{
              ...styles.countdownText,
              color: secondsLeft <= 5 ? theme.danger : theme.text.primary,
            }}>
              {secondsLeft}
            </span>
          </div>
          <div style={styles.countdownLabel}>
            {secondsLeft === 0 ? 'Starting...' : `${secondsLeft}s remaining`}
          </div>
        </div>

        {/* Action */}
        <div style={styles.actionSection}>
          {alreadyReady ? (
            <div style={styles.readyConfirm}>
              <span style={{ fontSize: 20, color: theme.state.success }}>&#10003;</span>
              <span style={{ color: theme.state.success, fontWeight: 700, fontSize: 14 }}>
                You are ready!
              </span>
            </div>
          ) : (
            <Button
              variant="danger"
              size="lg"
              fullWidth
              onClick={handleReady}
            >
              Ready!
            </Button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes rc-slide {
          from { transform: translateY(-16px) scale(0.96); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9997,
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '12vh',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  modal: {
    pointerEvents: 'auto',
    background: theme.bg.deep,
    border: `2px solid ${theme.danger}`,
    borderRadius: 12,
    padding: '22px 26px',
    minWidth: 340,
    maxWidth: 400,
    boxShadow: `0 0 50px rgba(192, 57, 43, 0.4), 0 12px 40px rgba(0,0,0,0.6)`,
    animation: 'rc-slide 0.25s ease-out',
    textAlign: 'center' as const,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    textAlign: 'left' as const,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: theme.text.primary,
    fontFamily: theme.font.display,
  },
  subtitle: {
    fontSize: 12,
    color: theme.text.secondary,
    marginTop: 2,
  },
  countdownSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    padding: '12px 0 16px',
    borderTop: `1px solid ${theme.border.default}`,
    borderBottom: `1px solid ${theme.border.default}`,
    marginBottom: 16,
  },
  countdownRing: {
    position: 'relative' as const,
    width: 72,
    height: 72,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownText: {
    position: 'absolute' as const,
    fontSize: 24,
    fontWeight: 700,
    fontFamily: 'monospace',
  },
  countdownLabel: {
    fontSize: 12,
    color: theme.text.muted,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  actionSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  readyConfirm: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px 0',
  },
};
