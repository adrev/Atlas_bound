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
import { InitiativeTracker } from '../combat/InitiativeTracker';
import { CharacterSheet } from '../character/CharacterSheet';
import { ChatPanel } from '../chat/ChatPanel';
import { PlayerList } from '../session/PlayerList';
import { DMToolbar } from '../dm/DMToolbar';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
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
  { id: 'character', label: 'Character', icon: <BookOpen size={16} /> },
  { id: 'compendium', label: 'Wiki', icon: <Library size={16} /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquare size={16} /> },
  { id: 'players', label: 'Players', icon: <Users size={16} /> },
  { id: 'dm', label: 'DM Tools', icon: <Settings size={16} />, dmOnly: true },
];

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const isDM = useSessionStore((s) => s.isDM);
  const combatActive = useCombatStore((s) => s.active);

  // Listen for token click to switch to character tab
  useEffect(() => {
    const handler = () => setActiveTab('character');
    window.addEventListener('switch-to-character-tab', handler);
    return () => window.removeEventListener('switch-to-character-tab', handler);
  }, []);

  const visibleTabs = TABS.filter((t) => !t.dmOnly || isDM);

  return (
    <div style={styles.container}>
      {/* Initiative tracker shown at top during combat */}
      {combatActive && activeTab === 'combat' && (
        <div style={styles.initiativeSection}>
          <InitiativeTracker />
        </div>
      )}

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
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
        ))}
      </div>

      {/* Tab content */}
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

function CombatPanel() {
  const combatActive = useCombatStore((s) => s.active);
  const isDM = useSessionStore((s) => s.isDM);

  if (!combatActive) {
    return (
      <div style={styles.emptyState}>
        <Swords size={32} color={theme.text.muted} />
        <p style={{ color: theme.text.secondary, margin: 0 }}>
          No combat active
        </p>
        {isDM && (
          <p style={{ color: theme.text.muted, fontSize: 12, margin: 0 }}>
            Select tokens on the map and start combat from DM Tools.
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
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
    flexShrink: 0,
  },
  tabBar: {
    display: 'flex',
    borderBottom: `1px solid ${theme.border.default}`,
    background: theme.bg.base,
    flexShrink: 0,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '10px 4px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: theme.text.muted,
    fontSize: 10,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    minWidth: 0,
  },
  tabActive: {
    color: theme.gold.primary,
    borderBottomColor: theme.gold.primary,
    background: theme.gold.bg,
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
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
};
