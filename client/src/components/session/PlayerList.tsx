import { Crown, User, Wifi, WifiOff } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { theme } from '../../styles/theme';

export function PlayerList() {
  const players = useSessionStore((s) => s.players);
  const isDM = useSessionStore((s) => s.isDM);

  return (
    <div style={styles.container}>
      <h3 style={styles.heading}>
        Players ({players.length})
      </h3>
      <div style={styles.list}>
        {players.map((player) => (
          <div key={player.userId} style={styles.player}>
            <div style={styles.avatar}>
              {player.avatarUrl ? (
                <img
                  src={player.avatarUrl}
                  alt={player.displayName}
                  style={styles.avatarImg}
                />
              ) : (
                <User size={18} color={theme.text.secondary} />
              )}
            </div>
            <div style={styles.info}>
              <div style={styles.nameRow}>
                <span style={styles.name}>{player.displayName}</span>
                {player.role === 'dm' && (
                  <span style={styles.dmBadge}>
                    <Crown size={10} />
                    DM
                  </span>
                )}
              </div>
              <div style={styles.status}>
                {player.connected ? (
                  <Wifi size={12} color={theme.heal} />
                ) : (
                  <WifiOff size={12} color={theme.text.muted} />
                )}
                <span
                  style={{
                    fontSize: 11,
                    color: player.connected
                      ? theme.text.secondary
                      : theme.text.muted,
                  }}
                >
                  {player.connected ? 'Online' : 'Offline'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {isDM && players.length <= 1 && (
        <p style={styles.hint}>
          Share the room code with your players to invite them.
        </p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
  },
  heading: {
    fontSize: 14,
    fontWeight: 600,
    color: theme.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: '1px',
    margin: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  player: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 12px',
    borderRadius: theme.radius.md,
    transition: 'background 0.15s ease',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    fontSize: 14,
    fontWeight: 500,
    color: theme.text.primary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dmBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    background: theme.gold.bg,
    color: theme.gold.primary,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  hint: {
    fontSize: 12,
    color: theme.text.muted,
    fontStyle: 'italic',
    margin: 0,
    padding: '8px 12px',
  },
};
