import { useEffect, useState, useCallback } from 'react';
import { emitOAExecute, emitOADecline } from '../../socket/emitters';

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
          background: '#1a1a1a',
          border: '2px solid #c53131',
          borderRadius: 12,
          padding: '18px 22px',
          minWidth: 360,
          maxWidth: 440,
          boxShadow: '0 0 40px rgba(197,49,49,0.5), 0 16px 48px rgba(0,0,0,0.7)',
          animation: 'oa-slide 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#c53131',
              textTransform: 'uppercase', letterSpacing: '1px',
            }}>
              Opportunity Attack
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#eee', marginTop: 2 }}>
              {head.moverName} is leaving {head.attackerName}'s reach!
            </div>
          </div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#888',
            padding: '2px 8px', background: 'rgba(255,255,255,0.05)',
            borderRadius: 10,
          }}>
            {secondsLeft}s
          </div>
        </div>

        {/* Body */}
        <div style={{
          fontSize: 12, color: '#bbb', lineHeight: 1.5,
          padding: '8px 0', borderTop: '1px solid #333',
          borderBottom: '1px solid #333', marginBottom: 12,
        }}>
          <strong style={{ color: '#d4a843' }}>{head.attackerName}</strong> may spend their{' '}
          <strong style={{ color: '#9b59b6' }}>Reaction</strong> to make one melee weapon attack
          against <strong style={{ color: '#eee' }}>{head.moverName}</strong> before they move out
          of reach.
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleAttack}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: '#c53131',
              border: 'none',
              borderRadius: 6,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontFamily: 'inherit',
              boxShadow: '0 0 12px rgba(197,49,49,0.4)',
              transition: 'all 0.15s',
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
              border: '1px solid #444',
              borderRadius: 6,
              color: '#aaa',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            Let them go
          </button>
        </div>

        {/* Queue indicator */}
        {oaQueue.length > 1 && (
          <div style={{
            marginTop: 10, textAlign: 'center',
            fontSize: 10, color: '#666',
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
