import { Sword, Zap, Footprints, Shield } from 'lucide-react';
import { useCombatStore } from '../../stores/useCombatStore';
import { theme } from '../../styles/theme';

export function ActionEconomy() {
  const economy = useCombatStore((s) => s.actionEconomy);

  const items = [
    {
      label: 'Action',
      icon: <Sword size={16} />,
      used: economy.action,
      color: '#e74c3c',
    },
    {
      label: 'Bonus',
      icon: <Zap size={16} />,
      used: economy.bonusAction,
      color: '#f39c12',
    },
    {
      label: `${economy.movementRemaining}ft`,
      icon: <Footprints size={16} />,
      used: economy.movementRemaining <= 0,
      color: '#3498db',
      isMovement: true,
    },
    {
      label: 'Reaction',
      icon: <Shield size={16} />,
      used: economy.reaction,
      color: '#9b59b6',
    },
  ];

  return (
    <div style={styles.container}>
      {items.map((item) => {
        const movementRatio = item.isMovement
          ? economy.movementMax > 0
            ? economy.movementRemaining / economy.movementMax
            : 0
          : undefined;

        return (
          <div
            key={item.label}
            style={{
              ...styles.item,
              opacity: item.used ? 0.35 : 1,
            }}
          >
            <div
              style={{
                ...styles.iconWrapper,
                borderColor: item.used ? theme.border.default : item.color,
                background: item.used
                  ? theme.bg.deep
                  : `${item.color}15`,
              }}
            >
              <span style={{ color: item.used ? theme.text.muted : item.color }}>
                {item.icon}
              </span>
            </div>
            <span
              style={{
                ...styles.label,
                color: item.used ? theme.text.muted : theme.text.secondary,
              }}
            >
              {item.label}
            </span>
            {/* Movement bar */}
            {item.isMovement && movementRatio !== undefined && (
              <div style={styles.moveBarBg}>
                <div
                  style={{
                    ...styles.moveBarFill,
                    width: `${movementRatio * 100}%`,
                    background: item.color,
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    gap: 12,
    padding: '8px 12px',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    transition: 'opacity 0.2s ease',
    minWidth: 52,
  },
  iconWrapper: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '2px solid',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease',
  },
  label: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  moveBarBg: {
    width: 40,
    height: 3,
    background: 'rgba(0,0,0,0.4)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  moveBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
};
