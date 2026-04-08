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
import { CharacterSheet } from '../character/CharacterSheet';
import { ChatPanel } from '../chat/ChatPanel';
import { PlayerList } from '../session/PlayerList';
import { DMToolbar } from '../dm/DMToolbar';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import { emitStartCombat, emitEndCombat } from '../../socket/emitters';
import { theme } from '../../styles/theme';

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
        {activeTab === 'character' && <CharacterSheet />}
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

function CombatPanel() {
  const combatActive = useCombatStore((s) => s.active);
  const isDM = useSessionStore((s) => s.isDM);
  const tokens = useMapStore((s) => s.tokens);
  // Only count tokens that would actually enter initiative — light
  // markers / loot drops are excluded so the button label and the
  // disabled-state heuristic match what gets sent to the server.
  const combatantTokens = Object.values(tokens).filter(isCombatantToken);
  const tokenCount = combatantTokens.length;

  // DM-only Start/End Combat button. The label flips based on whether
  // combat is currently active.
  const combatButton = isDM && (
    combatActive ? (
      <button
        style={styles.combatEndButton}
        onClick={() => emitEndCombat()}
      >
        End Combat
      </button>
    ) : (
      <button
        style={{
          ...styles.combatStartButton,
          ...(tokenCount === 0 ? styles.combatButtonDisabled : {}),
        }}
        disabled={tokenCount === 0}
        onClick={() => {
          const tokenIds = combatantTokens.map((t) => t.id);
          console.log('[START COMBAT] Click. combatants:', tokenIds.length, 'isDM:', isDM);
          if (tokenIds.length === 0) {
            console.warn('[START COMBAT] No combatant tokens on map — button should be disabled');
            return;
          }
          console.log('[START COMBAT] Emitting combat:start with', tokenIds);
          emitStartCombat(tokenIds);
        }}
      >
        Start Combat
      </button>
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
  // Per user request: Start Combat = red (call to action), End Combat = yellow
  combatStartButton: {
    padding: '10px 16px',
    background: 'rgba(197,49,49,0.18)',
    color: '#e74c3c',
    border: `2px solid #c53131`,
    borderRadius: 6,
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
    boxShadow: '0 0 12px rgba(197,49,49,0.25)',
  },
  combatEndButton: {
    padding: '10px 16px',
    background: 'rgba(212,168,67,0.15)',
    color: '#d4a843',
    border: `2px solid #d4a843`,
    borderRadius: 6,
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  combatButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed' as const,
  },
};
