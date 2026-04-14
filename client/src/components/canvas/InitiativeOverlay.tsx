import { useState } from 'react';
import { useCombatStore } from '../../stores/useCombatStore';
import { useMapStore } from '../../stores/useMapStore';
import { theme } from '../../styles/theme';

/**
 * Floating mini initiative tracker rendered as an HTML overlay on top
 * of the Konva canvas. Shows a horizontal strip of small circular
 * portraits/initials in initiative order with HP bars underneath.
 *
 * Clicking a combatant dispatches `canvas-center-on` to pan the camera
 * to their token — same mechanism as the sidebar InitiativeTracker.
 */
export function InitiativeOverlay() {
  const combatants = useCombatStore((s) => s.combatants);
  const currentTurnIndex = useCombatStore((s) => s.currentTurnIndex);
  const roundNumber = useCombatStore((s) => s.roundNumber);
  const active = useCombatStore((s) => s.active);
  const [tooltip, setTooltip] = useState<{ name: string; x: number; y: number } | null>(null);

  if (!active || combatants.length === 0) return null;

  return (
    <div style={styles.wrapper}>
      <div style={styles.container}>
        {/* Round badge */}
        <div style={styles.roundBadge}>R{roundNumber}</div>

        {/* Combatant circles */}
        {combatants.map((c, index) => {
          const isCurrent = index === currentTurnIndex;
          const hpRatio = c.maxHp > 0 ? Math.max(0, c.hp / c.maxHp) : 1;
          const hpColor =
            hpRatio > 0.5 ? theme.hp.full : hpRatio > 0.25 ? theme.hp.half : theme.hp.low;
          const isDown = c.hp <= 0;

          return (
            <div
              key={c.tokenId}
              style={styles.combatantCell}
              onClick={() => {
                useMapStore.getState().selectToken(c.tokenId);
                window.dispatchEvent(
                  new CustomEvent('canvas-center-on', {
                    detail: { tokenId: c.tokenId },
                  }),
                );
              }}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltip({
                  name: `${c.name} (HP ${c.hp}/${c.maxHp} | AC ${c.armorClass})`,
                  x: rect.left + rect.width / 2,
                  y: rect.bottom + 4,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Portrait circle */}
              <div
                style={{
                  ...styles.circle,
                  borderColor: isCurrent ? theme.gold.primary : theme.border.default,
                  boxShadow: isCurrent ? `0 0 6px ${theme.gold.primary}` : 'none',
                  opacity: isDown ? 0.4 : 1,
                  filter: isDown ? 'grayscale(0.7)' : 'none',
                }}
              >
                {c.portraitUrl ? (
                  <img src={c.portraitUrl} alt={c.name} style={styles.portraitImg} />
                ) : (
                  <span style={styles.initial}>{c.name.charAt(0).toUpperCase()}</span>
                )}
              </div>

              {/* HP bar */}
              <div style={styles.hpBarBg}>
                <div
                  style={{
                    ...styles.hpBarFill,
                    width: `${hpRatio * 100}%`,
                    background: hpColor,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            ...styles.tooltip,
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          {tooltip.name}
        </div>
      )}
    </div>
  );
}

const CIRCLE_SIZE = 36;

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 40,
    pointerEvents: 'none',
  },
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    background: 'rgba(10, 10, 18, 0.8)',
    backdropFilter: 'blur(8px)',
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.border.default}`,
    pointerEvents: 'auto',
  },
  roundBadge: {
    fontSize: 10,
    fontWeight: 800,
    color: theme.gold.primary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    paddingRight: 4,
    borderRight: `1px solid ${theme.border.default}`,
    marginRight: 2,
    whiteSpace: 'nowrap' as const,
  },
  combatantCell: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 3,
    cursor: 'pointer',
  },
  circle: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: '50%',
    border: '2px solid',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.elevated,
    transition: `all ${theme.motion.fast}`,
    flexShrink: 0,
  },
  portraitImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  initial: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.text.secondary,
  },
  hpBarBg: {
    width: CIRCLE_SIZE,
    height: 3,
    background: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  hpBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: `width ${theme.motion.slow}`,
  },
  tooltip: {
    position: 'fixed' as const,
    transform: 'translateX(-50%)',
    background: 'rgba(10, 10, 18, 0.92)',
    color: theme.text.primary,
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 8px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    whiteSpace: 'nowrap' as const,
    pointerEvents: 'none' as const,
    zIndex: 999,
  },
};
