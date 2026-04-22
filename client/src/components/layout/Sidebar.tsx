import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  Swords,
  BookOpen,
  Library,
  ScrollText,
  MessageSquare,
  Users,
  Settings,
} from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { useMapStore } from '../../stores/useMapStore';
import { useChatStore } from '../../stores/useChatStore';
import { InitiativeTracker } from '../combat/InitiativeTracker';
import { TokenActionPanel } from '../canvas/TokenActionPanel';
import { CharacterImport } from '../character/CharacterImport';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { emitTokenAdd, emitCharacterUpdate, emitViewing } from '../../socket/emitters';
import { Upload, MapPin, RefreshCw, Trash2 } from 'lucide-react';
import { ChatPanel } from '../chat/ChatPanel';
import { PlayerList } from '../session/PlayerList';
import { emitStartCombat, emitEndCombat, emitReadyCheck } from '../../socket/emitters';

// Lazy-loaded sidebar tabs. Each of these represents a sizable chunk
// of code (compendium data, DM toolbar + its sub-panels, the notes
// editor) that most users don't touch on first load. Splitting them
// into their own chunks shrinks the initial bundle meaningfully.
const NotesPanel = lazy(() =>
  import('../notes/NotesPanel').then((m) => ({ default: m.NotesPanel })),
);
const DMToolbar = lazy(() =>
  import('../dm/DMToolbar').then((m) => ({ default: m.DMToolbar })),
);
const CompendiumPanel = lazy(() =>
  import('../compendium/CompendiumPanel').then((m) => ({ default: m.CompendiumPanel })),
);

function TabLoadingFallback() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 24,
      color: theme.text.muted, fontSize: 12,
    }}>
      Loading…
    </div>
  );
}
import { Check, Circle } from 'lucide-react';
import { theme } from '../../styles/theme';
import { Button, askConfirm } from '../ui';

type TabId = 'combat' | 'character' | 'compendium' | 'notes' | 'chat' | 'players' | 'dm';

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  dmOnly?: boolean;
}

// Ordered for combat-first use: Chat + Combat stay in the eye line
// since that's where 90% of session interaction lives. DM Tools comes
// next so the DM doesn't have to scan past every player-facing tab.
// Hero / Wiki / Notes follow, and Players lands last (roster is only
// used at join / kick / ban time, not in-game).
const TABS: TabDef[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare size={16} /> },
  { id: 'combat', label: 'Combat', icon: <Swords size={16} /> },
  { id: 'dm', label: 'Tools', icon: <Settings size={16} />, dmOnly: true },
  // Label reads "Hero" (shorter + more thematic for the DM vibe)
  // while the internal id stays 'character' so existing event
  // listeners, routing, and component names don't need to change.
  { id: 'character', label: 'Hero', icon: <BookOpen size={16} /> },
  { id: 'compendium', label: 'Wiki', icon: <Library size={16} /> },
  { id: 'notes', label: 'Notes', icon: <ScrollText size={16} /> },
  { id: 'players', label: 'Players', icon: <Users size={16} /> },
];

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const isDM = useSessionStore((s) => s.isDM);
  const unreadCount = useChatStore((s) => s.unreadCount);

  // Keep the chat store in sync with whether the chat tab is visible
  useEffect(() => {
    useChatStore.getState().setChatTabActive(activeTab === 'chat');
  }, [activeTab]);

  // Broadcast which tab we're viewing to other players
  useEffect(() => {
    emitViewing(activeTab);
  }, [activeTab]);

  // Listen for token click to switch to character tab
  useEffect(() => {
    const handler = () => setActiveTab('character');
    window.addEventListener('switch-to-character-tab', handler);
    return () => window.removeEventListener('switch-to-character-tab', handler);
  }, []);

  // If the DM gets demoted while the Tools tab is open, the tab
  // disappears from the bar but the active-tab state would otherwise
  // stay 'dm' and leave the user staring at an empty panel. Bounce
  // them back to Chat on the role flip.
  useEffect(() => {
    if (!isDM && activeTab === 'dm') setActiveTab('chat');
  }, [isDM, activeTab]);

  const visibleTabs = TABS.filter((t) => !t.dmOnly || isDM);

  return (
    <div style={styles.container}>
      {/* Tab bar — rune-slab / book-chapter style.
          Each tab is its own "tile" with a subtle stone background,
          gold-tinted borders, and a thin ornate separator between
          them. Active tab gets a warm parchment glow and a prominent
          gold bottom border like the ribbon of a chapter marker. */}
      <div style={styles.tabBar}>
        {visibleTabs.map((tab, idx) => (
          <div
            key={tab.id}
            style={{
              display: 'flex',
              alignItems: 'stretch',
              flex: 1,
              minWidth: 0,
            }}
          >
            <button
              style={{
                ...styles.tab,
                ...(activeTab === tab.id ? styles.tabActive : {}),
              }}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              <span style={{ position: 'relative' as const, display: 'inline-flex' }}>
                {tab.icon}
                {tab.id === 'chat' && activeTab !== 'chat' && unreadCount > 0 && (
                  <span style={styles.unreadBadge}>
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </span>
              <span style={styles.tabLabel}>{tab.label}</span>
            </button>
            {/* Rune-slab separator between tiles — a thin vertical
                gold-dim line with fade at top and bottom. Omitted
                after the last tab. */}
            {idx < visibleTabs.length - 1 && (
              <div aria-hidden style={styles.tabSeparator} />
            )}
          </div>
        ))}
      </div>

      {/* Tab content. The initiative tracker lives ONLY inside the
          Combat tab — switching to Chat / Players / DM Tools no longer
          shows it overlaid on top. */}
      <div style={styles.content}>
        {activeTab === 'combat' && <CombatPanel />}
        {activeTab === 'character' && <HeroTab />}
        {activeTab === 'compendium' && (
          <Suspense fallback={<TabLoadingFallback />}>
            <CompendiumPanel />
          </Suspense>
        )}
        {activeTab === 'notes' && (
          <Suspense fallback={<TabLoadingFallback />}>
            <NotesPanel />
          </Suspense>
        )}
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'players' && <PlayerList />}
        {activeTab === 'dm' && isDM && (
          <Suspense fallback={<TabLoadingFallback />}>
            <DMToolsPanel />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/**
 * Decide whether a token should participate in combat. Filters out
 * utility markers like the Light cantrip's spawned light tokens
 * (`Light (CasterName)` / `Dancing Lights (CasterName)`) and any
 * tiny non-character markers. Loot drops have a characterId pointing
 * at a loot bag record so they're identified by their image path.
 */
function isCombatantToken(t: { name: string; size: number; characterId: string | null; imageUrl: string | null }): boolean {
  if (/^(Light|Dancing Lights) \(/.test(t.name)) return false;
  if ((t.imageUrl ?? '').includes('/uploads/items/')) return false;
  if (t.size < 0.5 && !t.characterId) return false;
  return true;
}

/**
 * Hero sidebar tab.
 *
 * Layout:
 *  ┌──────────────────────────┐
 *  │ Active character takes   │
 *  │ focus at the top — full  │
 *  │ TokenActionPanel embed.  │
 *  │                          │
 *  │                          │
 *  ├──────────────────────────┤
 *  │ [Show List] [Import]     │
 *  └──────────────────────────┘
 *
 * "Show List" reveals a character picker overlay so the player can
 * switch active characters. "Import" opens the D&D Beyond import
 * dialog. Activating a character closes the overlay and the new
 * character takes focus at the top.
 */
function HeroTab() {
  const rawMyCharacter = useCharacterStore((s) => s.myCharacter);
  const tokens = useMapStore((s) => s.tokens);
  const currentMap = useMapStore((s) => s.currentMap);
  const userId = useSessionStore((s) => s.userId);
  const isDM = useSessionStore((s) => s.isDM);
  const [showImport, setShowImport] = useState(false);
  const [showList, setShowList] = useState(false);
  const [characters, setCharacters] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // Defensive filter: a player should only ever see a character they
  // actually own in the HeroTab. DMs can swap between any character
  // (that's the "DM navigating heroes" flow) — their own ownership
  // check is looser. If myCharacter was somehow set to someone else
  // (via a stale socket sync, pre-login localStorage carry-over, etc.)
  // this hides it so the tab renders the "No hero" empty state.
  const myCharacter =
    rawMyCharacter && (isDM || rawMyCharacter.userId === userId)
      ? rawMyCharacter
      : null;

  // Load all characters owned by this user.
  const reloadList = () => {
    if (!userId) return;
    setListLoading(true);
    fetch(`/api/characters?userId=${encodeURIComponent(userId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: any[]) => {
        setCharacters(data);
        // Auto-activate the last-used character (from localStorage) or
        // the first one in the list if nothing is active yet.
        if (!useCharacterStore.getState().myCharacter) {
          const savedId = localStorage.getItem('dnd-vtt-characterId');
          const target = data.find((c) => c.id === savedId) ?? data[0];
          if (target) useCharacterStore.getState().setCharacter(target);
        }
      })
      .catch(() => setCharacters([]))
      .finally(() => setListLoading(false));
  };
  useEffect(() => {
    reloadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const activateCharacter = (char: any) => {
    useCharacterStore.getState().setCharacter(char);
    localStorage.setItem('dnd-vtt-characterId', char.id);
    setShowList(false);
  };

  const myTokenId = myCharacter
    ? Object.values(tokens).find((t) => t.characterId === myCharacter.id)?.id
    : undefined;

  const handlePlace = () => {
    if (!myCharacter || !currentMap) return;
    const gridSize = currentMap.gridSize ?? 70;
    emitTokenAdd({
      mapId: currentMap.id,
      characterId: myCharacter.id,
      name: myCharacter.name,
      x: currentMap.width / 2,
      y: currentMap.height / 2,
      size: 1,
      imageUrl: myCharacter.portraitUrl,
      color: '#d4a843',
      layer: 'token',
      visible: true,
      hasLight: false,
      lightRadius: gridSize * 4,
      lightDimRadius: gridSize * 8,
      lightColor: '#ffcc66',
      conditions: [],
      ownerUserId: userId,
    });
  };

  const handleSyncFromDDB = async () => {
    if (!myCharacter?.dndbeyondId) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const resp = await fetch(`/api/dndbeyond/sync/${myCharacter.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Sync failed (${resp.status})`);
      }
      const updated = await resp.json();
      useCharacterStore.getState().setCharacter(updated);
      // Broadcast to other clients so they see the level-up in real-time
      emitCharacterUpdate(myCharacter.id, {
        level: updated.level, class: updated.class,
        armorClass: updated.armorClass, speed: updated.speed,
        maxHitPoints: updated.maxHitPoints,
        abilityScores: updated.abilityScores,
        proficiencyBonus: updated.proficiencyBonus,
      });
      setSyncMessage({ text: `Synced from D&D Beyond — now Level ${updated.level}`, isError: false });
      reloadList();
      // Auto-dismiss success message after a few seconds
      setTimeout(() => setSyncMessage(null), 5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      setSyncMessage({ text: msg, isError: true });
    } finally {
      setSyncing(false);
    }
  };

  // DM-only party browser when no character is active. Players see the
  // generic "import a character" prompt; DMs see the list of PC tokens
  // on the map so they can click into any party member's sheet without
  // needing to own a character themselves. Once the DM picks one, the
  // rest of the HeroTab treats it as the active hero (combat actions,
  // spell slots, etc.) and they can swap back via this same list.
  const partyRoster = useMemo(() => {
    if (!isDM) return [];
    const seen = new Set<string>();
    const out: { characterId: string; name: string; portraitUrl?: string | null }[] = [];
    for (const t of Object.values(tokens)) {
      if (!t.characterId || seen.has(t.characterId)) continue;
      if (!t.ownerUserId || t.ownerUserId === 'npc') continue; // PC tokens only
      const ch = useCharacterStore.getState().allCharacters[t.characterId];
      out.push({
        characterId: t.characterId,
        name: ch?.name ?? t.name,
        portraitUrl: ch?.portraitUrl ?? t.imageUrl ?? null,
      });
      seen.add(t.characterId);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, isDM]);

  const loadPartyCharacter = async (characterId: string) => {
    try {
      const resp = await fetch(`/api/characters/${characterId}`);
      if (!resp.ok) return;
      const ch = await resp.json();
      useCharacterStore.getState().setCharacter(ch);
    } catch { /* ignore */ }
  };

  // ── Active character body (top, takes focus) ───────────
  let body: React.ReactNode;
  if (!myCharacter) {
    body = (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center',
        flex: 1,
      }}>
        <BookOpen size={40} color={theme.text.muted} />
        <p style={{ color: theme.text.secondary, margin: 0, fontSize: 12 }}>
          {isDM
            ? 'No active hero. Pick a party member below or import your own character.'
            : 'No active hero. Use the buttons below to load or import a character.'}
        </p>
        {isDM && partyRoster.length > 0 && (
          <div style={{
            width: '100%', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: theme.gold.dim, marginBottom: 2,
            }}>
              Party ({partyRoster.length})
            </div>
            {partyRoster.map((p) => (
              <button
                key={p.characterId}
                onClick={() => loadPartyCharacter(p.characterId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', fontSize: 12,
                  background: theme.bg.elevated,
                  border: `1px solid ${theme.border.default}`,
                  borderRadius: theme.radius.sm,
                  color: theme.text.primary, cursor: 'pointer',
                  fontFamily: theme.font.body, textAlign: 'left',
                }}
              >
                {p.portraitUrl ? (
                  <img
                    src={p.portraitUrl}
                    alt=""
                    style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%',
                    background: theme.gold.bg, color: theme.gold.primary,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                  }}>
                    {p.name?.[0] ?? '?'}
                  </div>
                )}
                <span style={{ flex: 1 }}>{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (!myTokenId) {
    body = (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 14, padding: '24px 16px', textAlign: 'center', flex: 1,
      }}>
        {myCharacter.portraitUrl ? (
          <img
            src={myCharacter.portraitUrl}
            alt=""
            style={{
              width: 96, height: 96, borderRadius: '50%',
              objectFit: 'cover',
              border: `2px solid ${theme.gold.primary}`,
            }}
          />
        ) : (
          <div style={{
            width: 96, height: 96, borderRadius: '50%',
            background: theme.bg.elevated,
            border: `2px solid ${theme.gold.primary}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, fontWeight: 700, color: theme.text.primary,
          }}>{myCharacter.name?.[0] ?? '?'}</div>
        )}
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.text.primary }}>
            {myCharacter.name}
          </div>
          <div style={{ fontSize: 11, color: theme.text.muted, marginTop: 2 }}>
            {myCharacter.race} {myCharacter.class} • Lv {myCharacter.level}
          </div>
        </div>
        <div style={{ fontSize: 11, color: theme.text.muted, lineHeight: 1.5 }}>
          {myCharacter.name} isn't on the battle map yet.
        </div>
        <Button
          variant="primary"
          size="md"
          leadingIcon={<MapPin size={14} />}
          onClick={handlePlace}
          disabled={!currentMap}
          title={!currentMap ? 'Load a map first' : 'Place your hero on the current map'}
        >
          Place on Map
        </Button>
      </div>
    );
  } else {
    body = (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TokenActionPanel embedded embeddedTokenId={myTokenId} />
      </div>
    );
  }

  // ── Character list overlay (shown on demand) ───────────
  const listOverlay = showList && (
    <div
      onClick={() => setShowList(false)}
      style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxHeight: '70%',
          background: theme.bg.card,
          borderTop: `1px solid ${theme.gold.border}`,
          borderTopLeftRadius: 10, borderTopRightRadius: 10,
          boxShadow: '0 -8px 30px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: `1px solid ${theme.border.default}`,
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
            color: theme.gold.dim, textTransform: 'uppercase',
          }}>
            My Characters ({characters.length})
          </span>
          <button
            onClick={() => setShowList(false)}
            style={{
              background: 'none', border: 'none',
              color: theme.text.muted, fontSize: 18, cursor: 'pointer',
              padding: 0, lineHeight: 1,
            }}
          >×</button>
        </div>
        <div style={{
          padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
          overflowY: 'auto', flex: 1,
        }}>
          {listLoading ? (
            <div style={{ fontSize: 11, color: theme.text.muted, padding: 8 }}>
              Loading…
            </div>
          ) : characters.length === 0 ? (
            <div style={{ fontSize: 11, color: theme.text.muted, padding: 8 }}>
              No characters yet. Click Import Character below to add one.
            </div>
          ) : (
            characters.map((c) => {
              const isActive = c.id === myCharacter?.id;
              const tokenOnMap = Object.values(tokens).some((t) => t.characterId === c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => activateCharacter(c)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px',
                    background: isActive ? 'rgba(232,196,85,0.12)' : theme.bg.elevated,
                    border: `1px solid ${isActive ? theme.gold.primary : theme.border.default}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: theme.text.primary,
                    transition: 'all 0.15s',
                  }}
                >
                  {c.portraitUrl ? (
                    <img src={c.portraitUrl} alt="" style={{
                      width: 40, height: 40, borderRadius: '50%', objectFit: 'cover',
                      border: `1px solid ${isActive ? theme.gold.primary : theme.border.default}`,
                      flexShrink: 0,
                    }} />
                  ) : (
                    <div style={{
                      width: 40, height: 40, borderRadius: '50%',
                      background: theme.bg.deep,
                      border: `1px solid ${isActive ? theme.gold.primary : theme.border.default}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 15, fontWeight: 700,
                      flexShrink: 0,
                    }}>{c.name?.[0] ?? '?'}</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 700,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{c.name}</div>
                    <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 1 }}>
                      {c.race} {c.class} • Lv {c.level}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {tokenOnMap && (
                      <span title="On the map" style={{
                        fontSize: 8, fontWeight: 700,
                        padding: '2px 5px', borderRadius: 3,
                        background: 'rgba(46,204,113,0.2)',
                        color: theme.state.success,
                        letterSpacing: '0.05em',
                      }}>ON MAP</span>
                    )}
                    <button
                      title="Delete character"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const ok = await askConfirm({
                          title: 'Delete character',
                          message: `Delete "${c.name}"? This cannot be undone.`,
                          tone: 'danger',
                          confirmLabel: 'Delete',
                        });
                        if (!ok) return;
                        fetch(`/api/characters/${c.id}`, { method: 'DELETE', credentials: 'include' })
                          .then((r) => {
                            if (r.ok) {
                              setCharacters((prev) => prev.filter((ch) => ch.id !== c.id));
                              // If deleted character was active, reload to clear
                            if (myCharacter?.id === c.id) {
                              window.location.reload();
                            }
                            }
                          })
                          .catch(() => {});
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: theme.text.muted, padding: 4, borderRadius: 4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: 0.5, transition: 'opacity 0.15s',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget).style.opacity = '1'; (e.currentTarget).style.color = theme.danger; }}
                      onMouseLeave={(e) => { (e.currentTarget).style.opacity = '0.5'; (e.currentTarget).style.color = theme.text.muted; }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );

  // ── Bottom action bar ───────────────────────────────────
  const hasDdbId = !!myCharacter?.dndbeyondId;

  const bottomBar = (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 0,
      borderTop: `1px solid ${theme.border.default}`,
      background: theme.bg.card,
      flexShrink: 0,
    }}>
      {/* Sync toast message */}
      {syncMessage && (
        <div style={{
          padding: '6px 12px',
          fontSize: 12,
          color: syncMessage.isError ? theme.danger : theme.state.success,
          background: syncMessage.isError
            ? 'rgba(192, 57, 43, 0.12)'
            : 'rgba(46, 204, 113, 0.12)',
          borderBottom: `1px solid ${syncMessage.isError
            ? 'rgba(192, 57, 43, 0.25)'
            : 'rgba(46, 204, 113, 0.25)'}`,
          textAlign: 'center',
        }}>
          {syncMessage.text}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 12px' }}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<BookOpen size={13} />}
          onClick={() => setShowList(true)}
          style={{ color: theme.gold.primary, borderColor: theme.gold.border, flex: '1 1 auto', minWidth: 0 }}
        >
          Character List
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Upload size={13} />}
          onClick={() => setShowImport(true)}
          style={{ color: theme.gold.primary, borderColor: theme.gold.border, flex: '1 1 auto', minWidth: 0 }}
        >
          Import
        </Button>
        {hasDdbId && (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={
              <RefreshCw
                size={13}
                style={syncing ? { animation: 'spin 1s linear infinite' } : undefined}
              />
            }
            onClick={handleSyncFromDDB}
            disabled={syncing}
            style={{ color: theme.gold.primary, borderColor: theme.gold.border, flex: '1 1 auto', minWidth: 0 }}
          >
            {syncing ? 'Syncing...' : 'Sync'}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      position: 'relative',
    }}>
      {body}
      {bottomBar}
      {listOverlay}
      {showImport && (
        <CharacterImport
          onClose={() => {
            setShowImport(false);
            reloadList();
          }}
        />
      )}
    </div>
  );
}

function CombatPanel() {
  const combatActive = useCombatStore((s) => s.active);
  const readyCheck = useCombatStore((s) => s.readyCheck);
  const lastRecap = useCombatStore((s) => s.lastRecap);
  const setShowRecap = useCombatStore((s) => s.setShowRecap);
  // Hoisted above the conditional early-returns below so the hook
  // sequence doesn't change when `combatActive` flips from false → true.
  // Without this, React throws error #310 ("Rendered more hooks than
  // during the previous render") the first time the DM clicks
  // "Start Combat" because this hook was previously skipped by the
  // !combatActive early return.
  const reviewPhase = useCombatStore((s) => s.reviewPhase);
  const isDM = useSessionStore((s) => s.isDM);
  const players = useSessionStore((s) => s.players);
  const tokens = useMapStore((s) => s.tokens);
  // Only count tokens that would actually enter initiative — light
  // markers / loot drops are excluded so the button label and the
  // disabled-state heuristic match what gets sent to the server.
  const combatantTokens = Object.values(tokens).filter(isCombatantToken);
  const tokenCount = combatantTokens.length;

  // DM-only Start/End Combat button. Routes through the shared Button
  // primitive so its hover/focus/disabled states match every other
  // CTA in the app. `danger` for Start Combat (red call-to-action)
  // and `primary` (gold) for End Combat.
  const combatButton = isDM && (
    combatActive ? (
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={() => emitEndCombat()}
      >
        End Combat
      </Button>
    ) : (
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="danger"
          size="lg"
          fullWidth
          disabled={tokenCount === 0 || !!readyCheck?.active}
          onClick={() => {
            const tokenIds = combatantTokens.map((t) => t.id);
            if (tokenIds.length === 0) return;
            emitStartCombat(tokenIds);
          }}
        >
          Start Combat
        </Button>
        <Button
          variant="ghost"
          size="lg"
          disabled={tokenCount === 0 || !!readyCheck?.active}
          onClick={() => {
            const tokenIds = combatantTokens.map((t) => t.id);
            if (tokenIds.length === 0) return;
            emitReadyCheck(tokenIds);
          }}
          title="Send a ready check to all players before starting combat"
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          Ready Check
        </Button>
      </div>
    )
  );

  // Ready check player status list (DM view)
  const readyCheckStatus = isDM && readyCheck?.active && (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '10px 0',
      borderTop: `1px solid ${theme.border.default}`,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: theme.gold.dim,
        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2,
      }}>
        Ready Check
      </div>
      {readyCheck.playerIds.map((pid) => {
        const player = players.find((p: any) => p.userId === pid);
        const isReady = readyCheck.responses[pid] === true;
        return (
          <div key={pid} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 6px',
            fontSize: 12,
            color: isReady ? theme.state.success : theme.text.secondary,
          }}>
            {isReady ? (
              <Check size={14} color={theme.state.success} />
            ) : (
              <Circle size={14} color={theme.text.muted} />
            )}
            <span style={{ fontWeight: isReady ? 700 : 400 }}>
              {player?.displayName ?? pid}
            </span>
          </div>
        );
      })}
    </div>
  );

  if (!combatActive) {
    return (
      <div style={styles.combatPanel}>
        {combatButton}
        {readyCheckStatus}
        <div style={styles.emptyState}>
          <Swords size={32} color={theme.text.muted} />
          <p style={{ color: theme.text.secondary, margin: 0 }}>
            No combat active
          </p>
          {isDM && !readyCheck?.active && (
            <p style={{ color: theme.text.muted, fontSize: 12, margin: 0, textAlign: 'center' }}>
              {tokenCount === 0
                ? 'Place tokens on the map first.'
                : `${tokenCount} token${tokenCount !== 1 ? 's' : ''} ready to enter initiative.`}
            </p>
          )}
          {!isDM && (
            <p style={{ color: theme.text.muted, fontSize: 12, margin: 0, textAlign: 'center' }}>
              Wait for the DM to start combat.
            </p>
          )}
          {lastRecap && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowRecap(true)}
              style={{ marginTop: 8 }}
            >
              View Last Recap
            </Button>
          )}
        </div>
      </div>
    );
  }

  // During the initiative review phase we suppress the tracker — the
  // InitiativeReviewModal covers the same turn-order view with
  // editable inputs, and showing both at once double-draws the same
  // combatants. Falls back to a small placeholder for the DM so the
  // Combat tab doesn't look empty mid-review. `reviewPhase` was hoisted
  // to the top of the component so the hook call order stays stable
  // across the !combatActive early-return branch.
  if (reviewPhase) {
    return (
      <div style={styles.combatPanel}>
        {combatButton}
        <div style={{
          padding: 16, textAlign: 'center', color: theme.text.muted, fontSize: 12,
        }}>
          {isDM
            ? 'Reviewing initiative — confirm in the modal to begin.'
            : 'Initiative rolled — waiting on DM to lock in the order.'}
        </div>
      </div>
    );
  }

  // The full initiative tracker (round counter, combatants list,
  // action economy, End Turn) lives inside the Combat tab content
  // only. This way other tabs (Chat, Players, DM Tools) aren't
  // covered by the tracker.
  return (
    <div style={styles.combatPanel}>
      {combatButton}
      <InitiativeTracker />
    </div>
  );
}

function DMToolsPanel() {
  return <DMToolbar />;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  initiativeSection: {
    borderBottom: `1px solid ${theme.border.default}`,
    // Cap the tracker to ~45% of the sidebar so the tab content
    // (chat, players, etc) below always gets room. Any overflow
    // scrolls internally. Without this cap, a long initiative order
    // could push the tab content right off the bottom of the screen.
    maxHeight: '45vh',
    overflowY: 'auto' as const,
    flexShrink: 0,
  },
  tabBar: {
    display: 'flex',
    alignItems: 'stretch',
    // Layered background for the rune-slab parchment look: warm
    // deep stone base with a subtle top highlight line.
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 2px, ${theme.bg.base} 100%)`,
    borderBottom: `1px solid ${theme.gold.border}`,
    boxShadow: `inset 0 -1px 0 ${theme.border.default}`,
    flexShrink: 0,
    overflow: 'hidden',
    // Small padding so the first/last tabs don't touch the
    // sidebar edges and feel visually balanced.
    padding: `4px 4px 0`,
  },
  // Note: use ONLY the border shorthand (not a mix of shorthand
  // `borderBottom` and the longhand `borderBottomColor`). React warns
  // on the mix and, more importantly, the longhand override can get
  // "stuck" in the DOM when tabs re-render — causing a visible grey
  // line under tabs that were previously active. Using the full
  // shorthand in BOTH states lets React replace the value atomically.
  tab: {
    // `flex: 1` on the button fills its wrapper cell (which itself
    // has `flex: 1`), giving equal-width cells. The wrapper also
    // contains the separator, so this still produces balanced cells.
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: `${theme.space.md}px ${theme.space.xs}px`,
    background: 'transparent',
    border: 'none',
    borderRadius: `${theme.radius.sm}px ${theme.radius.sm}px 0 0`,
    color: theme.text.muted,
    fontSize: 10,
    cursor: 'pointer',
    transition: `all ${theme.motion.normal}`,
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    position: 'relative' as const,
  },
  tabActive: {
    color: theme.gold.primary,
    // Parchment-colored active tile with a gold gradient bottom
    // border (the "chapter marker ribbon"). Subtle top glow too.
    background: `linear-gradient(180deg, rgba(232, 196, 85, 0.08), ${theme.gold.bg})`,
    boxShadow: `inset 0 -2px 0 ${theme.gold.primary}, inset 0 1px 0 rgba(232, 196, 85, 0.3)`,
    // Pull up 1px so the active tab visually rises above the row.
    transform: 'translateY(-1px)',
  },
  tabLabel: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    // Letter-spacing reduced from 0.5 → 0.3 to save a few pixels
    // per tab without losing the caps-label feel.
    letterSpacing: '0.3px',
    whiteSpace: 'nowrap' as const,
  },
  // Vertical rune-slab divider between tabs — a thin "carved"
  // separator that evokes an inscribed line on a stone tile.
  // Uses a layered 2-pixel gradient (bright highlight + shadow)
  // so it reads clearly without feeling heavy.
  tabSeparator: {
    width: 2,
    alignSelf: 'stretch',
    background: `
      linear-gradient(90deg,
        rgba(0,0,0,0.35) 0%,
        rgba(0,0,0,0.35) 50%,
        rgba(232, 196, 85, 0.5) 50%,
        rgba(232, 196, 85, 0.5) 100%
      )
    `,
    margin: `${theme.space.sm}px 0`,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 40,
    textAlign: 'center' as const,
  },
  combatPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    padding: 12,
    gap: 12,
  },
  unreadBadge: {
    position: 'absolute' as const,
    top: -4,
    right: -8,
    minWidth: 14,
    height: 14,
    padding: '0 3px',
    borderRadius: 7,
    background: theme.danger,
    color: '#fff',
    fontSize: 8,
    fontWeight: 700,
    lineHeight: '14px',
    textAlign: 'center' as const,
    pointerEvents: 'none' as const,
    boxShadow: '0 0 4px rgba(192,57,43,0.6)',
  },
};
