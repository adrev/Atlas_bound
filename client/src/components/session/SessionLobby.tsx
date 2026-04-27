/**
 * KBRT.AI — The Great Hall (lobby).
 *
 * Recreated from the handoff design at `kbrt-ai/project/KBRT Login.html`
 * (the "Great Hall" view — file name is misleading; the same prototype
 * holds login + lobby and the user said the lobby is what we're
 * remaking). Visual structure is pixel-faithful to the prototype:
 *
 *   ┌─ topbar ──────────────────────────────────────────┐
 *   ├─ rail ─┬───── stage ──────────┬─ right-rail ──────┤
 *   │ me     │ greeting + h1         │ tidings           │
 *   │ heroes │ hero CTAs (3-up)      │ companions        │
 *   │        │ my campaigns grid     │ quick actions     │
 *   │        │ chronicle timeline    │                   │
 *   └────────┴───────────────────────┴───────────────────┘
 *
 * Data wiring keeps every existing endpoint:
 *   - GET /api/sessions/mine        → My Campaigns grid
 *   - GET /api/characters           → Heroes rail
 *   - createSession + joinSession   → modal flows
 *
 * Spec stubs (deliberately not built yet — server features missing):
 *   - Chronicle = empty state until the LLM recap pipeline ships
 *   - Companions = empty state until the friend system ships
 *   - Tidings    = static seed copy until the patch-notes CMS ships
 *
 * Styling lives in a single `<style>` block scoped under `.kbrt-lobby`
 * so the design system doesn't leak into the in-session AppShell. The
 * CSS is mostly verbatim from the prototype; class names are namespaced
 * to avoid collisions with existing inline-styled components.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bell,
  HelpCircle,
  LogOut,
  ChevronRight,
  Swords,
  ScrollText,
  X,
  BookOpen,
  Map as MapIcon,
  Settings,
  Lightbulb,
  Shield,
} from 'lucide-react';
import { createSession, joinSession } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { FeedbackModal } from '../feedback/FeedbackModal';

// ────────────────────────────────────────────────────────────────
// Types — shapes returned by existing endpoints. Optional fields
// reflect server-side reality: many of the spec's per-tile niceties
// (banner art, online count, where-left-off line) are not yet
// surfaced by the API; we render gracefully when they're missing.
// ────────────────────────────────────────────────────────────────
interface ServerGame {
  id: string;
  roomCode: string;
  name: string;
  role: 'dm' | 'player';
  playerCount: number;
  /** Set when the API exposes "current state" for the lobby Live dot.
   *  When absent, the dot is hidden — no fake "Live" claims. */
  isLive?: boolean;
  /** Number of currently-connected players, also from the presence
   *  service when it lands. Hidden when undefined. */
  onlineCount?: number;
  /** Banner gradient (or future image URL). When missing, fall back
   *  to a deterministic biome-tinted gradient based on the campaign id. */
  bannerUrl?: string;
  /** The current user's character in this campaign — Player tiles
   *  surface this in the meta line so they can spot which PC is theirs. */
  characterName?: string;
  /** Last activity timestamp; surfaced as "2d ago" in the meta line. */
  lastActiveAt?: string;
}

interface MyCharacter {
  id: string;
  name: string;
  class?: string;
  race?: string;
  level?: number;
  portraitUrl?: string;
  /** Some imported chars use ddb id as the "primary key"; we don't
   *  surface this in the UI but it helps de-dup. */
  dndbeyondId?: string;
  /** Set if the character is currently used in a campaign — drives
   *  the "active hero" highlight in the Heroes rail. */
  activeCampaignId?: string;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Single uppercase glyph for an avatar fallback. */
function initial(s: string | null | undefined): string {
  return (s ?? '?').trim().charAt(0).toUpperCase() || '?';
}

/** Deterministic biome-ish tint per campaign id so banners feel
 *  distinct without real art. Mirrors the prototype's gradient pairs. */
const BIOME_GRADIENTS = [
  ['#3a4a25', '#1a2410'], // forest
  ['#4a2a18', '#2a1410'], // wasteland
  ['#2a2a4a', '#0e0e22'], // arcane night
  ['#3a2a4a', '#1a0e22'], // velvet
  ['#1a3a4a', '#0a1a22'], // tundra
  ['#4a3a18', '#2a1f0a'], // dunes
] as const;
function bannerGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const [a, b] = BIOME_GRADIENTS[h % BIOME_GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/** Per-character avatar tint — same hashing trick. The design uses
 *  flat colored squares behind a single capital letter, so this
 *  reproduces the look without needing portrait uploads. */
const HERO_TINTS = ['#3a1a4a', '#4a2a18', '#1a3a4a', '#3a4a25', '#4a3a18', '#2a2a4a'] as const;
function heroTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return HERO_TINTS[h % HERO_TINTS.length];
}

/** "Just now / 2h ago / 3 days ago" — only used for the lobby tiles
 *  + chronicle. Matches the relative formatter in AdminFeedbackPage. */
function formatRelative(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 60) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 14) return `${day}d ago`;
  return d.toLocaleDateString();
}

/** Player title derived from role + game count, mirroring the spec's
 *  "Keeper of Tales · Lv 12" line. Pure UI flair until we ship a real
 *  title system; the rule is intentionally simple so it's predictable. */
function deriveTitle(games: ServerGame[]): { title: string; level: number } {
  const dmCount = games.filter((g) => g.role === 'dm').length;
  const playerCount = games.filter((g) => g.role === 'player').length;
  let title = 'Wandering Adventurer';
  if (dmCount >= 5) title = 'Keeper of Tales';
  else if (dmCount >= 1) title = 'Storyweaver';
  else if (playerCount >= 5) title = 'Wandering Bard';
  else if (playerCount >= 1) title = 'Hero';
  // "Level" is just total games, capped — gives the chip a number to flex.
  return { title, level: Math.min(99, dmCount + playerCount) };
}

// ────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────
export function SessionLobby() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const setDisplayName = useSessionStore((s) => s.setDisplayName);
  const authUser = useAuthStore((s) => s.user);
  const authLogout = useAuthStore((s) => s.logout);

  // Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [banModal, setBanModal] = useState<{ reason: string | null; bannedBy: string | null } | null>(null);

  // Forge a New Campaign form
  const [createName, setCreateName] = useState('');
  const [createPremise, setCreatePremise] = useState('');
  const [createVisibility, setCreateVisibility] = useState<'public' | 'private'>('public');
  const [createPassword, setCreatePassword] = useState('');
  const [startMap, setStartMap] = useState<'forest' | 'dungeon' | 'tavern'>('forest');

  // Break the Seal form
  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinRequiresPassword, setJoinRequiresPassword] = useState(false);
  const [joinHeroId, setJoinHeroId] = useState<string>('');

  // Fetch state
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [myGames, setMyGames] = useState<ServerGame[]>([]);
  const [myGamesLoading, setMyGamesLoading] = useState(false);
  const [myCharacters, setMyCharacters] = useState<MyCharacter[]>([]);
  const [myCharsLoading, setMyCharsLoading] = useState(false);

  // Filter tab state for My Campaigns: All / DMing / Playing
  const [gameFilter, setGameFilter] = useState<'all' | 'dm' | 'player'>('all');

  // ── Data fetch ────────────────────────────────────────────────
  const fetchMyGames = async () => {
    setMyGamesLoading(true);
    try {
      const res = await fetch('/api/sessions/mine', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMyGames(Array.isArray(data) ? data : data.sessions || []);
      }
    } catch {
      /* silently fail — section just stays empty */
    } finally {
      setMyGamesLoading(false);
    }
  };

  const fetchMyCharacters = async () => {
    setMyCharsLoading(true);
    try {
      const res = await fetch('/api/characters', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMyCharacters(Array.isArray(data) ? data : data.characters || []);
      }
    } catch {
      /* silently fail */
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

  // Bounce back to a `?next=` invite URL once auth lands.
  useEffect(() => {
    const next = searchParams.get('next');
    if (authUser && next && next.startsWith('/')) {
      searchParams.delete('next');
      setSearchParams(searchParams, { replace: true });
      navigate(next, { replace: true });
    }
  }, [authUser, searchParams, setSearchParams, navigate]);

  // Pre-fill the join modal from `?roomCode=`. InviteLanding sends the
  // user back here after rotating an expired token.
  useEffect(() => {
    const code = searchParams.get('roomCode');
    if (code) {
      setJoinCode(code.toUpperCase());
      setJoinOpen(true);
      searchParams.delete('roomCode');
      setSearchParams(searchParams, { replace: true });
    }
    // run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived view data ─────────────────────────────────────────
  const filteredGames = useMemo(() => {
    if (gameFilter === 'dm') return myGames.filter((g) => g.role === 'dm');
    if (gameFilter === 'player') return myGames.filter((g) => g.role === 'player');
    return myGames;
  }, [myGames, gameFilter]);

  const resumeGame = useMemo(() => {
    // Surface the most-recently-active campaign as the Resume CTA.
    // Prefer something explicitly Live, then fall back to the first
    // tile the API gave us (already ordered by recency server-side).
    const live = myGames.find((g) => g.isLive);
    return live ?? myGames[0] ?? null;
  }, [myGames]);

  const titleInfo = useMemo(() => deriveTitle(myGames), [myGames]);
  const heroCount = myCharacters.length;
  // "Played hours" — placeholder until session-time aggregation ships.
  // We show a dash rather than fake a number.
  const playedHoursLabel = '—';

  // ── Handlers ──────────────────────────────────────────────────
  const handleLogout = async () => {
    await authLogout();
    navigate('/');
  };

  const resetCreateForm = () => {
    setCreateName('');
    setCreatePremise('');
    setCreateVisibility('public');
    setCreatePassword('');
    setStartMap('forest');
  };

  const resetJoinForm = () => {
    setJoinCode('');
    setJoinPassword('');
    setJoinRequiresPassword(false);
    setJoinHeroId('');
  };

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
      setCreateOpen(false);
      resetCreateForm();
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
        setJoinOpen(false);
        resetJoinForm();
        navigate(`/session/${code}`);
        return;
      }
      if (result.kind === 'requires-password') {
        setJoinRequiresPassword(true);
        setError(joinRequiresPassword ? 'Wrong password — try again.' : null);
      } else if (result.kind === 'banned') {
        setBanModal({ reason: result.reason, bannedBy: result.bannedBy });
        setJoinOpen(false);
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

  // Quick Action stubs — wire to real routes when the views land.
  const showSoon = (label: string) =>
    setError(`${label} is coming soon — focused on the lobby for now.`);

  const enterGame = (roomCode: string) => navigate(`/session/${roomCode}`);

  // ────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────
  return (
    <div className="kbrt-lobby">
      <style>{LOBBY_CSS}</style>

      {/* ============ TOP BAR ============ */}
      <div className="topbar">
        <div className="brand">
          <div className="crest">K</div>
          <div className="wordmark">
            KBRT<em>.AI</em>
          </div>
        </div>
        <div className="nav">
          <a className="active">Great Hall</a>
          <a onClick={() => showSoon('Library')}>Library</a>
          <a onClick={() => showSoon('Compendium')}>Compendium</a>
          <a onClick={() => showSoon('Settings')}>Settings</a>
        </div>
        <div className="spacer" />
        <button className="icon-btn" title="Notifications (coming soon)" onClick={() => showSoon('Notifications')}>
          <Bell size={16} />
        </button>
        <button className="icon-btn" title="Send feedback" onClick={() => setFeedbackOpen(true)}>
          <Lightbulb size={16} />
        </button>
        <button className="icon-btn" title="Help (coming soon)" onClick={() => showSoon('Help')}>
          <HelpCircle size={16} />
        </button>
        {authUser?.isAdmin && (
          <button
            className="icon-btn"
            title="Feedback admin"
            onClick={() => navigate('/admin/feedback')}
          >
            <Shield size={16} />
          </button>
        )}
        <div className="me" title={authUser?.email ?? ''}>
          {authUser?.avatarUrl ? (
            <img className="avatar" src={authUser.avatarUrl} alt={authUser.displayName} />
          ) : (
            <div className="avatar">{initial(authUser?.displayName)}</div>
          )}
          <div className="name">
            {authUser?.displayName ?? '—'}
            <span className="role">● {titleInfo.title.toUpperCase()}</span>
          </div>
        </div>
        <button className="icon-btn" title="Log out" onClick={handleLogout}>
          <LogOut size={16} />
        </button>
      </div>

      {/* ============ HALL ============ */}
      <div className="hall">
        {/* ===== LEFT RAIL ===== */}
        <aside className="rail">
          <div className="me-card">
            <div className="ring">
              <svg className="frame" viewBox="0 0 140 140" fill="none" stroke="currentColor" strokeWidth={1}>
                <circle cx="70" cy="70" r="68" />
                <path d="M70 0 L72 8 L70 12 L68 8 Z" fill="currentColor" />
                <path d="M70 140 L72 132 L70 128 L68 132 Z" fill="currentColor" />
                <path d="M0 70 L8 68 L12 70 L8 72 Z" fill="currentColor" />
                <path d="M140 70 L132 68 L128 70 L132 72 Z" fill="currentColor" />
              </svg>
              <div className="av">
                {authUser?.avatarUrl ? (
                  <img src={authUser.avatarUrl} alt="" />
                ) : (
                  <span className="av-initial">{initial(authUser?.displayName)}</span>
                )}
              </div>
            </div>
            <h2 className="handle">{authUser?.displayName?.toUpperCase() ?? 'TRAVELER'}</h2>
            <p className="me-title">
              {titleInfo.title} · Lv {titleInfo.level}
            </p>
            <div className="stats">
              <div className="s">
                <span className="n">{myGames.length}</span>
                <span className="l">Games</span>
              </div>
              <div className="s">
                <span className="n">{heroCount}</span>
                <span className="l">Heroes</span>
              </div>
              <div className="s">
                <span className="n">{playedHoursLabel}</span>
                <span className="l">Played</span>
              </div>
            </div>
          </div>

          <h3>Heroes</h3>
          {myCharsLoading && myCharacters.length === 0 ? (
            <p className="rail-empty">Loading thy heroes…</p>
          ) : myCharacters.length === 0 ? (
            <p className="rail-empty">No heroes yet. Forge one to begin.</p>
          ) : (
            myCharacters.map((c) => (
              <button
                key={c.id}
                className={`char-card${c.activeCampaignId ? ' active' : ''}`}
                onClick={() => showSoon('Character sheet from lobby')}
                title={`${c.name}${c.race ? ` — ${c.race}` : ''}${c.class ? ` ${c.class}` : ''}`}
              >
                <div className="pp" style={{ background: heroTint(c.id) }}>
                  {c.portraitUrl ? (
                    <img src={c.portraitUrl} alt="" />
                  ) : (
                    <span className="pp-initial">{initial(c.name)}</span>
                  )}
                </div>
                <div className="info">
                  <p className="n">{c.name}</p>
                  <p className="s">
                    {[c.race, c.class].filter(Boolean).join(' ') || 'Unaligned wanderer'}
                  </p>
                </div>
                <span className="lv">LV {c.level ?? '?'}</span>
              </button>
            ))
          )}
          <button className="add-char" onClick={() => showSoon('Hero forge')}>
            + Forge New Hero
          </button>
        </aside>

        {/* ===== CENTER STAGE ===== */}
        <main className="stage">
          <p className="greeting">
            Welcome back{authUser ? `, ${authUser.displayName}` : ', traveler'}.
          </p>
          <h1>
            The Great <em>Hall</em>
          </h1>
          <div className="crest-rule">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth={1.5} fill="none" />
            </svg>
          </div>

          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button className="error-x" onClick={() => setError(null)} aria-label="Dismiss">
                <X size={12} />
              </button>
            </div>
          )}

          {/* HERO CTA ROW */}
          <div className="hero-cta">
            <div
              className="cta-card resume"
              onClick={() => resumeGame && enterGame(resumeGame.roomCode)}
              role="button"
              tabIndex={0}
              aria-disabled={!resumeGame}
              style={resumeGame ? undefined : { opacity: 0.55, cursor: 'default' }}
            >
              <div className="map-thumb" />
              <p className="label">
                {resumeGame ? 'Last session · ready when you are' : 'No active campaign yet'}
              </p>
              <h3>{resumeGame?.name ?? 'Resume Adventure'}</h3>
              <p className="desc">
                {resumeGame
                  ? `Pick up where you left off in ${resumeGame.name}. Your party awaits.`
                  : 'Forge a new campaign or join one with a code to begin.'}
              </p>
              <div className="arr">▸ {resumeGame ? 'Resume Adventure' : 'Begin'}</div>
            </div>

            <div className="cta-card create" onClick={() => setCreateOpen(true)} role="button" tabIndex={0}>
              <p className="label">Begin Anew</p>
              <h3>
                <Swords size={16} />
                New Campaign
              </h3>
              <p className="desc">Forge a new tale and gather thy party.</p>
              <div className="arr">▸ Create Game</div>
            </div>

            <div className="cta-card join" onClick={() => setJoinOpen(true)} role="button" tabIndex={0}>
              <p className="label">By Invitation</p>
              <h3>
                <ChevronRight size={16} />
                Join with Code
              </h3>
              <p className="desc">Enter a room seal from the DM.</p>
              <div className="arr">▸ Join Game</div>
            </div>
          </div>

          {/* MY CAMPAIGNS */}
          <div className="section-head">
            <h2>
              <Swords size={14} />
              My Campaigns
            </h2>
            <div className="rule" />
            <div className="filters">
              <button
                className={`filter${gameFilter === 'all' ? ' active' : ''}`}
                onClick={() => setGameFilter('all')}
              >
                All
              </button>
              <button
                className={`filter${gameFilter === 'dm' ? ' active' : ''}`}
                onClick={() => setGameFilter('dm')}
              >
                DMing
              </button>
              <button
                className={`filter${gameFilter === 'player' ? ' active' : ''}`}
                onClick={() => setGameFilter('player')}
              >
                Playing
              </button>
            </div>
          </div>

          {myGamesLoading && filteredGames.length === 0 ? (
            <p className="empty-prose">Gathering thy campaigns…</p>
          ) : filteredGames.length === 0 ? (
            <p className="empty-prose">
              No campaigns {gameFilter === 'dm' ? 'you are running' : gameFilter === 'player' ? 'you are playing in' : 'yet'}.
              {gameFilter === 'all' && ' Forge a new campaign or join one with a code.'}
            </p>
          ) : (
            <div className="games-grid">
              {filteredGames.map((g) => (
                <div key={g.id} className="game-tile" onClick={() => enterGame(g.roomCode)} role="button" tabIndex={0}>
                  <div
                    className="banner"
                    style={{ background: g.bannerUrl ? `url(${g.bannerUrl})` : bannerGradient(g.id) }}
                  >
                    <span className={`role-pill ${g.role}`}>{g.role === 'dm' ? 'DM' : 'PLAYER'}</span>
                    {g.isLive && <span className="live-dot">Live</span>}
                  </div>
                  <div className="body">
                    <p className="name">{g.name}</p>
                    <div className="meta">
                      <span className="item">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                          <circle cx="9" cy="8" r="3" />
                          <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
                        </svg>
                        {g.playerCount}
                      </span>
                      <span className="code">{g.roomCode}</span>
                      {g.role === 'player' && g.characterName && <span className="item">{g.characterName}</span>}
                      {typeof g.onlineCount === 'number' && g.onlineCount > 0 && (
                        <span className="item online-count">{g.onlineCount} online</span>
                      )}
                      {!g.isLive && g.lastActiveAt && <span className="item">{formatRelative(g.lastActiveAt)}</span>}
                    </div>
                    <div className="actions">
                      <button
                        className="btn primary full"
                        onClick={(e) => { e.stopPropagation(); enterGame(g.roomCode); }}
                      >
                        Enter
                      </button>
                      <button
                        className="btn ghost"
                        onClick={(e) => { e.stopPropagation(); enterGame(g.roomCode); }}
                      >
                        {g.role === 'dm' ? 'Manage' : 'Sheet'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* CHRONICLE — empty state until the LLM recap pipeline ships */}
          <div className="section-head">
            <h2>
              <ScrollText size={14} />
              Chronicle
            </h2>
            <div className="rule" />
          </div>
          <div className="chron-empty">
            <ScrollText size={20} />
            <p>
              Your chronicle is empty. After your next session ends, the Loremasters will draft a recap here so you
              never forget where you left off.
            </p>
          </div>

          <p className="quill" style={{ margin: '36px 0 24px' }}>
            KBRT.AI — Your adventure awaits.
          </p>
        </main>

        {/* ===== RIGHT RAIL ===== */}
        <aside className="right-rail">
          <h3 className="rr-head">
            Tidings
            <span className="rr-rule" />
          </h3>
          <div className="news">
            <div className="head">
              <ScrollText size={12} />
              From the Loremasters
            </div>
            <div className="item">
              <span className="when">This week</span>
              <span className="text">
                <em>Great Hall</em> — a brass-bound lobby redesign goes live, with chronicles, companions, and quick actions.
              </span>
            </div>
            <div className="item">
              <span className="when">Recently</span>
              <span className="text">
                <em>Feedback</em> — drop a note in the user menu and the Loremasters will see it within minutes.
              </span>
            </div>
            <div className="item">
              <span className="when">Coming soon</span>
              <span className="text">
                <em>Chronicle</em> — auto-summarized session recaps appear on the home view after every game.
              </span>
            </div>
          </div>

          <h3 className="rr-head">
            Companions
            <span className="rr-count">— soon —</span>
            <span className="rr-rule" />
          </h3>
          <p className="rr-empty">
            The friend system is being forged. Once it lands, your party members and tablemates will appear here with
            presence dots and an Invite button.
          </p>

          <h3 className="rr-head" style={{ marginTop: 24 }}>
            Quick Actions
            <span className="rr-rule" />
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="btn ghost qa-btn" onClick={() => showSoon('Compendium')}>
              <BookOpen size={13} />
              Open Compendium
            </button>
            <button className="btn ghost qa-btn" onClick={() => showSoon('Map Library')}>
              <MapIcon size={13} />
              Map Library
            </button>
            <button className="btn ghost qa-btn" onClick={() => showSoon('Settings')}>
              <Settings size={13} />
              Settings
            </button>
            <button className="btn ghost qa-btn" onClick={() => setFeedbackOpen(true)}>
              <Lightbulb size={13} />
              Send Feedback
            </button>
          </div>
        </aside>
      </div>

      {/* ============ MODALS ============ */}

      {/* Forge a New Campaign */}
      {createOpen && (
        <div className="scrim open" onClick={(e) => { if (e.target === e.currentTarget) setCreateOpen(false); }}>
          <div className="modal">
            <div className="modal-head">
              <Swords size={20} color="var(--accent)" />
              <h3>Forge a New Campaign</h3>
              <button className="icon-btn" onClick={() => setCreateOpen(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Campaign Name</label>
                <input
                  className="input"
                  placeholder="e.g., The Fall of Candlekeep"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="field">
                <label>One-line Premise (optional)</label>
                <input
                  className="input"
                  placeholder="A flickering rumor stirs the moor…"
                  value={createPremise}
                  onChange={(e) => setCreatePremise(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Visibility</label>
                <div className="priv-row">
                  <button
                    className={`btn ghost${createVisibility === 'public' ? ' on' : ''}`}
                    onClick={() => setCreateVisibility('public')}
                    type="button"
                  >
                    🌐 Public — anyone with code
                  </button>
                  <button
                    className={`btn ghost${createVisibility === 'private' ? ' on' : ''}`}
                    onClick={() => setCreateVisibility('private')}
                    type="button"
                  >
                    🔒 Private — password
                  </button>
                </div>
              </div>
              {createVisibility === 'private' && (
                <div className="field">
                  <label>Password</label>
                  <input
                    type="password"
                    className="input"
                    placeholder="At least 4 characters"
                    value={createPassword}
                    onChange={(e) => setCreatePassword(e.target.value)}
                  />
                </div>
              )}
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Starting Map</label>
                <div className="map-picks">
                  {(['forest', 'dungeon', 'tavern'] as const).map((m) => (
                    <div
                      key={m}
                      className={`map-pick ${m}${startMap === m ? ' on' : ''}`}
                      onClick={() => setStartMap(m)}
                      role="button"
                      tabIndex={0}
                    >
                      {m.toUpperCase()}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button
                className="btn primary"
                onClick={handleCreate}
                disabled={loading || !createName.trim()}
              >
                {loading ? 'Forging…' : 'Forge Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Break the Seal */}
      {joinOpen && (
        <div className="scrim open" onClick={(e) => { if (e.target === e.currentTarget) setJoinOpen(false); }}>
          <div className="modal" style={{ width: 440 }}>
            <div className="modal-head">
              <ChevronRight size={20} color="var(--accent)" />
              <h3>Break the Seal</h3>
              <button className="icon-btn" onClick={() => setJoinOpen(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-tag">Speak the room sigil delivered by your DM.</p>
              <input
                className="input code"
                placeholder="ABCD123"
                maxLength={10}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                style={{ fontSize: 22, padding: 18 }}
                autoFocus
              />
              {joinRequiresPassword && (
                <div className="field" style={{ marginTop: 14 }}>
                  <label>Password</label>
                  <input
                    type="password"
                    className="input"
                    placeholder="Room password"
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value)}
                  />
                </div>
              )}
              {myCharacters.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <label className="join-label">Bring a Hero (optional)</label>
                  <select
                    className="input"
                    value={joinHeroId}
                    onChange={(e) => setJoinHeroId(e.target.value)}
                  >
                    <option value="">— Decide on arrival —</option>
                    {myCharacters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.race ? ` · ${c.race}` : ''}
                        {c.class ? ` ${c.class}` : ''}
                        {c.level ? ` · Lv ${c.level}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setJoinOpen(false)}>Cancel</button>
              <button
                className="btn primary"
                onClick={handleJoin}
                disabled={loading || !joinCode.trim()}
              >
                {loading ? 'Knocking…' : 'Join Game'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Banned (kept from previous lobby — same UX, restyled) */}
      {banModal && (
        <div className="scrim open">
          <div className="modal banned">
            <div className="modal-head">
              <h3 style={{ color: 'var(--blood-400)' }}>You have been banned</h3>
              <button className="icon-btn" onClick={() => { setBanModal(null); resetJoinForm(); }}>
                <X size={14} />
              </button>
            </div>
            <div className="modal-body">
              {banModal.bannedBy && (
                <p className="bm-meta">Banned by {banModal.bannedBy}</p>
              )}
              {banModal.reason && (
                <p className="bm-reason">"{banModal.reason}"</p>
              )}
              {!banModal.reason && !banModal.bannedBy && (
                <p className="bm-meta">No reason was provided.</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn primary" onClick={() => { setBanModal(null); resetJoinForm(); }}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback (existing component) */}
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// CSS — scoped under .kbrt-lobby so the design system doesn't leak
// into AppShell. Mostly a verbatim port of the prototype's stylesheet
// with the addition of a few helpers (.empty-prose, .chron-empty,
// .error-banner, .map-pick, .qa-btn) for things the prototype sketched
// but didn't formalise.
// ────────────────────────────────────────────────────────────────
const LOBBY_CSS = `
.kbrt-lobby {
  --ink-900:#0a0604; --ink-850:#120c07; --ink-800:#1a120a; --ink-700:#241810;
  --parch-100:#f4e4bc;
  --gilt-300:#f2d27a; --gilt-400:#e0b44f; --gilt-500:#c79632; --gilt-600:#a27519; --gilt-700:#6b4a0f;
  --blood-400:#c9423a; --blood-500:#9d2a23; --wax-red:#7a1f1a;
  --bg-body:var(--ink-900); --bg-panel:#140e07; --bg-panel-raised:#1e1509; --bg-panel-deep:#0c0805;
  --border-line:rgba(199,150,50,.30); --border-line-strong:rgba(199,150,50,.55);
  --text-primary:#ead6a8; --text-secondary:#a89271; --text-muted:#6b5a3f;
  --accent:var(--gilt-400); --danger:var(--blood-400); --success:#7aa266; --rune-blue:#6aa9d1;
  --font-display:'Cinzel',serif; --font-body:'Spectral',serif; --font-ui:'Inter',sans-serif; --font-script:'Cormorant Garamond',serif;
  background:
    radial-gradient(ellipse 1200px 800px at 30% 20%, rgba(224,180,79,.06), transparent 60%),
    radial-gradient(ellipse 900px 600px at 80% 80%, rgba(157,42,35,.05), transparent 60%),
    var(--ink-900);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
  width: 100%;
  position: relative;
  overflow-x: hidden;
}
.kbrt-lobby * { box-sizing: border-box; }
.kbrt-lobby a { color: inherit; text-decoration: none; }
.kbrt-lobby button { font-family: inherit; }

/* ===== TOPBAR ===== */
.kbrt-lobby .topbar {
  height: 64px; display:flex; align-items:center; padding:0 24px; gap:18px;
  background: linear-gradient(180deg, var(--bg-panel-raised), var(--bg-panel));
  border-bottom: 1px solid var(--border-line-strong);
  position: relative; z-index: 5;
}
.kbrt-lobby .topbar::after {
  content:''; position:absolute; left:0; right:0; bottom:-1px; height:1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity:.5;
}
.kbrt-lobby .brand { display:flex; align-items:center; gap:10px; }
.kbrt-lobby .brand .crest {
  width:36px; height:36px; display:grid; place-items:center;
  background: radial-gradient(circle at 30% 30%, var(--accent), var(--ink-900) 70%);
  border-radius:50%; color: var(--ink-900);
  font-family: var(--font-display); font-weight:800; font-size:15px;
  box-shadow: 0 0 0 2px var(--bg-panel), 0 0 0 3px var(--border-line-strong);
}
.kbrt-lobby .brand .wordmark {
  font-family: var(--font-display); font-weight:700; font-size:14px; letter-spacing:4px;
  color: var(--text-primary);
}
.kbrt-lobby .brand .wordmark em { font-style:normal; color: var(--accent); }
.kbrt-lobby .topbar .nav { display:flex; gap:4px; margin-left:18px; }
.kbrt-lobby .topbar .nav a {
  padding:8px 14px; font-family: var(--font-display); font-size:10px; letter-spacing:2px;
  color: var(--text-muted); text-transform: uppercase; border-radius:2px; cursor:pointer;
  transition: all .15s;
}
.kbrt-lobby .topbar .nav a.active { color: var(--accent); background: rgba(224,180,79,.08); }
.kbrt-lobby .topbar .nav a:hover { color: var(--accent); }
.kbrt-lobby .topbar .spacer { flex:1; }
.kbrt-lobby .topbar .me {
  display:flex; align-items:center; gap:10px; padding:4px 12px 4px 4px;
  border:1px solid var(--border-line); border-radius:20px; cursor:pointer; background: var(--bg-panel);
  transition: border-color .15s;
}
.kbrt-lobby .topbar .me:hover { border-color: var(--border-line-strong); }
.kbrt-lobby .topbar .me .avatar {
  width:30px; height:30px; border-radius:50%; overflow:hidden;
  background: linear-gradient(135deg, #6a4a8a, #1a0e22);
  display:grid; place-items:center;
  font-family: var(--font-display); font-weight:700; color: var(--accent); font-size:12px;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 3px var(--bg-panel);
}
.kbrt-lobby .topbar .me .avatar img { width:100%; height:100%; object-fit:cover; }
.kbrt-lobby .topbar .me .name { font-family: var(--font-display); font-size:12px; letter-spacing:1.5px; }
.kbrt-lobby .topbar .me .name .role {
  display:block; font-size:8px; color: var(--success); letter-spacing:2px; font-weight:600; margin-top:2px;
}

.kbrt-lobby .icon-btn {
  width:36px; height:36px; display:grid; place-items:center; cursor:pointer;
  color: var(--text-muted); border:1px solid transparent; background:transparent; border-radius:3px;
  transition: all .15s;
}
.kbrt-lobby .icon-btn:hover { color: var(--accent); border-color: var(--border-line); background: var(--bg-panel); }

/* ===== HALL LAYOUT ===== */
.kbrt-lobby .hall {
  display:grid;
  grid-template-columns: 320px minmax(0, 1fr) 360px;
  height: calc(100vh - 64px);
  position: relative; z-index:1;
  overflow: hidden;
}
@media (max-width: 1280px) {
  .kbrt-lobby .hall { grid-template-columns: 280px minmax(0, 1fr) 300px; }
}
@media (max-width: 1100px) {
  .kbrt-lobby .hall { grid-template-columns: minmax(0, 1fr); height: auto; overflow: visible; }
  .kbrt-lobby .hall .rail, .kbrt-lobby .hall .right-rail { border:none; border-bottom:1px solid var(--border-line-strong); }
}
@media (max-width: 900px) {
  .kbrt-lobby .hero-cta { grid-template-columns: 1fr !important; }
  .kbrt-lobby .games-grid { grid-template-columns: 1fr !important; }
}

/* ===== LEFT RAIL ===== */
.kbrt-lobby .rail {
  background: linear-gradient(180deg, var(--bg-panel), var(--bg-panel-deep));
  border-right: 1px solid var(--border-line-strong);
  padding:24px 22px; overflow-y:auto;
  position: relative;
}
.kbrt-lobby .rail::-webkit-scrollbar { width:6px; }
.kbrt-lobby .rail::-webkit-scrollbar-thumb { background: var(--border-line); border-radius:3px; }
.kbrt-lobby .rail::after {
  content:''; position:absolute; top:0; right:0; bottom:0; width:1px;
  background: linear-gradient(180deg, transparent, var(--accent) 20%, var(--accent) 80%, transparent); opacity:.4;
}

.kbrt-lobby .me-card { text-align:center; padding:8px 0 18px; border-bottom:1px solid var(--border-line); margin-bottom:18px; }
.kbrt-lobby .me-card .ring { width:120px; height:120px; margin:0 auto 14px; position:relative; }
.kbrt-lobby .me-card .ring svg.frame {
  position:absolute; inset:-8px;
  width: calc(100% + 16px); height: calc(100% + 16px);
  color: var(--accent); opacity:.7;
}
.kbrt-lobby .me-card .ring .av {
  width:100%; height:100%; border-radius:50%; overflow:hidden;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px var(--bg-panel-deep), 0 0 30px rgba(224,180,79,.15);
  background: linear-gradient(135deg, #6a4a8a, #1a0e22);
  display:grid; place-items:center;
}
.kbrt-lobby .me-card .ring .av img { width:100%; height:100%; object-fit:cover; }
.kbrt-lobby .me-card .ring .av .av-initial { font-family: var(--font-display); font-weight:800; color: var(--accent); font-size:42px; }
.kbrt-lobby .me-card .handle {
  font-family: var(--font-display); font-size:18px; letter-spacing:3px;
  color: var(--text-primary); font-weight:700; margin:0 0 4px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.kbrt-lobby .me-card .me-title { font-family: var(--font-script); font-style:italic; color: var(--text-secondary); font-size:13px; margin:0 0 12px; }
.kbrt-lobby .me-card .stats { display:flex; justify-content:center; gap:20px; }
.kbrt-lobby .me-card .stats .s { display:flex; flex-direction:column; align-items:center; gap:2px; }
.kbrt-lobby .me-card .stats .n { font-family: var(--font-display); font-size:18px; color: var(--accent); font-weight:700; letter-spacing:1px; }
.kbrt-lobby .me-card .stats .l { font-family: var(--font-display); font-size:8px; color: var(--text-muted); letter-spacing:2px; text-transform:uppercase; }

.kbrt-lobby .rail h3 {
  font-family: var(--font-display); font-size:11px; letter-spacing:3px; color: var(--accent);
  text-transform: uppercase; font-weight:600; margin: 0 0 12px; display:flex; align-items:center; gap:8px;
}
.kbrt-lobby .rail h3::after {
  content:''; flex:1; height:1px; background: linear-gradient(90deg, var(--accent), transparent); opacity:.4;
}

.kbrt-lobby .char-card {
  display:flex; align-items:center; gap:12px; padding:10px;
  border:1px solid var(--border-line); background: var(--bg-panel-raised);
  border-radius:3px; cursor:pointer; transition: all .15s;
  margin-bottom:8px; position:relative; width:100%; text-align:left; color: inherit;
  font-family: inherit;
}
.kbrt-lobby .char-card:hover { border-color: var(--accent); transform: translateX(2px); }
.kbrt-lobby .char-card.active { border-color: var(--accent); background: rgba(224,180,79,.06); }
.kbrt-lobby .char-card.active::before {
  content:''; position:absolute; left:0; top:8px; bottom:8px; width:2px; background: var(--accent);
}
.kbrt-lobby .char-card .pp {
  width:42px; height:42px; border-radius:50%; flex:0 0 42px; overflow:hidden;
  box-shadow: 0 0 0 2px var(--accent); display:grid; place-items:center;
}
.kbrt-lobby .char-card .pp img { width:100%; height:100%; object-fit:cover; }
.kbrt-lobby .char-card .pp .pp-initial { font-family: var(--font-display); font-weight:700; color: var(--accent); font-size:16px; }
.kbrt-lobby .char-card .info { min-width:0; flex:1; }
.kbrt-lobby .char-card .info .n {
  font-family: var(--font-display); font-size:13px; font-weight:600; color: var(--text-primary);
  letter-spacing:.5px; margin:0 0 2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.kbrt-lobby .char-card .info .s {
  font-family: var(--font-body); font-style:italic; color: var(--text-secondary);
  font-size:11px; line-height:1.3; margin:0;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.kbrt-lobby .char-card .lv {
  margin-left:auto; font-family: var(--font-display); font-size:9px; color: var(--accent);
  letter-spacing:1.5px; border:1px solid var(--border-line); padding:3px 7px; border-radius:2px;
  text-transform: uppercase; flex-shrink:0;
}
.kbrt-lobby .rail .add-char {
  width:100%; padding:10px; border:1px dashed var(--border-line-strong); background:transparent;
  color: var(--text-muted); font-family: var(--font-display); font-size:10px; letter-spacing:2px;
  text-transform: uppercase; cursor:pointer; border-radius:3px; transition: all .15s;
}
.kbrt-lobby .rail .add-char:hover { color: var(--accent); border-color: var(--accent); background: rgba(224,180,79,.04); }
.kbrt-lobby .rail-empty { font-family: var(--font-script); font-style:italic; color: var(--text-muted); font-size:13px; margin:0 0 12px; text-align:center; }

/* ===== STAGE ===== */
.kbrt-lobby .stage {
  overflow-y:auto; padding:32px 36px;
  position:relative;
}
.kbrt-lobby .stage::-webkit-scrollbar { width:8px; }
.kbrt-lobby .stage::-webkit-scrollbar-thumb { background: var(--border-line); border-radius:4px; }

.kbrt-lobby .greeting {
  font-family: var(--font-script); font-style:italic; color: var(--text-secondary); font-size:16px;
  margin:0 0 4px; letter-spacing:1px;
}
.kbrt-lobby .stage h1 {
  font-family: var(--font-display); font-size:34px; letter-spacing:6px; color: var(--text-primary);
  text-transform: uppercase; font-weight:700; margin:0 0 4px;
}
.kbrt-lobby .stage h1 em { font-style:normal; color: var(--accent); }
.kbrt-lobby .crest-rule {
  display:flex; align-items:center; gap:10px; margin:14px 0 28px; color: var(--accent);
}
.kbrt-lobby .crest-rule::before, .kbrt-lobby .crest-rule::after {
  content:''; flex:1; height:1px; background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity:.5; max-width:240px;
}
.kbrt-lobby .crest-rule svg { width:16px; height:16px; }

/* Inline error banner */
.kbrt-lobby .error-banner {
  display:flex; align-items:center; gap:8px;
  padding:10px 12px; margin-bottom:18px;
  background: rgba(201,66,58,.18); border:1px solid var(--blood-400); border-radius:3px;
  color: var(--blood-400); font-size:13px;
}
.kbrt-lobby .error-x {
  margin-left:auto; background:transparent; border:none; color: var(--blood-400);
  cursor:pointer; padding:2px;
}

/* Hero CTA */
.kbrt-lobby .hero-cta {
  display:grid; grid-template-columns: 1.3fr 1fr 1fr; gap:14px; margin-bottom:28px; min-width:0;
}
.kbrt-lobby .cta-card .desc, .kbrt-lobby .cta-card h3, .kbrt-lobby .game-tile .name { overflow-wrap: break-word; word-break: normal; }
.kbrt-lobby .cta-card {
  position:relative; padding:18px; border-radius:5px; cursor:pointer;
  background: linear-gradient(180deg, var(--bg-panel-raised), var(--bg-panel));
  border:1px solid var(--border-line-strong); overflow:hidden;
  transition: all .2s;
}
.kbrt-lobby .cta-card::before {
  content:''; position:absolute; left:14px; right:14px; top:0; height:1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity:.45;
}
.kbrt-lobby .cta-card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 12px 30px rgba(0,0,0,.5); }
.kbrt-lobby .cta-card .label {
  font-family: var(--font-display); font-size:9px; letter-spacing:2.5px; color: var(--text-muted);
  text-transform: uppercase; margin:0 0 8px;
}
.kbrt-lobby .cta-card h3 {
  font-family: var(--font-display); font-size:18px; letter-spacing:3px; color: var(--accent);
  text-transform: uppercase; font-weight:700; margin:0 0 6px;
  display:flex; align-items:center; gap:8px;
}
.kbrt-lobby .cta-card .desc {
  font-family: var(--font-body); color: var(--text-secondary); font-size:12px; font-style:italic;
  margin:0 0 14px; line-height:1.45;
}
.kbrt-lobby .cta-card .arr {
  display:flex; align-items:center; gap:6px; color: var(--accent);
  font-family: var(--font-display); font-size:10px; letter-spacing:2px; text-transform: uppercase;
}
.kbrt-lobby .cta-card.resume {
  background:
    linear-gradient(180deg, rgba(20,14,7,.5), rgba(20,14,7,.95)),
    radial-gradient(ellipse at 30% 30%, rgba(224,180,79,.18), transparent 60%);
}
.kbrt-lobby .cta-card.resume .map-thumb {
  position:absolute; right:0; top:0; bottom:0; width:50%; opacity:.5; mix-blend-mode: luminosity; pointer-events:none;
  background:
    linear-gradient(90deg, var(--bg-panel) 0%, transparent 30%),
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200' preserveAspectRatio='xMidYMid slice'><rect width='200' height='200' fill='%23394d20'/><circle cx='40' cy='60' r='15' fill='%23253318'/><circle cx='150' cy='80' r='20' fill='%23253318'/><circle cx='90' cy='130' r='18' fill='%23253318'/><path d='M0 100 Q60 80 120 110 T200 100' stroke='%237a5a3a' stroke-width='3' fill='none'/></svg>");
  background-size: cover; background-position: center;
}
.kbrt-lobby .cta-card.create {
  background:
    linear-gradient(180deg, var(--bg-panel-raised), var(--bg-panel)),
    radial-gradient(ellipse at 30% 30%, rgba(157,42,35,.1), transparent 60%);
}

/* Section heads */
.kbrt-lobby .section-head { display:flex; align-items:center; gap:12px; margin:28px 0 14px; }
.kbrt-lobby .section-head h2 {
  font-family: var(--font-display); font-size:14px; letter-spacing:4px; color: var(--accent);
  text-transform: uppercase; font-weight:600; margin:0; display:flex; align-items:center; gap:10px;
}
.kbrt-lobby .section-head .rule { flex:1; height:1px; background: linear-gradient(90deg, var(--accent), transparent); opacity:.35; }
.kbrt-lobby .section-head .filters { display:flex; gap:4px; }
.kbrt-lobby .section-head .filter {
  padding:5px 12px; background:transparent; border:1px solid var(--border-line);
  color: var(--text-muted); font-family: var(--font-display); font-size:9px; letter-spacing:2px;
  cursor:pointer; border-radius:2px; text-transform: uppercase; transition: all .15s;
}
.kbrt-lobby .section-head .filter.active { border-color: var(--accent); color: var(--accent); background: rgba(224,180,79,.08); }
.kbrt-lobby .section-head .filter:hover { color: var(--accent); border-color: var(--accent); }

/* Games grid */
.kbrt-lobby .games-grid {
  display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:14px;
}
.kbrt-lobby .game-tile {
  position:relative; padding:0; border-radius:5px; overflow:hidden;
  background: var(--bg-panel-raised); border:1px solid var(--border-line);
  transition: all .15s; cursor:pointer;
}
.kbrt-lobby .game-tile:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 24px rgba(0,0,0,.4); }
.kbrt-lobby .game-tile .banner {
  height:88px; position:relative; overflow:hidden;
  background-size: cover; background-position: center;
}
.kbrt-lobby .game-tile .banner::after {
  content:''; position:absolute; inset:0;
  background: linear-gradient(180deg, transparent 30%, rgba(20,14,7,.95));
}
.kbrt-lobby .game-tile .role-pill {
  position:absolute; top:8px; left:8px; z-index:2; display:inline-flex; align-items:center; gap:4px;
  padding:3px 8px; border-radius:2px;
  font-family: var(--font-display); font-size:9px; letter-spacing:2px; font-weight:600; text-transform:uppercase;
}
.kbrt-lobby .role-pill.dm { background: rgba(20,14,7,.85); border:1px solid var(--accent); color: var(--accent); }
.kbrt-lobby .role-pill.dm::before { content:''; width:5px; height:5px; border-radius:50%; background: var(--accent); box-shadow: 0 0 4px var(--accent); }
.kbrt-lobby .role-pill.player { background: rgba(20,14,7,.85); border:1px solid var(--rune-blue); color: var(--rune-blue); }
.kbrt-lobby .role-pill.player::before { content:''; width:5px; height:5px; border-radius:50%; background: var(--rune-blue); box-shadow: 0 0 4px var(--rune-blue); }
.kbrt-lobby .game-tile .live-dot {
  position:absolute; top:8px; right:8px; z-index:2; display:inline-flex; align-items:center; gap:4px;
  padding:3px 8px; background: rgba(20,14,7,.85); border:1px solid var(--blood-400); border-radius:2px;
  font-family: var(--font-display); font-size:9px; letter-spacing:2px; color: var(--blood-400); font-weight:600;
  text-transform:uppercase;
}
.kbrt-lobby .game-tile .live-dot::before {
  content:''; width:6px; height:6px; border-radius:50%; background: var(--blood-400);
  box-shadow: 0 0 6px var(--blood-400); animation: kbrtPulse 1.4s infinite;
}
@keyframes kbrtPulse { 50% { opacity:.4; } }
.kbrt-lobby .game-tile .body { padding:14px 16px; }
.kbrt-lobby .game-tile .name {
  font-family: var(--font-display); font-size:15px; font-weight:600; color: var(--text-primary);
  letter-spacing:1.2px; margin:0 0 6px;
}
.kbrt-lobby .game-tile .meta {
  display:flex; align-items:center; gap:14px; flex-wrap: wrap;
  font-family: var(--font-ui); font-size:11px; color: var(--text-muted); letter-spacing:.3px;
}
.kbrt-lobby .game-tile .meta .item { display:inline-flex; align-items:center; gap:5px; }
.kbrt-lobby .game-tile .meta .item.online-count { color: var(--success); }
.kbrt-lobby .game-tile .meta .code {
  color: var(--accent); font-family: var(--font-ui); font-weight:600; letter-spacing:1.5px;
}
.kbrt-lobby .game-tile .actions {
  display:flex; gap:6px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border-line);
}

/* Buttons */
.kbrt-lobby .btn {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding:8px 14px; border-radius:2px; cursor:pointer;
  font-family: var(--font-display); font-size:10px; letter-spacing:2px;
  text-transform: uppercase; font-weight:600; border:1px solid transparent;
  transition: all .15s;
  background: transparent; color: inherit;
}
.kbrt-lobby .btn.primary {
  background: linear-gradient(180deg, var(--gilt-400), var(--gilt-600));
  color: var(--ink-900); border-color: var(--gilt-700);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.3);
}
.kbrt-lobby .btn.primary:hover { background: linear-gradient(180deg, var(--gilt-300), var(--gilt-500)); transform: translateY(-1px); }
.kbrt-lobby .btn.primary:disabled, .kbrt-lobby .btn.primary[disabled] { opacity:.45; cursor: not-allowed; transform:none; }
.kbrt-lobby .btn.ghost { background:transparent; border-color: var(--border-line); color: var(--text-secondary); }
.kbrt-lobby .btn.ghost:hover { border-color: var(--accent); color: var(--accent); background: rgba(224,180,79,.05); }
.kbrt-lobby .btn.ghost.on { background: rgba(224,180,79,.08); border-color: var(--accent); color: var(--accent); }
.kbrt-lobby .btn.danger-ghost { background:transparent; border-color: rgba(201,66,58,.4); color: var(--blood-400); }
.kbrt-lobby .btn.danger-ghost:hover { background: var(--blood-500); color:#fff; border-color: var(--blood-500); }
.kbrt-lobby .btn.full { flex:1; }
.kbrt-lobby .btn.lg { padding:12px 18px; font-size:12px; letter-spacing:2.5px; }
.kbrt-lobby .qa-btn { justify-content: flex-start; padding:10px 12px; }

/* ===== RIGHT RAIL ===== */
.kbrt-lobby .right-rail {
  background: linear-gradient(180deg, var(--bg-panel-deep), var(--bg-panel));
  border-left: 1px solid var(--border-line-strong);
  padding:24px 22px; overflow-y:auto; position:relative;
}
.kbrt-lobby .right-rail::-webkit-scrollbar { width:6px; }
.kbrt-lobby .right-rail::-webkit-scrollbar-thumb { background: var(--border-line); border-radius:3px; }
.kbrt-lobby .right-rail::before {
  content:''; position:absolute; top:0; left:0; bottom:0; width:1px;
  background: linear-gradient(180deg, transparent, var(--accent) 20%, var(--accent) 80%, transparent); opacity:.4;
}
.kbrt-lobby .rr-head {
  font-family: var(--font-display); font-size:11px; letter-spacing:3px; color: var(--accent);
  text-transform: uppercase; font-weight:600; margin: 0 0 12px;
  display:flex; align-items:center; gap:8px;
}
.kbrt-lobby .rr-rule { flex:1; height:1px; background: linear-gradient(90deg, var(--accent), transparent); opacity:.4; }
.kbrt-lobby .rr-count { font-family: var(--font-ui); font-size:9px; color: var(--success); letter-spacing:1.5px; }
.kbrt-lobby .rr-empty {
  font-family: var(--font-script); font-style: italic; color: var(--text-muted);
  font-size:12px; line-height:1.6; margin: 0 0 24px;
  border:1px dashed var(--border-line); border-radius:3px; padding:12px;
}

/* News (Tidings) */
.kbrt-lobby .news {
  background: linear-gradient(180deg, rgba(244,228,188,.04), rgba(244,228,188,.01));
  border:1px solid var(--border-line); border-radius:4px; padding:14px;
  margin-bottom:20px;
}
.kbrt-lobby .news .head {
  font-family: var(--font-display); font-size:10px; letter-spacing:2.5px; color: var(--accent);
  text-transform: uppercase; font-weight:600; margin:0 0 10px;
  display:flex; align-items:center; gap:8px;
}
.kbrt-lobby .news .item {
  font-family: var(--font-body); font-size:12px; color: var(--text-secondary);
  line-height:1.5; padding:6px 0; border-top:1px dashed var(--border-line);
}
.kbrt-lobby .news .item:first-of-type { border-top:none; padding-top:0; }
.kbrt-lobby .news .item .when {
  font-family: var(--font-display); font-size:8px; color: var(--text-muted);
  letter-spacing:1.5px; display:block; margin-bottom:2px; text-transform: uppercase;
}
.kbrt-lobby .news .item .text em { color: var(--accent); font-style: normal; font-weight:600; }

/* Empty / quill */
.kbrt-lobby .empty-prose {
  font-family: var(--font-script); font-style:italic; color: var(--text-muted);
  font-size:14px; padding:18px 0; text-align:center; margin:0;
}
.kbrt-lobby .quill {
  font-family: var(--font-script); font-style: italic;
  color: var(--text-muted); font-size:12px; text-align:center;
}
.kbrt-lobby .chron-empty {
  display:flex; align-items:center; gap:14px;
  padding:18px 22px;
  background: var(--bg-panel-raised); border:1px dashed var(--border-line); border-radius:4px;
  color: var(--text-muted); font-family: var(--font-script); font-style:italic; font-size:13px;
}
.kbrt-lobby .chron-empty svg { color: var(--accent); flex-shrink:0; }

/* ===== MODAL ===== */
.kbrt-lobby .scrim {
  position:fixed; inset:0; background: rgba(4,2,1,.85);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  z-index:50; display:flex; align-items:center; justify-content:center;
  animation: kbrtFadeIn .2s ease;
}
@keyframes kbrtFadeIn { from { opacity:0; } to { opacity:1; } }
.kbrt-lobby .modal {
  width:560px; max-width:92vw;
  background: var(--bg-panel); border:1px solid var(--border-line-strong);
  border-radius:5px; box-shadow: 0 30px 80px rgba(0,0,0,.8); position:relative;
  animation: kbrtModalIn .25s ease-out;
  color: var(--text-primary);
}
@keyframes kbrtModalIn { from { opacity:0; transform: scale(.96) translateY(10px); } to { opacity:1; transform:none; } }
.kbrt-lobby .modal::before {
  content:''; position:absolute; top:0; left:0; right:0; height:2px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
}
.kbrt-lobby .modal-head {
  display:flex; align-items:center; padding:18px 22px; border-bottom:1px solid var(--border-line); gap:12px;
}
.kbrt-lobby .modal-head h3 {
  font-family: var(--font-display); font-size:18px; letter-spacing:3px; color: var(--accent);
  text-transform: uppercase; font-weight:700; flex:1; margin:0;
}
.kbrt-lobby .modal-body { padding:20px 22px; }
.kbrt-lobby .modal-foot {
  padding:14px 22px; border-top:1px solid var(--border-line); display:flex; justify-content:flex-end; gap:8px;
}
.kbrt-lobby .modal-tag {
  font-family: var(--font-script); font-style:italic; color: var(--text-secondary);
  font-size:14px; margin:0 0 16px; text-align:center;
}
.kbrt-lobby .field { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
.kbrt-lobby .field label, .kbrt-lobby .join-label {
  font-family: var(--font-display); font-size:9px; letter-spacing:2px;
  color: var(--text-muted); text-transform: uppercase;
}
.kbrt-lobby .input {
  width:100%; padding:11px 14px; background: var(--ink-900); border:1px solid var(--border-line);
  border-radius:3px; color: var(--text-primary); font-family: var(--font-body); font-size:14px;
  outline:none; transition: border-color .15s;
}
.kbrt-lobby .input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(224,180,79,.1); }
.kbrt-lobby .input::placeholder { color: var(--text-muted); font-style:italic; }
.kbrt-lobby .input.code {
  font-family: var(--font-ui); letter-spacing:4px; text-transform: uppercase; text-align:center; font-weight:600;
}
.kbrt-lobby .priv-row { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
.kbrt-lobby .map-picks { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; }
.kbrt-lobby .map-pick {
  height:60px; display:grid; place-items:center;
  border:2px solid transparent; border-radius:3px;
  font-family: var(--font-display); font-size:9px; letter-spacing:1.5px;
  color: var(--text-muted); cursor:pointer;
}
.kbrt-lobby .map-pick.forest { background: linear-gradient(135deg, #3a4a25, #1a2410); }
.kbrt-lobby .map-pick.dungeon { background: linear-gradient(135deg, #403530, #201810); }
.kbrt-lobby .map-pick.tavern { background: linear-gradient(135deg, #4a3420, #2a1e10); }
.kbrt-lobby .map-pick.on { border-color: var(--accent); color: var(--accent); }
.kbrt-lobby .modal.banned { width:480px; border-color: rgba(201,66,58,.5); }
.kbrt-lobby .bm-meta { font-family: var(--font-body); color: var(--text-muted); font-size:13px; text-align:center; margin:0 0 8px; }
.kbrt-lobby .bm-reason { font-family: var(--font-script); font-style:italic; color: var(--text-primary); font-size:14px; text-align:center; margin:8px 0 0; }
`;
