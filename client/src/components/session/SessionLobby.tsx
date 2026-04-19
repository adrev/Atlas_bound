import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Swords, Users, History, Trash2, LogOut, Shield, User, AlertTriangle } from 'lucide-react';
import { createSession, joinSession } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

interface SavedSession {
  roomCode: string;
  name: string;
  displayName: string;
  role: 'dm' | 'player';
  joinedAt: string;
}

interface ServerGame {
  id: string;
  roomCode: string;
  name: string;
  role: 'dm' | 'player';
  playerCount: number;
}

interface MyCharacter {
  id: string;
  name: string;
  class?: string;
  level?: number;
  portraitUrl?: string;
  dndbeyondId?: string;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const setDisplayName = useSessionStore((s) => s.setDisplayName);
  const authUser = useAuthStore((s) => s.user);
  const authLogout = useAuthStore((s) => s.logout);

  const [createName, setCreateName] = useState('');
  const [createVisibility, setCreateVisibility] = useState<'public' | 'private'>('public');
  const [createPassword, setCreatePassword] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinRequiresPassword, setJoinRequiresPassword] = useState(false);
  const [banModal, setBanModal] = useState<{ reason: string | null; bannedBy: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);

  // Server-backed data
  const [myGames, setMyGames] = useState<ServerGame[]>([]);
  const [myGamesLoading, setMyGamesLoading] = useState(false);
  const [myCharacters, setMyCharacters] = useState<MyCharacter[]>([]);
  const [myCharsLoading, setMyCharsLoading] = useState(false);

  useEffect(() => {
    setSavedSessions(getSavedSessions());
  }, []);

  // Fetch server-backed games
  const fetchMyGames = async () => {
    setMyGamesLoading(true);
    try {
      const res = await fetch('/api/sessions/mine', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMyGames(Array.isArray(data) ? data : data.sessions || []);
      }
    } catch {
      // silently fail — the section just stays empty
    } finally {
      setMyGamesLoading(false);
    }
  };

  // Fetch server-backed characters
  const fetchMyCharacters = async () => {
    setMyCharsLoading(true);
    try {
      const res = await fetch('/api/characters', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMyCharacters(Array.isArray(data) ? data : data.characters || []);
      }
    } catch {
      // silently fail
    } finally {
      setMyCharsLoading(false);
    }
  };

  useEffect(() => {
    if (authUser) {
      fetchMyGames();
      fetchMyCharacters();
    }
  }, [authUser]);

  // Resume an invite-link bounce after login: InviteLanding routes
  // unauthenticated users here with `?next=/join/<token>`. Once we
  // have an auth user we redirect back.
  useEffect(() => {
    const next = searchParams.get('next');
    if (authUser && next && next.startsWith('/')) {
      // Clear the param so refreshes don't re-trigger, then go.
      searchParams.delete('next');
      setSearchParams(searchParams, { replace: true });
      navigate(next, { replace: true });
    }
  }, [authUser, searchParams, setSearchParams, navigate]);

  // Pre-fill the Join form from `?roomCode=`. InviteLanding bounces
  // here when an invite token was rotated so the user still has a
  // one-click path to the password prompt.
  useEffect(() => {
    const code = searchParams.get('roomCode');
    if (code) {
      setJoinCode(code.toUpperCase());
      searchParams.delete('roomCode');
      setSearchParams(searchParams, { replace: true });
    }
    // Intentionally run once on mount \u2014 further edits come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLeaveGame = async (gameId: string) => {
    try {
      await fetch(`/api/sessions/${gameId}/leave`, {
        method: 'DELETE',
        credentials: 'include',
      });
      fetchMyGames();
    } catch {
      setError('Failed to leave game');
    }
  };

  const handleDeleteCharacter = async (charId: string) => {
    try {
      await fetch(`/api/characters/${charId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      fetchMyCharacters();
    } catch {
      setError('Failed to delete character');
    }
  };

  // Find duplicate dndbeyondIds
  const dndbeyondIdCounts: Record<string, number> = {};
  myCharacters.forEach((c) => {
    if (c.dndbeyondId) {
      dndbeyondIdCounts[c.dndbeyondId] = (dndbeyondIdCounts[c.dndbeyondId] || 0) + 1;
    }
  });

  const handleCreate = async () => {
    if (!createName.trim() || !authUser) return;
    if (createVisibility === 'private' && createPassword && createPassword.length < 4) {
      setError('Password must be at least 4 characters');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await createSession({
        name: createName.trim(),
        displayName: authUser.displayName,
        visibility: createVisibility,
        password: createVisibility === 'private' && createPassword ? createPassword : undefined,
      });
      setDisplayName(authUser.displayName);
      saveSession({
        roomCode: result.roomCode,
        name: createName.trim(),
        displayName: authUser.displayName,
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
    if (!joinCode.trim() || !authUser) return;
    setLoading(true);
    setError(null);
    const code = joinCode.trim().toUpperCase();
    try {
      const result = await joinSession({
        roomCode: code,
        displayName: authUser.displayName,
        password: joinRequiresPassword ? joinPassword : undefined,
      });
      if (result.ok) {
        setDisplayName(authUser.displayName);
        saveSession({
          roomCode: code,
          name: result.sessionName || code,
          displayName: authUser.displayName,
          role: 'player',
          joinedAt: new Date().toISOString(),
        });
        // Reset privacy prompts for next time.
        setJoinRequiresPassword(false);
        setJoinPassword('');
        navigate(`/session/${code}`);
        return;
      }
      // Structured failures \u2014 pick the right UX without parsing strings.
      if (result.kind === 'requires-password') {
        setJoinRequiresPassword(true);
        setError(joinRequiresPassword ? 'Wrong password \u2014 try again.' : null);
      } else if (result.kind === 'banned') {
        setBanModal({ reason: result.reason, bannedBy: result.bannedBy });
      } else if (result.kind === 'not-found') {
        setError('No session with that room code.');
      } else {
        setError(result.message);
      }
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
          <img src="/kbrt-logo.svg" alt="KBRT.AI" style={{ width: 160, height: 160, marginBottom: 8 }} />
          <div style={styles.divider} />
        </div>

        {/* User Info Bar */}
        {authUser && (
          <div style={styles.userBar}>
            {authUser.avatarUrl ? (
              <img
                src={authUser.avatarUrl}
                alt={authUser.displayName}
                style={styles.avatar}
              />
            ) : (
              <div style={styles.avatarPlaceholder}>
                {authUser.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <span style={styles.userName}>{authUser.displayName}</span>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<LogOut size={14} />}
              onClick={authLogout}
            >
              Log out
            </Button>
          </div>
        )}

        {error && <div style={styles.error}>{error}</div>}

        {/* My Games Section */}
        {authUser && (
          <div style={styles.sectionContainer}>
            <div style={styles.sectionHeader}>
              <Swords size={18} color={theme.gold.primary} />
              <h3 style={styles.sectionTitle}>My Games</h3>
            </div>
            {myGamesLoading ? (
              <p style={styles.emptyState}>Loading games...</p>
            ) : myGames.length === 0 ? (
              <p style={styles.emptyState}>No games yet. Create or join one below.</p>
            ) : (
              <div style={styles.gamesList}>
                {myGames.map((game) => (
                  <div key={game.id} style={styles.gameCard}>
                    <div style={styles.gameInfo}>
                      <div style={styles.gameName}>{game.name}</div>
                      <div style={styles.gameMeta}>
                        <span style={{
                          ...styles.roleBadge,
                          background: game.role === 'dm' ? 'rgba(212,168,67,0.2)' : 'rgba(52,152,219,0.2)',
                          color: game.role === 'dm' ? theme.gold.primary : theme.blue,
                          border: `1px solid ${game.role === 'dm' ? theme.gold.border : 'rgba(52,152,219,0.3)'}`,
                        }}>
                          {game.role === 'dm' ? (
                            <><Shield size={9} /> DM</>
                          ) : (
                            <><User size={9} /> Player</>
                          )}
                        </span>
                        <span style={{ color: theme.text.muted, fontSize: 11 }}>
                          <Users size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                          {game.playerCount}
                        </span>
                        <span style={{
                          fontFamily: 'monospace', fontSize: 11, letterSpacing: '1px',
                          color: theme.text.secondary,
                        }}>
                          {game.roomCode}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/session/${game.roomCode}`)}
                      >
                        Enter
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleLeaveGame(game.id)}
                        style={{ color: theme.danger }}
                      >
                        Leave
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* My Characters Section */}
        {authUser && (
          <div style={styles.sectionContainer}>
            <div style={styles.sectionHeader}>
              <User size={18} color={theme.gold.primary} />
              <h3 style={styles.sectionTitle}>My Characters</h3>
            </div>
            {myCharsLoading ? (
              <p style={styles.emptyState}>Loading characters...</p>
            ) : myCharacters.length === 0 ? (
              <p style={styles.emptyState}>No characters imported yet.</p>
            ) : (
              <div style={styles.charsList}>
                {myCharacters.map((char) => {
                  const isDuplicate = char.dndbeyondId && dndbeyondIdCounts[char.dndbeyondId] > 1;
                  return (
                    <div key={char.id} style={styles.charCard}>
                      {char.portraitUrl ? (
                        <img src={char.portraitUrl} alt={char.name} style={styles.charPortrait} />
                      ) : (
                        <div style={styles.charPortraitPlaceholder}>
                          {char.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div style={styles.charInfo}>
                        <div style={styles.charNameRow}>
                          <span style={styles.charName}>{char.name}</span>
                          {isDuplicate && (
                            <span style={styles.duplicateBadge}>
                              <AlertTriangle size={10} /> Duplicate
                            </span>
                          )}
                        </div>
                        <div style={styles.charMeta}>
                          {char.class && <span>{char.class}</span>}
                          {char.level != null && <span>Lv {char.level}</span>}
                        </div>
                      </div>
                      {isDuplicate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteCharacter(char.id)}
                          style={{ color: theme.danger }}
                        >
                          <Trash2 size={12} /> Delete
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

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
              {/* Public / private toggle */}
              <div style={styles.visibilityToggle} role="radiogroup" aria-label="Session visibility">
                {(['public', 'private'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={createVisibility === v}
                    onClick={() => setCreateVisibility(v)}
                    style={{
                      ...styles.visibilityButton,
                      ...(createVisibility === v ? styles.visibilityButtonActive : {}),
                    }}
                  >
                    {v === 'public' ? '\uD83C\uDF10 Public' : '\uD83D\uDD12 Private'}
                  </button>
                ))}
              </div>
              {createVisibility === 'private' && (
                <input
                  type="password"
                  placeholder="Password (4+ chars, optional for invite-only)"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  autoComplete="new-password"
                />
              )}
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={loading || !createName.trim()}
                style={{
                  width: '100%',
                  boxShadow: !createName.trim()
                    ? undefined
                    : `0 0 18px rgba(232, 196, 85, 0.45), inset 0 0 0 1px ${theme.gold.border}`,
                  transition: `box-shadow ${theme.motion.normal}`,
                }}
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
                onChange={(e) => {
                  setJoinCode(e.target.value.toUpperCase());
                  // Changing the code invalidates the prior private-session
                  // prompt \u2014 reset so we fall back to the first-try path.
                  if (joinRequiresPassword) { setJoinRequiresPassword(false); setJoinPassword(''); }
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                maxLength={8}
                style={{ textTransform: 'uppercase', letterSpacing: '2px' }}
              />
              {joinRequiresPassword && (
                <input
                  type="password"
                  placeholder="Session password"
                  value={joinPassword}
                  onChange={(e) => setJoinPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  autoFocus
                  autoComplete="off"
                />
              )}
              <button
                className="btn-primary"
                onClick={handleJoin}
                disabled={loading || !joinCode.trim() || (joinRequiresPassword && !joinPassword)}
                style={{ width: '100%' }}
              >
                <Users size={16} />
                {joinRequiresPassword ? 'Enter Password' : 'Join Game'}
              </button>
            </div>
          </div>
        </div>

        {/* Previous Games */}
        {savedSessions.length > 0 && (
          <div style={styles.savedSection}>
            <div style={styles.savedHeader}>
              <History size={18} color={theme.gold.primary} />
              <h3 style={styles.savedTitle}>Recent Sessions (Local)</h3>
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
          KBRT.AI — Your adventure awaits.
        </p>
      </div>

      {/* Banned modal \u2014 blocking, no retry. */}
      {banModal && (
        <div style={styles.bannedOverlay} role="dialog" aria-modal="true" aria-label="You were banned">
          <div style={styles.bannedCard}>
            <AlertTriangle size={32} color={theme.state.danger} />
            <h2 style={styles.bannedTitle}>You were banned from this session</h2>
            {banModal.bannedBy && (
              <p style={styles.bannedMeta}>Banned by {banModal.bannedBy}</p>
            )}
            {banModal.reason && (
              <p style={styles.bannedReason}>&ldquo;{banModal.reason}&rdquo;</p>
            )}
            <button
              className="btn-primary"
              onClick={() => {
                setBanModal(null);
                setJoinCode('');
                setJoinPassword('');
                setJoinRequiresPassword(false);
              }}
              style={{ marginTop: 16 }}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflowY: 'auto',
    overflowX: 'hidden',
    // P5 — layered radial + ember glow to give the lobby the same
    // "tome being opened by candlelight" feel as the in-session shell.
    // Two radial layers: a warm gold glow high-left (candle) and a
    // deeper red pulse low-right (hearth) over the original dark
    // radial. Purely decorative; content is padded-in on top.
    background: `
      radial-gradient(ellipse at 20% 15%, rgba(232, 196, 85, 0.12) 0%, transparent 55%),
      radial-gradient(ellipse at 80% 85%, rgba(192, 57, 43, 0.10) 0%, transparent 60%),
      radial-gradient(ellipse at center, ${theme.bg.base} 0%, ${theme.bg.deepest} 70%)
    `,
    padding: '40px 24px',
  },
  content: {
    maxWidth: 800,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 32,
    margin: 'auto 0',
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
    letterSpacing: '8px',
    textTransform: 'uppercase' as const,
    textShadow: `0 0 30px rgba(224, 180, 79, 0.45)`,
    margin: 0,
  },
  subtitle: {
    fontFamily: theme.font.display,
    fontSize: 13,
    color: theme.text.secondary,
    letterSpacing: '4px',
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
  // My Games / My Characters sections
  sectionContainer: {
    width: '100%',
    maxWidth: 700,
    margin: '0 auto',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: theme.gold.primary,
    fontFamily: theme.font.display,
    letterSpacing: '3px',
    textTransform: 'uppercase' as const,
    margin: 0,
  },
  emptyState: {
    fontSize: 13,
    color: theme.text.muted,
    fontStyle: 'italic',
    margin: 0,
    padding: '12px 16px',
    background: theme.bg.card,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    textAlign: 'center' as const,
  },
  gamesList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  gameCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    background: theme.bg.card,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    transition: `border-color ${theme.motion.fast}`,
  },
  gameInfo: {
    flex: 1,
    minWidth: 0,
  },
  gameName: {
    fontSize: 14,
    fontWeight: 600,
    color: theme.text.primary,
    marginBottom: 4,
  },
  gameMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
  },
  roleBadge: {
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    borderRadius: 3,
    textTransform: 'uppercase' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
  },
  charsList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  charCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: theme.bg.card,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
  },
  charPortrait: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    border: `2px solid ${theme.border.default}`,
  },
  charPortraitPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: theme.bg.elevated,
    border: `2px solid ${theme.border.default}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    fontWeight: 700,
    color: theme.text.secondary,
  },
  charInfo: {
    flex: 1,
    minWidth: 0,
  },
  charNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  charName: {
    fontSize: 14,
    fontWeight: 600,
    color: theme.text.primary,
  },
  charMeta: {
    display: 'flex',
    gap: 8,
    fontSize: 11,
    color: theme.text.secondary,
    marginTop: 2,
  },
  duplicateBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    borderRadius: 3,
    textTransform: 'uppercase' as const,
    background: theme.state.warningBg,
    color: theme.state.warning,
    border: `1px solid rgba(243, 156, 18, 0.3)`,
  },
  // Create / Join cards
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
  userBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 16px',
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    width: '100%',
    maxWidth: 600,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    objectFit: 'cover' as const,
  },
  avatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    color: theme.gold.primary,
  },
  userName: {
    flex: 1,
    fontSize: 14,
    fontWeight: 600,
    color: theme.text.primary,
  },
  visibilityToggle: {
    display: 'flex',
    gap: 6,
  },
  visibilityButton: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    background: theme.bg.deep,
    color: theme.text.secondary,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  visibilityButtonActive: {
    background: theme.gold.bg,
    color: theme.gold.primary,
    borderColor: theme.gold.border,
  },
  bannedOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  bannedCard: {
    maxWidth: 480,
    padding: '32px 28px',
    background: theme.bg.deep,
    border: `1px solid ${theme.state.danger}`,
    borderRadius: theme.radius.lg,
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
  },
  bannedTitle: {
    ...theme.type.h2,
    color: theme.state.danger,
    margin: 0,
  },
  bannedMeta: {
    fontSize: 13,
    color: theme.text.muted,
    margin: 0,
  },
  bannedReason: {
    fontSize: 14,
    color: theme.text.primary,
    fontStyle: 'italic' as const,
    margin: '8px 0 0',
  },
};
