import { QuickActions } from '../quickactions/QuickActions';
import { DiceTray } from '../dice/DiceTray';
import { theme } from '../../styles/theme';

/**
 * Bottom bar — the persistent rune-slab action bar at the base of
 * the screen. Replaces the old MMO-style drag-drop Hotbar with
 * one-click access to the 5e standard actions (Dodge, Dash, etc.)
 * plus Short/Long rest, alongside the redesigned dice tray.
 *
 * Layout:
 *   [ QuickActions ............... | divider | ... DiceTray ]
 */
export function BottomBar() {
  return (
    <div style={styles.container}>
      <div style={styles.quickActionsSection}>
        <QuickActions />
      </div>
      <div aria-hidden style={styles.divider} />
      <div style={styles.diceSection}>
        <DiceTray />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    padding: `0 ${theme.space.lg}px`,
    gap: theme.space.lg,
    // Layered background matching the tab bar's rune-slab look so the
    // bottom bar reads as a companion piece to the sidebar tabs.
    background: `linear-gradient(180deg, ${theme.bg.base} 0%, ${theme.parchmentEdge} 100%)`,
    borderTop: `1px solid ${theme.gold.border}`,
    boxShadow: `inset 0 1px 0 ${theme.border.default}`,
  },
  quickActionsSection: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
  },
  // Rune-slab vertical separator matching the tab bar spacers.
  divider: {
    width: 2,
    height: 52,
    background: `
      linear-gradient(90deg,
        rgba(0,0,0,0.35) 0%,
        rgba(0,0,0,0.35) 50%,
        rgba(232, 196, 85, 0.5) 50%,
        rgba(232, 196, 85, 0.5) 100%
      )
    `,
    flexShrink: 0,
    alignSelf: 'center',
  },
  diceSection: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
};
