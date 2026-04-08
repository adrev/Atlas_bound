import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Swords, Users, History, Trash2 } from 'lucide-react';
import { createSession, joinSession } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { theme } from '../../styles/theme';

interface SavedSession {
  roomCode: string;
  name: string;
  displayName: string;
  role: 'dm' | 'player';
  joinedAt: string;
}

function getSavedSessions(): SavedSession[] {
  try {
    return JSON.parse(localStorage.getItem('dnd-vtt-sessions') || '[]');
  } catch { return []; }
}

function saveSession(session: SavedSession) {
  const sessions = getSavedSessions().filter(s => s.roomCode !== session.roomCode);
  sessions.unshift(session); // most recent first
  localStorage.setItem('dnd-vtt-sessions', JSON.stringify(sessions.slice(0, 20))); // keep last 20
}

function removeSavedSession(roomCode: string) {
  const sessions = getSavedSessions().filter(s => s.roomCode !== roomCode);
  localStorage.setItem('dnd-vtt-sessions', JSON.stringify(sessions));
}

export function SessionLobby() {
  const navigate = useNavigate();
  const setDisplayName = useSessionStore((s) => s.setDisplayName);

  const [createName, setCreateName] = useState('');
  const [createDisplayName, setCreateDisplayName] = useState(() =>
    localStorage.getItem('dnd-vtt-displayName') || ''
  );
  const [joinCode, setJoinCode] = useState('');
  const [joinDisplayName, setJoinDisplayName] = useState(() =>
    localStorage.getItem('dnd-vtt-displayName') || ''
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);

  useEffect(() => {
    setSavedSessions(getSavedSessions());
  }, []);

  const handleCreate = async () => {
    if (!createName.trim() || !createDisplayName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await createSession(createName.trim(), createDisplayName.trim());
      setDisplayName(createDisplayName.trim());
      localStorage.setItem('dnd-vtt-displayName', createDisplayName.trim());
      saveSession({
        roomCode: result.roomCode,
        name: createName.trim(),
        displayName: createDisplayName.trim(),
        role: 'dm',
        joinedAt: new Date().toISOString(),
      });
      navigate(`/session/${result.roomCode}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim() || !joinDisplayName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await joinSession(joinCode.trim().toUpperCase(), joinDisplayName.trim());
      setDisplayName(joinDisplayName.trim());
      localStorage.setItem('dnd-vtt-displayName', joinDisplayName.trim());
      saveSession({
        roomCode: joinCode.trim().toUpperCase(),
        name: (result as any).sessionName || joinCode.trim().toUpperCase(),
        displayName: joinDisplayName.trim(),
        role: 'player',
        joinedAt: new Date().toISOString(),
      });
      navigate(`/session/${joinCode.trim().toUpperCase()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join session');
    } finally {
      setLoading(false);
    }
  };

  const handleRejoin = (session: SavedSession) => {
    setDisplayName(session.displayName);
    localStorage.setItem('dnd-vtt-displayName', session.displayName);
    navigate(`/session/${session.roomCode}`);
  };

  const handleRemoveSaved = (roomCode: string) => {
    removeSavedSession(roomCode);
    setSavedSessions(getSavedSessions());
  };

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        {/* Header */}
        <div style={styles.header}>
          <img src="/atlas-bound-logo.png" alt="Atlas Bound" style={{ width: 120, height: 120, borderRadius: '50%', marginBottom: 12 }} />
          <h1 style={styles.title}>ATLAS BOUND</h1>
          <p style={styles.subtitle}>Online D&D Platform</p>
          <div style={styles.divider} />
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {/* Cards */}
        <div style={styles.cards}>
          {/* Create Game Card */}
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <Swords size={24} color={theme.gold.primary} />
              <h2 style={styles.cardTitle}>Create Game</h2>
            </div>
            <p style={styles.cardDesc}>
              Start a new campaign and invite your party.
            </p>
            <div style={styles.form}>
              <input
                style={undefined}
                placeholder="Campaign Name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <input
                placeholder="Your Display Name"
                value={createDisplayName}
                onChange={(e) => setCreateDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={loading || !createName.trim() || !createDisplayName.trim()}
                style={{ width: '100%' }}
              >
                <Swords size={16} />
                Create Game
              </button>
            </div>
          </div>

          {/* Join Game Card */}
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <Users size={24} color={theme.gold.primary} />
              <h2 style={styles.cardTitle}>Join Game</h2>
            </div>
            <p style={styles.cardDesc}>
              Enter a room code to join an existing session.
            </p>
            <div style={styles.form}>
              <input
                placeholder="Room Code (e.g., ABC123)"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                maxLength={8}
                style={{ textTransform: 'uppercase', letterSpacing: '2px' }}
              />
              <input
                placeholder="Your Display Name"
                value={joinDisplayName}
                onChange={(e) => setJoinDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              />
              <button
                className="btn-primary"
                onClick={handleJoin}
                disabled={loading || !joinCode.trim() || !joinDisplayName.trim()}
                style={{ width: '100%' }}
              >
                <Users size={16} />
                Join Game
              </button>
            </div>
          </div>
        </div>

        {/* Previous Games */}
        {savedSessions.length > 0 && (
          <div style={styles.savedSection}>
            <div style={styles.savedHeader}>
              <History size={18} color={theme.gold.primary} />
              <h3 style={styles.savedTitle}>Your Games</h3>
            </div>
            <div style={styles.savedList}>
              {savedSessions.map((s) => (
                <div key={s.roomCode} style={styles.savedItem}>
                  <div style={styles.savedInfo}>
                    <div style={styles.savedName}>{s.name}</div>
                    <div style={styles.savedMeta}>
                      <span style={{
                        padding: '1px 6px', fontSize: 9, fontWeight: 700,
                        borderRadius: 3, textTransform: 'uppercase',
                        background: s.role === 'dm' ? 'rgba(212,168,67,0.2)' : 'rgba(52,152,219,0.2)',
                        color: s.role === 'dm' ? theme.gold.primary : theme.blue,
                        border: `1px solid ${s.role === 'dm' ? theme.gold.border : 'rgba(52,152,219,0.3)'}`,
                      }}>{s.role}</span>
                      <span style={{ color: theme.text.muted, fontSize: 11 }}>{s.roomCode}</span>
                      <span style={{ color: theme.text.muted, fontSize: 10 }}>
                        {new Date(s.joinedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      style={styles.rejoinBtn}
                      onClick={() => handleRejoin(s)}
                    >
                      Rejoin
                    </button>
                    <button
                      style={styles.removeBtn}
                      onClick={() => handleRemoveSaved(s.roomCode)}
                      title="Remove from list"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <p style={styles.footer}>
          Atlas Bound — Your adventure awaits.
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    // The global `#root { overflow: hidden }` rule in globals.css
    // prevents normal page scrolling, so we own our own scroll
    // context by fixing the container to the viewport and applying
    // `overflowY: auto` here. Without this the "Your Games" list
    // below the fold is unreachable because it gets clipped by #root.
    // We use `position: fixed` (not absolute) so the scroll context
    // doesn't depend on the parent's position rules — fixed is
    // always relative to the viewport.
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflowY: 'auto',
    overflowX: 'hidden',
    background: `radial-gradient(ellipse at center, ${theme.bg.base} 0%, ${theme.bg.deepest} 70%)`,
    padding: '40px 24px',
  },
  content: {
    maxWidth: 800,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 32,
    margin: 'auto 0', // vertically center when there's room, allow scroll when there isn't
    animation: 'fadeIn 0.5s ease',
  },
  header: {
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontFamily: theme.font.display,
    fontSize: 48,
    fontWeight: 700,
    color: theme.gold.primary,
    letterSpacing: '6px',
    textShadow: `0 0 30px rgba(212, 168, 67, 0.4)`,
    margin: 0,
  },
  subtitle: {
    fontSize: 16,
    color: theme.text.secondary,
    letterSpacing: '3px',
    textTransform: 'uppercase' as const,
    margin: 0,
  },
  divider: {
    width: 120,
    height: 2,
    background: `linear-gradient(90deg, transparent, ${theme.gold.primary}, transparent)`,
    marginTop: 8,
  },
  error: {
    padding: '12px 20px',
    background: 'rgba(192, 57, 43, 0.15)',
    border: `1px solid rgba(192, 57, 43, 0.3)`,
    borderRadius: theme.radius.md,
    color: theme.danger,
    fontSize: 14,
    width: '100%',
    maxWidth: 600,
    textAlign: 'center' as const,
  },
  cards: {
    display: 'flex',
    gap: 24,
    width: '100%',
    flexWrap: 'wrap' as const,
    justifyContent: 'center',
  },
  card: {
    flex: '1 1 340px',
    maxWidth: 380,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.lg,
    padding: 28,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
    transition: 'border-color 0.2s ease',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  cardTitle: {
    fontFamily: theme.font.display,
    fontSize: 22,
    fontWeight: 600,
    color: theme.text.primary,
    margin: 0,
  },
  cardDesc: {
    fontSize: 14,
    color: theme.text.secondary,
    margin: 0,
    lineHeight: 1.5,
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  footer: {
    fontSize: 13,
    color: theme.text.muted,
    fontStyle: 'italic',
    margin: 0,
  },
  savedSection: {
    width: '100%',
    maxWidth: 700,
    margin: '0 auto',
  },
  savedHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  savedTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: theme.gold.primary,
    fontFamily: theme.font.display,
    margin: 0,
  },
  savedList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  savedItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    background: theme.bg.card,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
  },
  savedInfo: {
    flex: 1,
    minWidth: 0,
  },
  savedName: {
    fontSize: 14,
    fontWeight: 600,
    color: theme.text.primary,
    marginBottom: 4,
  },
  savedMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
  },
  rejoinBtn: {
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: 600,
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.gold.primary,
    cursor: 'pointer',
  },
  removeBtn: {
    padding: '6px 8px',
    background: 'transparent',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.muted,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
};
