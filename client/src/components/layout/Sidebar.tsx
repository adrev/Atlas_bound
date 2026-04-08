import { useState, useEffect } from 'react';
import {
  Swords,
  BookOpen,
  Library,
  MessageSquare,
  Users,
  Settings,
} from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { useMapStore } from '../../stores/useMapStore';
import { InitiativeTracker } from '../combat/InitiativeTracker';
import { TokenActionPanel } from '../canvas/TokenActionPanel';
import { CharacterImport } from '../character/CharacterImport';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { emitTokenAdd } from '../../socket/emitters';
import { Upload, MapPin } from 'lucide-react';
import { ChatPanel } from '../chat/ChatPanel';
import { PlayerList } from '../session/PlayerList';
import { DMToolbar } from '../dm/DMToolbar';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import { emitStartCombat, emitEndCombat } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

type TabId = 'combat' | 'character' | 'compendium' | 'chat' | 'players' | 'dm';

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  dmOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: 'combat', label: 'Combat', icon: <Swords size={16} /> },
  // Label reads "Hero" (shorter + more thematic for the DM vibe)
  // while the internal id stays 'character' so existing event
  // listeners, routing, and component names don't need to change.
  { id: 'character', label: 'Hero', icon: <BookOpen size={16} /> },
  { id: 'compendium', label: 'Wiki', icon: <Library size={16} /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquare size={16} /> },
  { id: 'players', label: 'Players', icon: <Users size={16} /> },
  { id: 'dm', label: 'Tools', icon: <Settings size={16} />, dmOnly: true },
];

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const isDM = useSessionStore((s) => s.isDM);

  // Listen for token click to switch to character tab
  useEffect(() => {
    const handler = () => setActiveTab('character');
    window.addEventListener('switch-to-character-tab', handler);
    return () => window.removeEventListener('switch-to-character-tab', handler);
  }, []);

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
              {tab.icon}
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
        {activeTab === 'compendium' && <CompendiumPanel />}
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'players' && <PlayerList />}
        {activeTab === 'dm' && isDM && <DMToolsPanel />}
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
  const myCharacter = useCharacterStore((s) => s.myCharacter);
  const tokens = useMapStore((s) => s.tokens);
  const currentMap = useMapStore((s) => s.currentMap);
  const userId = useSessionStore((s) => s.userId);
  const [showImport, setShowImport] = useState(false);
  const [showList, setShowList] = useState(false);
  const [characters, setCharacters] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(true);

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

  // ── Active character body (top, takes focus) ───────────
  let body: React.ReactNode;
  if (!myCharacter) {
    body = (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 32, textAlign: 'center',
        flex: 1,
      }}>
        <BookOpen size={40} color={theme.text.muted} />
        <p style={{ color: theme.text.secondary, margin: 0, fontSize: 12 }}>
          No active hero. Use the buttons below to load or import a character.
        </p>
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
                  {tokenOnMap && (
                    <span title="On the map" style={{
                      fontSize: 8, fontWeight: 700,
                      padding: '2px 5px', borderRadius: 3,
                      background: 'rgba(46,204,113,0.2)',
                      color: theme.state.success,
                      letterSpacing: '0.05em',
                    }}>ON MAP</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );

  // ── Bottom action bar ───────────────────────────────────
  const bottomBar = (
    <div style={{
      display: 'flex', gap: 8,
      padding: '10px 12px',
      borderTop: `1px solid ${theme.border.default}`,
      background: theme.bg.card,
      flexShrink: 0,
    }}>
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        leadingIcon={<BookOpen size={13} />}
        onClick={() => setShowList(true)}
        style={{ color: theme.gold.primary, borderColor: theme.gold.border }}
      >
        Show Character List
      </Button>
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        leadingIcon={<Upload size={13} />}
        onClick={() => setShowImport(true)}
        style={{ color: theme.gold.primary, borderColor: theme.gold.border }}
      >
        Import Character
      </Button>
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
  const isDM = useSessionStore((s) => s.isDM);
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
      <Button
        variant="danger"
        size="lg"
        fullWidth
        disabled={tokenCount === 0}
        onClick={() => {
          const tokenIds = combatantTokens.map((t) => t.id);
          if (tokenIds.length === 0) return;
          emitStartCombat(tokenIds);
        }}
      >
        Start Combat
      </Button>
    )
  );

  if (!combatActive) {
    return (
      <div style={styles.combatPanel}>
        {combatButton}
        <div style={styles.emptyState}>
          <Swords size={32} color={theme.text.muted} />
          <p style={{ color: theme.text.secondary, margin: 0 }}>
            No combat active
          </p>
          {isDM && (
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
};
