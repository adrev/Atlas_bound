import { Hotbar } from '../hotbar/Hotbar';
import { DiceTray } from '../dice/DiceTray';
import { theme } from '../../styles/theme';

export function BottomBar() {
  return (
    <div style={styles.container}>
      <div style={styles.hotbarSection}>
        <Hotbar />
      </div>
      <div style={styles.divider} />
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
    padding: '0 12px',
    gap: 12,
  },
  hotbarSection: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  divider: {
    width: 1,
    height: 48,
    background: theme.border.default,
    flexShrink: 0,
  },
  diceSection: {
    flexShrink: 0,
  },
};
