import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { getInviteInfo, joinSession } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { theme } from '../../styles/theme';

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'banned'; reason: string | null; bannedBy: string | null };

/**
 * Landing page for shareable invite links (`/join/:token`).
 *
 * Resolves the invite token via GET /api/sessions/invites/:token, then
 * issues the real POST /sessions/join with the token so the server
 * skips password validation. Routes the user to the session on success.
 *
 * Handles:
 *  - Not-logged-in: punt to login page with a ?next= back here
 *  - Invalid/expired token: error card with "back to lobby"
 *  - Banned: same banned card pattern as SessionLobby
 *  - Success: navigate to /session/:roomCode
 */
export function InviteLanding() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const authUser = useAuthStore((s) => s.user);
  const setDisplayName = useSessionStore((s) => s.setDisplayName);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    if (!token) { setStatus({ kind: 'error', message: 'Missing invite token.' }); return; }
    if (!authUser) {
      // Bounce to login with a next= so we come back here post-auth.
      const next = `/join/${encodeURIComponent(token)}`;
      navigate(`/?next=${encodeURIComponent(next)}`, { replace: true });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const info = await getInviteInfo(token);
        if (cancelled) return;
        const result = await joinSession({
          roomCode: info.roomCode,
          displayName: authUser.displayName,
          inviteToken: token,
        });
        if (cancelled) return;
        if (result.ok) {
          setDisplayName(authUser.displayName);
          navigate(`/session/${result.roomCode}`, { replace: true });
          return;
        }
        if (result.kind === 'banned') {
          setStatus({ kind: 'banned', reason: result.reason, bannedBy: result.bannedBy });
        } else if (result.kind === 'requires-password') {
          // Invite wasn't accepted \u2014 fall back to the lobby with the
          // code filled so the user can try the password path.
          navigate(`/?roomCode=${encodeURIComponent(info.roomCode)}`, { replace: true });
        } else if (result.kind === 'not-found') {
          setStatus({ kind: 'error', message: 'This session no longer exists.' });
        } else {
          setStatus({ kind: 'error', message: result.message });
        }
      } catch (err) {
        if (cancelled) return;
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Invite invalid or expired.',
        });
      }
    })();

    return () => { cancelled = true; };
  }, [token, authUser, navigate, setDisplayName]);

  if (status.kind === 'loading') {
    return (
      <div style={styles.overlay}>
        <div style={styles.card}>
          <p style={{ ...theme.type.h2, color: theme.gold.primary, margin: 0 }}>
            Joining session\u2026
          </p>
        </div>
      </div>
    );
  }

  if (status.kind === 'banned') {
    return (
      <div style={styles.overlay}>
        <div style={{ ...styles.card, borderColor: theme.state.danger }}>
          <AlertTriangle size={32} color={theme.state.danger} />
          <h2 style={{ ...theme.type.h2, color: theme.state.danger, margin: 0 }}>
            You were banned from this session
          </h2>
          {status.bannedBy && <p style={styles.meta}>Banned by {status.bannedBy}</p>}
          {status.reason && <p style={styles.reason}>&ldquo;{status.reason}&rdquo;</p>}
          <button className="btn-primary" onClick={() => navigate('/')} style={{ marginTop: 16 }}>
            Back to lobby
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.overlay}>
      <div style={{ ...styles.card, borderColor: theme.state.danger }}>
        <AlertTriangle size={32} color={theme.state.danger} />
        <h2 style={{ ...theme.type.h2, color: theme.text.primary, margin: 0 }}>
          Invite unavailable
        </h2>
        <p style={styles.reason}>{status.message}</p>
        <button className="btn-primary" onClick={() => navigate('/')} style={{ marginTop: 16 }}>
          Back to lobby
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.deepest,
  },
  card: {
    maxWidth: 480,
    padding: '32px 28px',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.lg,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    textAlign: 'center' as const,
    gap: 8,
  },
  meta: {
    fontSize: 13,
    color: theme.text.muted,
    margin: 0,
  },
  reason: {
    fontSize: 14,
    color: theme.text.primary,
    fontStyle: 'italic' as const,
    margin: '8px 0 0',
  },
};
