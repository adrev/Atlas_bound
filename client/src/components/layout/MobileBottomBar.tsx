import { theme } from '../../styles/theme';

export type MobileTab = 'map' | 'character' | 'chat' | 'dice';

interface MobileBottomBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const TABS: { id: MobileTab; label: string; icon: string }[] = [
  { id: 'map', label: 'Map', icon: '\u{1F5FA}\uFE0F' },
  { id: 'character', label: 'Character', icon: '\u{1F3AD}' },
  { id: 'chat', label: 'Chat', icon: '\u{1F4AC}' },
  { id: 'dice', label: 'Dice', icon: '\u{1F3B2}' },
];

export function MobileBottomBar({ activeTab, onTabChange }: MobileBottomBarProps) {
  return (
    <div style={styles.container}>
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            style={{
              ...styles.tab,
              ...(isActive ? styles.tabActive : {}),
            }}
            onClick={() => onTabChange(tab.id)}
          >
            <span style={styles.icon}>{tab.icon}</span>
            <span style={{
              ...styles.label,
              color: isActive ? theme.gold.primary : theme.text.muted,
            }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'stretch',
    height: 56,
    background: theme.bg.deep,
    borderTop: `1px solid ${theme.gold.border}`,
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '6px 0',
    minHeight: 44,
    minWidth: 44,
    transition: `background ${theme.motion.fast}`,
  },
  tabActive: {
    background: theme.gold.bg,
    boxShadow: `inset 0 2px 0 ${theme.gold.primary}`,
  },
  icon: {
    fontSize: 20,
    lineHeight: 1,
  },
  label: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    fontFamily: theme.font.body,
  },
};
