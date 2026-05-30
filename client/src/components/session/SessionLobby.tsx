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
 *   - Tidings    = LIVE — pulled from /api/tidings; admin authoring at
 *                  /admin/tidings; bell badge surfaces unread count.
 *
 * Styling lives in a single `<style>` block scoped under `.kbrt-lobby`
 * so the design system doesn't leak into the in-session AppShell. The
 * CSS is mostly verbatim from the prototype; class names are namespaced
 * to avoid collisions with existing inline-styled components.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
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
  UserPlus,
  Check,
  UserX,
  Search,
  MessageCircle,
  UserCog,
  ExternalLink,
  Megaphone,
  RefreshCw,
} from 'lucide-react';
import { createSession, joinSession } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { FeedbackModal } from '../feedback/FeedbackModal';
import { PREBUILT_MAPS } from '../../data/prebuiltMaps';

/**
 * Prebuilt maps don't store URLs in the DB (server schema comment
 * says "client-derived"). The image lives at a GCS path keyed by the
 * prebuilt's slug — but the slug isn't on the row, only the name.
 * This lookup builds a name → thumbnailFile URL map once at module
 * load so the lobby can resolve the image without a schema change.
 */
const PREBUILT_MAP_THUMB_BY_NAME: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const m of PREBUILT_MAPS) out[m.name] = m.thumbnailFile;
  return out;
})();
// Profile modal is large (avatar uploader, password change). Lazy-load
// so it only joins the bundle when a user opens the Account quick action.
const ProfileModal = lazy(() =>
  import('../auth/ProfileModal').then((m) => ({ default: m.ProfileModal })),
);
// CharacterSheetFull is a sizable component (stat blocks, spell book,
// inventory, notes, BG tab). Lazy-loaded so the lobby's initial bundle
// doesn't pay for it until a user actually clicks a hero.
const CharacterSheetFull = lazy(() =>
  import('../character/CharacterSheetFull').then((m) => ({ default: m.CharacterSheetFull })),
);

/**
 * Public Discord invite URL for the project's community server. The
 * Quick Actions Discord button only renders when this is non-empty.
 * Hard-coded rather than env-wired because it's public info and
 * rarely changes — flip the constant when the user creates a vanity
 * invite for the server. Empty string for now so the button stays
 * hidden until there's a real link.
 */
const DISCORD_INVITE_URL = '';

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
  /** Thumbnail URL of the campaign's currently-loaded map. The server
   *  resolves this via JOIN against the maps table on `current_map_id`
   *  and prefers `thumbnail_url` (480px) over `image_url` (full-res)
   *  for the small tile. Null when the campaign has never loaded a
   *  map — we fall back to a deterministic biome-tinted gradient. */
  bannerUrl?: string | null;
  /** Map name — surfaced as the tile's title attribute so hovering
   *  reveals "Briar Hollow" without cluttering the tile body. */
  currentMapName?: string | null;
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

/** Lobby-side shape for a tiding row from /api/tidings. Mirrors the
 *  server's wire shape but only the subset the rail actually renders. */
interface Tiding {
  id: string;
  kind: 'patch' | 'content' | 'announcement';
  title: string;
  body: string;
  versionTag: string | null;
  publishedAt: string;
  pinned: boolean;
}

/** Lobby-side shape for a friend (companions) row. Matches the server
 *  response from GET /api/friends. Each row carries the friendship's
 *  metadata + the OTHER user's profile + their derived presence. */
interface Friend {
  friendshipId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'pending' | 'accepted' | 'blocked';
  requestedBy: string;
  requestedByMe: boolean;
  blockedByMe: boolean;
  presence: {
    status: 'in-game' | 'offline';
    sessionId: string | null;
    sessionName: string | null;
    roomCode: string | null;
  };
  createdAt: string;
}

interface PendingFriend extends Friend {
  status: 'pending';
}

interface UserSearchHit {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  friendshipStatus: 'pending' | 'accepted' | 'blocked' | null;
}

/** Chronicle entry shape from /api/chronicle/mine. The server already
 *  picks `effectiveRecap*` (DM edit if present, else auto-generated),
 *  so the lobby just renders that. keyEntities are nouns we wrap in
 *  <em> tags inside the recap text. */
interface ChronicleEntry {
  id: string;
  campaignId: string;
  campaignName: string | null;
  sequenceNumber: number;
  effectiveRecapShort: string;
  effectiveRecapFull: string;
  keyEntities: string[];
  publishedAt: string | null;
  durationMs: number | null;
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

/**
 * Resolve the best banner image URL for a campaign tile. Order:
 *   1. Server-provided bannerUrl — populated when the campaign has a
 *      custom-uploaded current map (thumbnail_url, falling back to
 *      image_url).
 *   2. Prebuilt-map GCS thumbnail — derived from currentMapName when
 *      the row has no image_url (prebuilt maps deliberately store null
 *      and the client derives the URL).
 *   3. null — caller falls back to the deterministic biome gradient.
 */
function resolveBannerUrl(g: { bannerUrl?: string | null; currentMapName?: string | null }): string | null {
  if (g.bannerUrl) return g.bannerUrl;
  if (g.currentMapName && PREBUILT_MAP_THUMB_BY_NAME[g.currentMapName]) {
    return PREBUILT_MAP_THUMB_BY_NAME[g.currentMapName];
  }
  return null;
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

/**
 * Wrap each occurrence of a `keyEntities` term in <em>, leaving the
 * rest of the text untouched. Used to render Chronicle recaps with
 * the design's italicized-noun look without baking the emphasis
 * into the LLM output (separates content from presentation).
 *
 * Matching is case-sensitive whole-word — entities like "Liraya"
 * shouldn't accidentally match "literally". Order entities longest-
 * first so "Briar Hollow" is wrapped before "Briar" alone.
 */
function renderRecapWithEntities(text: string, entities: string[], key: string | number): React.ReactNode {
  if (!entities || entities.length === 0) return text;
  const sorted = [...entities].sort((a, b) => b.length - a.length);
  // Build a single regex that matches any entity as a whole word.
  const escaped = sorted.map((e) => e.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
  const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(<em key={`${key}-em-${i++}`}>{match[1]}</em>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/**
 * Render a tiding body with a single emphasis style: `*word*` becomes
 * `<em>word</em>`. The design's right-rail leans hard on this lead-noun
 * emphasis ("*Patch 0.7* — …"), so we let admins author it inline
 * without dragging in a markdown lib. Anything that isn't `*foo*` is
 * rendered as-is and HTML-escaped by React's text node handling.
 */
function renderTidingText(body: string, key: string | number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\*([^*\n]+)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(body)) !== null) {
    if (match.index > lastIndex) parts.push(body.slice(lastIndex, match.index));
    parts.push(<em key={`${key}-em-${i++}`}>{match[1]}</em>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}

/** Format a duration in ms as "2h 18m" or "47m". Used by the
 *  Chronicle row to surface session length next to the meta line. */
function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
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
  const [syncingCharacterId, setSyncingCharacterId] = useState<string | null>(null);
  const [heroSyncMessage, setHeroSyncMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // Filter tab state for My Campaigns: All / DMing / Playing
  const [gameFilter, setGameFilter] = useState<'all' | 'dm' | 'player'>('all');

  // Tidings (patch notes / announcements). The rail renders the most
  // recent entries from /api/tidings, and the bell badge surfaces the
  // unread count. mark-read fires once on first view of the lobby.
  const [tidings, setTidings] = useState<Tiding[]>([]);
  const [unreadTidings, setUnreadTidings] = useState(0);

  // Companions (friends). Three slots:
  //   - friends: accepted rows, hydrated with presence
  //   - incoming: pending requests TO me
  //   - outgoing: pending requests FROM me (shown in the Add modal)
  // Re-fetched on every mount + after any mutation so the rail
  // reflects accept/decline/unfriend immediately.
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<PendingFriend[]>([]);
  const [outgoing, setOutgoing] = useState<PendingFriend[]>([]);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Character sheet from lobby: holds the FULL character object (not
  // the lobby-side MyCharacter slice — the sheet needs every field).
  // null = no sheet open. Fetched fresh on open from /api/characters/:id
  // so edits made in a previous session are reflected.
  const [openCharacter, setOpenCharacter] = useState<unknown | null>(null);
  const [openCharacterLoading, setOpenCharacterLoading] = useState(false);

  const openHeroSheet = async (charId: string) => {
    setOpenCharacterLoading(true);
    try {
      const res = await fetch(`/api/characters/${charId}`, { credentials: 'include' });
      if (res.ok) {
        const character = await res.json();
        setOpenCharacter(character);
      } else {
        setError('Could not load that hero — try again in a moment.');
      }
    } catch {
      setError('Network error loading hero.');
    } finally {
      setOpenCharacterLoading(false);
    }
  };

  // Chronicle entries from /api/chronicle/mine — the LLM-generated
  // session recaps published across all of the user's campaigns.
  // Refetched on mount; stays empty until the user has played a
  // session that ended in a DM-published recap.
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);

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

  const syncHeroFromDDB = async (character: MyCharacter) => {
    if (!character.dndbeyondId || syncingCharacterId) return;
    setSyncingCharacterId(character.id);
    setHeroSyncMessage(null);
    setError(null);
    try {
      const resp = await fetch(`/api/dndbeyond/sync/${character.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(body.error || `Sync failed (${resp.status})`);
      }
      await fetchMyCharacters();
      if ((openCharacter as { id?: string } | null)?.id === character.id) {
        setOpenCharacter(body);
      }
      setHeroSyncMessage({
        text: `${body.name ?? character.name} synced from D&D Beyond${body.level ? ` — now Level ${body.level}` : ''}.`,
        isError: false,
      });
      setTimeout(() => {
        setHeroSyncMessage((current) => (
          current?.isError === false ? null : current
        ));
      }, 5000);
    } catch (err) {
      setHeroSyncMessage({
        text: err instanceof Error ? err.message : 'Sync from D&D Beyond failed.',
        isError: true,
      });
    } finally {
      setSyncingCharacterId(null);
    }
  };

  // Fetch tidings whenever auth is available. The right-rail renders
  // up to ~5 entries; the bell shows the unread badge from the
  // server-side count (rows published after the user's lastReadAt).
  const fetchTidings = async () => {
    try {
      const res = await fetch('/api/tidings', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setTidings(Array.isArray(data.tidings) ? data.tidings : []);
      setUnreadTidings(typeof data.unreadCount === 'number' ? data.unreadCount : 0);
    } catch {
      /* silently fail — the rail just stays empty */
    }
  };

  /** Bump the user's lastReadTidingsAt so the bell badge clears.
   *  Idempotent on the server; safe to call repeatedly. */
  const markTidingsRead = async () => {
    if (unreadTidings === 0) return;
    setUnreadTidings(0);
    try {
      await fetch('/api/tidings/mark-read', { method: 'POST', credentials: 'include' });
    } catch {
      /* best-effort; if the request fails the next visit will retry */
    }
  };

  // ── Companions data ──────────────────────────────────────────
  const fetchFriends = async () => {
    try {
      const [fRes, pRes] = await Promise.all([
        fetch('/api/friends', { credentials: 'include' }),
        fetch('/api/friends/pending', { credentials: 'include' }),
      ]);
      if (fRes.ok) {
        const data = await fRes.json();
        setFriends(Array.isArray(data.friends) ? data.friends : []);
      }
      if (pRes.ok) {
        const data = await pRes.json();
        setIncoming(Array.isArray(data.incoming) ? data.incoming : []);
        setOutgoing(Array.isArray(data.outgoing) ? data.outgoing : []);
      }
    } catch {
      /* best-effort — empty rail is the worst case */
    }
  };

  /** POST /api/friends/:id/<verb> — used by accept/decline/cancel/block.
   *  On success, refetch so presence + counts stay aligned with the
   *  server (the request can flip to accepted, which moves the row
   *  from `incoming` to `friends`). */
  const friendAction = async (
    friendshipId: string,
    verb: 'accept' | 'decline' | 'cancel' | 'block',
  ) => {
    try {
      const res = await fetch(`/api/friends/${friendshipId}/${verb}`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Couldn't ${verb} that companion (${res.status})`);
        return;
      }
      await fetchFriends();
    } catch {
      setError('Network error — try again in a moment.');
    }
  };

  const unfriend = async (friendshipId: string) => {
    try {
      const res = await fetch(`/api/friends/${friendshipId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) return;
      await fetchFriends();
    } catch {
      /* swallow */
    }
  };

  // Pull recent published chronicle entries across every campaign the
  // user belongs to. The endpoint already filters to status='published'
  // and orders by published_at DESC.
  const fetchChronicle = async () => {
    try {
      const res = await fetch('/api/chronicle/mine', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setChronicle(Array.isArray(data.entries) ? data.entries : []);
      }
    } catch {
      /* best-effort — empty rail is the worst case */
    }
  };

  useEffect(() => {
    if (authUser) {
      fetchMyGames();
      fetchMyCharacters();
      fetchTidings();
      fetchFriends();
      fetchChronicle();
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
        startMap,
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
        <button
          className="icon-btn bell-btn"
          title={unreadTidings > 0 ? `${unreadTidings} new ${unreadTidings === 1 ? 'tiding' : 'tidings'}` : 'Tidings'}
          onClick={() => {
            // Scroll the right-rail Tidings into view + clear the badge.
            // The list itself is always rendered in the rail, so this
            // is just a polite "look here" gesture.
            markTidingsRead();
            const rail = document.querySelector('.kbrt-lobby .right-rail');
            if (rail) rail.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          <Bell size={16} />
          {unreadTidings > 0 && (
            <span className="bell-badge" aria-label={`${unreadTidings} unread`}>
              {unreadTidings > 9 ? '9+' : unreadTidings}
            </span>
          )}
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
        {authUser?.isAdmin && (
          <button
            className="icon-btn"
            title="Tidings (patch notes)"
            onClick={() => navigate('/admin/tidings')}
          >
            <Megaphone size={16} />
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
          {heroSyncMessage && (
            <div className={`rail-notice${heroSyncMessage.isError ? ' error' : ''}`}>
              {heroSyncMessage.text}
            </div>
          )}
          {myCharsLoading && myCharacters.length === 0 ? (
            <p className="rail-empty">Loading thy heroes…</p>
          ) : myCharacters.length === 0 ? (
            <p className="rail-empty">No heroes yet. Forge one to begin.</p>
          ) : (
            myCharacters.map((c) => (
              <div key={c.id} className="char-card-row">
                <button
                  className={`char-card${c.activeCampaignId ? ' active' : ''}`}
                  disabled={openCharacterLoading}
                  onClick={() => openHeroSheet(c.id)}
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
                {c.dndbeyondId && (
                  <button
                    type="button"
                    className="char-sync-btn"
                    disabled={syncingCharacterId !== null}
                    onClick={() => syncHeroFromDDB(c)}
                    title={`Sync ${c.name} from D&D Beyond`}
                    aria-label={`Sync ${c.name} from D&D Beyond`}
                  >
                    <RefreshCw
                      size={13}
                      style={syncingCharacterId === c.id ? { animation: 'spin 1s linear infinite' } : undefined}
                    />
                    <span>{syncingCharacterId === c.id ? 'Syncing' : 'Sync'}</span>
                  </button>
                )}
              </div>
            ))
          )}
          {/* Until the in-app character creator ships, send the user
              to D&D Beyond's builder. The existing /api/dndbeyond
              import path lets them pull the finished character back
              into Atlas Bound when they're done. Opens in a new tab
              so the lobby state isn't lost. */}
          <a
            className="add-char"
            href="https://www.dndbeyond.com/characters/builder"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the D&D Beyond character builder in a new tab; import the finished sheet via the Heroes panel inside a session."
          >
            + Forge New Hero on D&amp;D Beyond
          </a>
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
              <div
                className="map-thumb"
                /* When the resumed campaign has a real map loaded,
                   render its thumbnail as the card's right-side art.
                   Otherwise the CSS fallback (forest gradient) shows
                   through. The .map-thumb element handles its own
                   gradient mask so the title text stays legible.
                   Same prebuilt-vs-custom resolution as the tiles. */
                style={(() => {
                  const url = resumeGame ? resolveBannerUrl(resumeGame) : null;
                  return url
                    ? { backgroundImage: `linear-gradient(90deg, var(--bg-panel) 0%, transparent 30%), url("${url}")` }
                    : undefined;
                })()}
              />
              <p className="label">
                {resumeGame ? 'Last session · ready when you are' : 'No active campaign yet'}
              </p>
              <h3>{resumeGame?.name ?? 'Resume Adventure'}</h3>
              <p className="desc">
                {resumeGame
                  ? `Pick up where you left off${resumeGame.currentMapName ? ` on ${resumeGame.currentMapName}` : ''}. Your party awaits.`
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
                  {(() => {
                    const url = resolveBannerUrl(g);
                    return (
                      <div
                        className="banner"
                        /* Server bannerUrl is preferred (custom upload).
                           Prebuilt maps fall through to a name → GCS
                           thumbnail lookup. Otherwise we render the
                           biome-tinted gradient. URL is quoted so map
                           filenames with parens/spaces don't break CSS. */
                        style={
                          url
                            ? { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
                            : { background: bannerGradient(g.id) }
                        }
                        title={g.currentMapName ?? undefined}
                      >
                        <span className={`role-pill ${g.role}`}>{g.role === 'dm' ? 'DM' : 'PLAYER'}</span>
                        {g.isLive && <span className="live-dot">Live</span>}
                      </div>
                    );
                  })()}
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

          {/* CHRONICLE — narrative timeline of published session recaps */}
          <div className="section-head">
            <h2>
              <ScrollText size={14} />
              Chronicle
            </h2>
            <div className="rule" />
          </div>
          {chronicle.length === 0 ? (
            <div className="chron-empty">
              <ScrollText size={20} />
              <p>
                Your chronicle is empty. When a DM ends a session and forges a recap, the tale will appear here.
              </p>
            </div>
          ) : (
            <div className="chronicle">
              {chronicle.slice(0, 6).map((c) => (
                <div className="chron-row" key={c.id}>
                  <div className="chron-time">
                    <div className="chron-day">{formatRelative(c.publishedAt) || '—'}</div>
                    <div className="chron-clock">
                      {c.publishedAt ? new Date(c.publishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </div>
                  </div>
                  <div className="chron-dot" />
                  <div className="chron-card">
                    <div className="chron-meta">
                      <span className="chron-game">{c.campaignName ?? 'Campaign'}</span>
                      <span className="chron-sep">·</span>
                      <span>
                        Session {c.sequenceNumber}
                        {c.durationMs ? ` · ${formatDuration(c.durationMs)}` : ''}
                      </span>
                    </div>
                    <p className="chron-text">
                      {renderRecapWithEntities(c.effectiveRecapShort, c.keyEntities, c.id)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="quill" style={{ margin: '36px 0 24px' }}>
            KBRT.AI — Your adventure awaits.
          </p>
        </main>

        {/* ===== RIGHT RAIL ===== */}
        <aside className="right-rail">
          <h3 className="rr-head">
            Tidings
            {unreadTidings > 0 && (
              <span className="rr-count" style={{ color: 'var(--accent)' }}>
                {unreadTidings} NEW
              </span>
            )}
            <span className="rr-rule" />
            {authUser?.isAdmin && (
              <button
                className="rr-action"
                title="Author tidings"
                onClick={() => navigate('/admin/tidings')}
              >
                + Author
              </button>
            )}
          </h3>
          <div className="news">
            <div className="head">
              <ScrollText size={12} />
              From the Loremasters
            </div>
            {tidings.length === 0 ? (
              <div className="news-empty">
                The Loremasters have been quiet of late. Patch notes will appear here when there is news to share.
              </div>
            ) : (
              tidings.slice(0, 5).map((t) => (
                <div className="item" key={t.id}>
                  <span className="when">
                    {t.versionTag ? `${t.kind === 'patch' ? 'Patch ' : ''}${t.versionTag} · ` : ''}
                    {formatRelative(t.publishedAt) || 'just now'}
                  </span>
                  <span className="text">
                    <em>{t.title}</em>
                    {t.body ? ' — ' : ''}
                    {renderTidingText(t.body, t.id)}
                  </span>
                </div>
              ))
            )}
          </div>

          <h3 className="rr-head">
            Companions
            {friends.length > 0 && (
              <span className="rr-count">
                {friends.filter((f) => f.presence.status !== 'offline').length} ONLINE
              </span>
            )}
            <span className="rr-rule" />
            <button
              className="rr-action"
              title="Add a companion by display name or email"
              onClick={() => setAddFriendOpen(true)}
            >
              <UserPlus size={11} style={{ marginRight: 2 }} />
              Add
            </button>
          </h3>

          {/* Incoming requests pile up at the top so the user sees
              them first. Outgoing pending requests live in the Add
              modal where they're more contextually useful. */}
          {incoming.length > 0 && (
            <div className="friend-requests">
              {incoming.map((req) => (
                <div className="friend-row request" key={req.friendshipId}>
                  <div className="av" style={{ background: heroTint(req.userId) }}>
                    {req.avatarUrl ? <img src={req.avatarUrl} alt="" /> : <span>{initial(req.displayName)}</span>}
                  </div>
                  <div className="info">
                    <p className="n">{req.displayName}</p>
                    <p className="s">wants to be your companion</p>
                  </div>
                  <button
                    className="friend-btn accept"
                    title="Accept"
                    onClick={() => friendAction(req.friendshipId, 'accept')}
                  >
                    <Check size={12} />
                  </button>
                  <button
                    className="friend-btn decline"
                    title="Decline"
                    onClick={() => friendAction(req.friendshipId, 'decline')}
                  >
                    <UserX size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {friends.length === 0 ? (
            <p className="rr-empty">
              No companions yet. Click <strong>Add</strong> above to send a request by display name or email.
            </p>
          ) : (
            friends.map((f) => (
              <div className="friend-row" key={f.friendshipId}>
                <div className="av" style={{ background: heroTint(f.userId) }}>
                  {f.avatarUrl ? <img src={f.avatarUrl} alt="" /> : <span>{initial(f.displayName)}</span>}
                  <span className={`pres ${f.presence.status === 'in-game' ? 'in-game' : 'offline'}`} />
                </div>
                <div className="info">
                  <p className="n">{f.displayName}</p>
                  <p className="s">
                    {f.presence.status === 'in-game'
                      ? f.presence.sessionName
                        ? `In ${f.presence.sessionName}`
                        : 'In a campaign'
                      : 'Offline'}
                  </p>
                </div>
                {f.presence.status === 'in-game' && f.presence.roomCode && (
                  <button
                    className="friend-btn invite"
                    title={`Join ${f.presence.sessionName ?? 'their campaign'}`}
                    onClick={() => f.presence.roomCode && enterGame(f.presence.roomCode)}
                  >
                    <ChevronRight size={12} />
                  </button>
                )}
                <button
                  className="friend-btn unfriend"
                  title="Unfriend"
                  onClick={() => unfriend(f.friendshipId)}
                >
                  <UserX size={12} />
                </button>
              </div>
            ))
          )}

          <h3 className="rr-head" style={{ marginTop: 24 }}>
            Quick Actions
            <span className="rr-rule" />
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Wired actions only — the Compendium / Map Library / Settings
                stubs that used to live here didn't navigate anywhere
                meaningful from the lobby (those views currently live
                inside an active session). They've been replaced with
                actions that actually do something at lobby-level. */}
            <button className="btn ghost qa-btn" onClick={() => setProfileOpen(true)}>
              <UserCog size={13} />
              Account &amp; Profile
            </button>
            <button
              className="btn ghost qa-btn"
              onClick={() => {
                markTidingsRead();
                const rail = document.querySelector('.kbrt-lobby .right-rail');
                if (rail) rail.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              <Megaphone size={13} />
              What&rsquo;s New
            </button>
            <button className="btn ghost qa-btn" onClick={() => setFeedbackOpen(true)}>
              <Lightbulb size={13} />
              Send Feedback
            </button>
            {DISCORD_INVITE_URL && (
              <a
                className="btn ghost qa-btn"
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle size={13} />
                Discord Server
                <ExternalLink size={10} style={{ opacity: 0.6, marginLeft: 'auto' }} />
              </a>
            )}
            {authUser?.isAdmin && (
              <button className="btn ghost qa-btn" onClick={() => navigate('/admin/feedback')}>
                <Shield size={13} />
                Admin Panel
              </button>
            )}
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

      {/* Add Friend modal — name/email search → send request */}
      {addFriendOpen && (
        <AddFriendModal
          onClose={() => setAddFriendOpen(false)}
          outgoing={outgoing}
          onChange={fetchFriends}
        />
      )}

      {/* Account / Profile modal — lazy-loaded on first open */}
      <Suspense fallback={null}>
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      </Suspense>

      {/* Character sheet from the Heroes rail. Reuses the in-session
          CharacterSheetFull component — most of it works fine outside
          a session (display, edits via REST, notes). Things that emit
          socket events (broadcast damage, party-wide messages) silently
          no-op without a session, which is correct: there's no party
          to broadcast to from the lobby. Edits to HP / spell prep /
          inventory still persist via REST and show up next time the
          DM loads the campaign. */}
      {openCharacter !== null && (
        <div style={lobbySheetOverlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenCharacter(null); }}>
          <div style={lobbySheetContainerStyle}>
            <button
              type="button"
              onClick={() => setOpenCharacter(null)}
              aria-label="Close"
              style={lobbySheetCloseStyle}
            >
              <X size={16} />
            </button>
            <Suspense fallback={
              <div style={{ padding: 32, textAlign: 'center', color: '#a89271', fontStyle: 'italic' }}>
                Unfurling the sheet…
              </div>
            }>
              <CharacterSheetFull
                /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                character={openCharacter as any}
                onClose={() => setOpenCharacter(null)}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* Feedback (existing component) */}
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Add Friend modal — searches users, surfaces existing friendship
// state inline, sends a request, and shows the caller's outgoing
// pending list so they can cancel a sent request without leaving
// the modal. Search is debounced 200 ms.
// ────────────────────────────────────────────────────────────────
function AddFriendModal({
  onClose,
  outgoing,
  onChange,
}: {
  onClose: () => void;
  outgoing: PendingFriend[];
  onChange: () => Promise<void> | void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  // Debounce the search input. The endpoint requires q.length ≥ 2;
  // anything shorter clears results immediately to avoid showing
  // stale hits from a longer prior query.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/friends/search?q=${encodeURIComponent(trimmed)}`,
          { credentials: 'include' },
        );
        if (res.ok) {
          const data = await res.json();
          setResults(Array.isArray(data.users) ? data.users : []);
        }
      } catch {
        /* ignore */
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const sendRequest = async (target: { id?: string; raw?: string }) => {
    const key = target.id ?? target.raw ?? '';
    setSending(key);
    setError(null);
    try {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.id ? { targetUserId: target.id } : { target: target.raw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Couldn't send request (${res.status})`);
        return;
      }
      await onChange();
      // If we typed a raw target string and it succeeded, clear the
      // input so the user can type the next one without backspacing.
      if (target.raw) setQuery('');
    } finally {
      setSending(null);
    }
  };

  const cancelRequest = async (friendshipId: string) => {
    try {
      const res = await fetch(`/api/friends/${friendshipId}/cancel`, {
        method: 'POST', credentials: 'include',
      });
      if (res.ok) await onChange();
    } catch {
      /* swallow */
    }
  };

  return (
    <div className="scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 480 }}>
        <div className="modal-head">
          <UserPlus size={20} color="var(--accent)" />
          <h3>Add Companion</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-tag">Find a fellow traveler by display name or email.</p>

          <div className="field">
            <label>Search</label>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{
                position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-muted)', pointerEvents: 'none',
              }} />
              <input
                className="input"
                placeholder="Display name or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ paddingLeft: 34 }}
                autoFocus
              />
            </div>
            {searching && <div className="search-meta">Searching the realms…</div>}
            {!searching && query.trim().length >= 2 && results.length === 0 && (
              <div className="search-meta">
                No traveler found.{' '}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => sendRequest({ raw: query.trim() })}
                  disabled={sending !== null}
                >
                  Send to &ldquo;{query.trim()}&rdquo; anyway
                </button>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="search-results">
              {results.map((u) => (
                <div className="search-row" key={u.id}>
                  <div className="av small" style={{ background: heroTint(u.id) }}>
                    {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : <span>{initial(u.displayName)}</span>}
                  </div>
                  <div className="info">
                    <p className="n">{u.displayName}</p>
                    {u.friendshipStatus && (
                      <p className="s">
                        {u.friendshipStatus === 'accepted'
                          ? 'Already a companion'
                          : u.friendshipStatus === 'pending'
                          ? 'Request pending'
                          : 'Blocked'}
                      </p>
                    )}
                  </div>
                  <button
                    className="btn primary search-btn"
                    onClick={() => sendRequest({ id: u.id })}
                    disabled={u.friendshipStatus !== null || sending === u.id}
                  >
                    {sending === u.id ? '…' : u.friendshipStatus === 'pending' ? 'Pending' : u.friendshipStatus === 'accepted' ? 'Friends' : 'Send Request'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {outgoing.length > 0 && (
            <div className="outgoing-section">
              <div className="outgoing-head">Pending requests you sent</div>
              {outgoing.map((req) => (
                <div className="search-row" key={req.friendshipId}>
                  <div className="av small" style={{ background: heroTint(req.userId) }}>
                    {req.avatarUrl ? <img src={req.avatarUrl} alt="" /> : <span>{initial(req.displayName)}</span>}
                  </div>
                  <div className="info">
                    <p className="n">{req.displayName}</p>
                    <p className="s">awaiting their reply</p>
                  </div>
                  <button
                    className="btn ghost search-btn"
                    onClick={() => cancelRequest(req.friendshipId)}
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div style={{
              marginTop: 12,
              padding: 10,
              background: 'rgba(201,66,58,.18)',
              border: '1px solid var(--blood-400)',
              borderRadius: 3,
              color: 'var(--blood-400)',
              fontSize: 12,
            }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Inline styles for the lobby-side character sheet overlay. Lives
// outside .kbrt-lobby because CharacterSheetFull brings its own
// theme — we just want a plain dark scrim + roomy container so the
// existing in-session sheet styling renders identically here.
// ────────────────────────────────────────────────────────────────
const lobbySheetOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(4, 2, 1, .85)',
  backdropFilter: 'blur(4px)', zIndex: 1100,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24,
};
const lobbySheetContainerStyle: React.CSSProperties = {
  position: 'relative',
  width: '95%', maxWidth: 1100, maxHeight: '92vh',
  overflow: 'auto',
  background: '#140e07', border: '1px solid rgba(199,150,50,.55)',
  borderRadius: 6, boxShadow: '0 30px 80px rgba(0,0,0,.8)',
};
const lobbySheetCloseStyle: React.CSSProperties = {
  position: 'absolute', top: 12, right: 12, zIndex: 10,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 32, height: 32, borderRadius: '50%',
  background: '#1e1509', border: '1px solid rgba(199,150,50,.55)',
  color: '#a89271', cursor: 'pointer',
};

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
  position: relative;
}
.kbrt-lobby .icon-btn:hover { color: var(--accent); border-color: var(--border-line); background: var(--bg-panel); }

/* Bell badge — small gold pill in the top-right corner of the bell
   button when there are unread tidings. Pulse-free; the design is
   already busy and the gold is loud enough on its own. */
.kbrt-lobby .bell-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--ink-900);
  font-family: var(--font-ui);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.2px;
  line-height: 14px;
  text-align: center;
  box-shadow: 0 0 6px rgba(224, 180, 79, .6);
}

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

.kbrt-lobby .rail-notice {
  border:1px solid rgba(122,162,102,.35); background: rgba(122,162,102,.12);
  color: var(--success); border-radius:3px; padding:8px 9px; margin: -4px 0 10px;
  font-family: var(--font-body); font-size:11px; line-height:1.35;
}
.kbrt-lobby .rail-notice.error {
  border-color: rgba(201,66,58,.45); background: rgba(201,66,58,.13); color: var(--blood-400);
}
.kbrt-lobby .char-card-row {
  display:flex; align-items:stretch; gap:6px; margin-bottom:8px; width:100%;
}
.kbrt-lobby .char-card {
  display:flex; align-items:center; gap:12px; padding:10px;
  border:1px solid var(--border-line); background: var(--bg-panel-raised);
  border-radius:3px; cursor:pointer; transition: all .15s;
  margin-bottom:8px; position:relative; width:100%; text-align:left; color: inherit;
  font-family: inherit;
}
.kbrt-lobby .char-card-row .char-card { margin-bottom:0; min-width:0; flex:1; }
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
.kbrt-lobby .char-sync-btn {
  flex:0 0 58px; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:3px; border:1px solid var(--border-line); background: rgba(224,180,79,.04);
  color: var(--accent); border-radius:3px; cursor:pointer; transition: all .15s;
  font-family: var(--font-display); font-size:8px; letter-spacing:1.2px; text-transform: uppercase;
}
.kbrt-lobby .char-sync-btn:hover:not(:disabled) {
  border-color: var(--accent); background: rgba(224,180,79,.10);
}
.kbrt-lobby .char-sync-btn:disabled {
  opacity:.55; cursor:not-allowed;
}
@keyframes spin { to { transform: rotate(360deg); } }
.kbrt-lobby .rail .add-char {
  display: block; box-sizing: border-box; text-align: center; text-decoration: none;
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
.kbrt-lobby .rr-action {
  font-family: var(--font-display); font-size: 9px; letter-spacing: 1.5px; color: var(--text-muted);
  text-transform: uppercase; cursor: pointer; padding: 4px 8px; border-radius: 2px;
  background: transparent; border: 1px solid var(--border-line); transition: all .15s;
}
.kbrt-lobby .rr-action:hover { color: var(--accent); border-color: var(--accent); }
.kbrt-lobby .rr-empty {
  font-family: var(--font-script); font-style: italic; color: var(--text-muted);
  font-size:12px; line-height:1.6; margin: 0 0 24px;
  border:1px dashed var(--border-line); border-radius:3px; padding:12px;
}
.kbrt-lobby .rr-empty strong { color: var(--accent); font-weight: 600; }

/* Companions / friends rows */
.kbrt-lobby .friend-requests { margin-bottom: 14px; }
.kbrt-lobby .friend-row {
  display: flex; align-items: center; gap: 10px; padding: 6px 0;
  border-bottom: 1px dashed transparent;
}
.kbrt-lobby .friend-row + .friend-row { border-top: 1px dashed var(--border-line); }
.kbrt-lobby .friend-row.request {
  background: rgba(224,180,79,.06); border:1px solid var(--border-line); border-radius: 3px;
  padding: 8px 10px; margin-bottom: 6px;
}
.kbrt-lobby .friend-row .av {
  width: 32px; height: 32px; border-radius: 50%; flex: 0 0 32px;
  display: grid; place-items: center;
  font-family: var(--font-display); font-weight: 700; color: var(--accent);
  position: relative; box-shadow: 0 0 0 2px var(--bg-panel-deep);
  font-size: 12px; overflow: hidden;
}
.kbrt-lobby .friend-row .av img { width: 100%; height: 100%; object-fit: cover; }
.kbrt-lobby .friend-row .av .pres {
  position: absolute; bottom: -1px; right: -1px; width: 10px; height: 10px;
  border-radius: 50%; border: 2px solid var(--bg-panel);
}
.kbrt-lobby .friend-row .pres.in-game { background: var(--accent); box-shadow: 0 0 4px var(--accent); }
.kbrt-lobby .friend-row .pres.online { background: var(--success); }
.kbrt-lobby .friend-row .pres.offline { background: var(--text-muted); }
.kbrt-lobby .friend-row .info { flex: 1; min-width: 0; }
.kbrt-lobby .friend-row .info .n {
  font-family: var(--font-display); font-size: 12px; color: var(--text-primary);
  letter-spacing: .5px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbrt-lobby .friend-row .info .s {
  font-family: var(--font-body); font-style: italic; color: var(--text-muted);
  font-size: 10px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbrt-lobby .friend-btn {
  background: transparent; border: 1px solid var(--border-line); border-radius: 3px;
  color: var(--text-muted); cursor: pointer;
  width: 26px; height: 26px; display: grid; place-items: center;
  transition: all .15s;
}
.kbrt-lobby .friend-btn:hover { color: var(--accent); border-color: var(--accent); background: rgba(224,180,79,.06); }
.kbrt-lobby .friend-btn.accept { color: var(--success); border-color: rgba(122,162,102,.4); }
.kbrt-lobby .friend-btn.accept:hover { background: rgba(122,162,102,.12); border-color: var(--success); }
.kbrt-lobby .friend-btn.decline { color: var(--blood-400); border-color: rgba(201,66,58,.35); }
.kbrt-lobby .friend-btn.decline:hover { background: rgba(201,66,58,.12); border-color: var(--blood-400); }
.kbrt-lobby .friend-btn.invite { color: var(--accent); border-color: var(--border-line); }
.kbrt-lobby .friend-btn.unfriend { opacity: 0; transition: opacity .15s, color .15s, border-color .15s; }
.kbrt-lobby .friend-row:hover .friend-btn.unfriend { opacity: 1; }
.kbrt-lobby .friend-btn.unfriend:hover { color: var(--blood-400); border-color: var(--blood-400); }

/* Add Friend modal — search results + outgoing pending list */
.kbrt-lobby .search-meta {
  font-family: var(--font-body); font-style: italic; color: var(--text-muted);
  font-size: 12px; margin-top: 8px;
}
.kbrt-lobby .link-btn {
  background: transparent; border: none; padding: 0;
  color: var(--accent); font-family: var(--font-body); font-style: italic;
  font-size: 12px; cursor: pointer; text-decoration: underline;
}
.kbrt-lobby .link-btn:disabled { opacity: .5; cursor: not-allowed; }
.kbrt-lobby .search-results {
  margin-top: 12px; max-height: 240px; overflow-y: auto;
  border: 1px solid var(--border-line); border-radius: 3px;
}
.kbrt-lobby .search-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-bottom: 1px solid var(--border-line);
}
.kbrt-lobby .search-row:last-child { border-bottom: none; }
.kbrt-lobby .search-row .av.small { width: 28px; height: 28px; flex: 0 0 28px; font-size: 11px; }
.kbrt-lobby .search-row .av.small img { width: 100%; height: 100%; object-fit: cover; }
.kbrt-lobby .search-row .info { flex: 1; min-width: 0; }
.kbrt-lobby .search-row .info .n {
  font-family: var(--font-display); font-size: 12px; color: var(--text-primary);
  letter-spacing: .5px; margin: 0;
}
.kbrt-lobby .search-row .info .s {
  font-family: var(--font-body); font-style: italic; color: var(--text-muted);
  font-size: 10px; margin: 2px 0 0;
}
.kbrt-lobby .search-btn { padding: 4px 10px; font-size: 9px; }
.kbrt-lobby .outgoing-section { margin-top: 18px; }
.kbrt-lobby .outgoing-head {
  font-family: var(--font-display); font-size: 9px; letter-spacing: 2px;
  color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;
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
.kbrt-lobby .news-empty {
  font-family: var(--font-script); font-style: italic; color: var(--text-muted);
  font-size: 12px; line-height: 1.5; padding: 8px 0;
}

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
