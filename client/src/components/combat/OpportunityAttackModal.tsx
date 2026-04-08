import { useEffect, useState, useCallback } from 'react';
import { emitOAExecute, emitOADecline } from '../../socket/emitters';
import { theme } from '../../styles/theme';

/**
 * Opportunity Attack prompt.
 *
 * Subscribes to `combat:oa-opportunity` socket events (wired in
 * socket/listeners.ts). When an event arrives we queue it and show
 * a red-bordered modal with "Attack" / "Let them go" buttons and a
 * 12-second auto-dismiss countdown.
 *
 * Multiple opportunities can queue up (e.g. a player running through
 * a line of three enemies) — we show them one at a time, in arrival
 * order. Clicking Attack or Let them go advances to the next entry.
 */
interface OAPromptData {
  attackerTokenId: string;
  attackerName: string;
  attackerOwnerUserId: string | null;
  moverTokenId: string;
  moverName: string;
}

const DISMISS_MS = 12_000;

// Simple module-level queue — the modal subscribes and renders it.
const oaQueue: OAPromptData[] = [];
const listeners = new Set<() => void>();
function notifyListeners() {
  for (const l of listeners) l();
}

/**
 * Called by the socket listener. Pushes a new prompt onto the queue
 * and triggers a re-render of any mounted modal.
 */
export function pushOpportunityAttack(data: OAPromptData) {
  // De-dupe: don't queue the same attacker/mover pair twice.
  if (oaQueue.some((q) => q.attackerTokenId === data.attackerTokenId && q.moverTokenId === data.moverTokenId)) {
    return;
  }
  oaQueue.push(data);
  notifyListeners();
}

export function OpportunityAttackModal() {
  const [, force] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(DISMISS_MS / 1000);

  // Subscribe to the queue changes.
  useEffect(() => {
    const handler = () => force((n) => n + 1);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  const head = oaQueue[0];

  // Auto-dismiss countdown — resets whenever the head changes.
  useEffect(() => {
    if (!head) return;
    setSecondsLeft(Math.ceil(DISMISS_MS / 1000));
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, DISMISS_MS - elapsed);
      setSecondsLeft(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        clearInterval(tick);
        // auto-decline
        emitOADecline(head.attackerTokenId, head.moverTokenId);
        oaQueue.shift();
        notifyListeners();
      }
    }, 200);
    return () => clearInterval(tick);
  }, [head?.attackerTokenId, head?.moverTokenId]);

  const handleAttack = useCallback(() => {
    if (!head) return;
    emitOAExecute(head.attackerTokenId, head.moverTokenId);
    oaQueue.shift();
    notifyListeners();
  }, [head]);

  const handleDecline = useCallback(() => {
    if (!head) return;
    emitOADecline(head.attackerTokenId, head.moverTokenId);
    oaQueue.shift();
    notifyListeners();
  }, [head]);

  if (!head) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '8vh',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          background: theme.bg.deep,
          border: `2px solid ${theme.state.danger}`,
          borderRadius: theme.radius.lg,
          padding: '18px 22px',
          minWidth: 360,
          maxWidth: 440,
          boxShadow: `0 0 40px rgba(192,57,43,0.5), ${theme.shadow.lg}`,
          animation: 'oa-slide 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: theme.state.danger,
              textTransform: 'uppercase', letterSpacing: '1px',
            }}>
              Opportunity Attack
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text.primary, marginTop: 2 }}>
              {head.moverName} is leaving {head.attackerName}'s reach!
            </div>
          </div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: theme.text.muted,
            padding: '2px 8px', background: theme.bg.elevated,
            borderRadius: 10,
          }}>
            {secondsLeft}s
          </div>
        </div>

        {/* Body */}
        <div style={{
          fontSize: 12, color: theme.text.secondary, lineHeight: 1.5,
          padding: '8px 0',
          borderTop: `1px solid ${theme.border.default}`,
          borderBottom: `1px solid ${theme.border.default}`,
          marginBottom: 12,
        }}>
          <strong style={{ color: theme.gold.primary }}>{head.attackerName}</strong> may spend their{' '}
          <strong style={{ color: theme.purple }}>Reaction</strong> to make one melee weapon attack
          against <strong style={{ color: theme.text.primary }}>{head.moverName}</strong> before they move out
          of reach.
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleAttack}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: `linear-gradient(135deg, ${theme.dangerDim}, ${theme.state.danger})`,
              border: `1px solid ${theme.state.danger}`,
              borderRadius: theme.radius.sm,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontFamily: theme.font.body,
              boxShadow: theme.dangerGlow,
              transition: `all ${theme.motion.fast}`,
            }}
          >
            ⚔ Attack
          </button>
          <button
            onClick={handleDecline}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: 'transparent',
              border: `1px solid ${theme.border.default}`,
              borderRadius: theme.radius.sm,
              color: theme.text.secondary,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontFamily: theme.font.body,
              transition: `all ${theme.motion.fast}`,
            }}
          >
            Let them go
          </button>
        </div>

        {/* Queue indicator */}
        {oaQueue.length > 1 && (
          <div style={{
            marginTop: 10, textAlign: 'center',
            fontSize: 10, color: theme.text.muted,
          }}>
            +{oaQueue.length - 1} more opportunity attack{oaQueue.length - 1 > 1 ? 's' : ''} waiting
          </div>
        )}
      </div>

      {/* Keyframe animation */}
      <style>{`
        @keyframes oa-slide {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
