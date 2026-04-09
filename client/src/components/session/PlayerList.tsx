import { Crown, User, Wifi, WifiOff } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { theme } from '../../styles/theme';
import { HPBar } from '../ui';

export function PlayerList() {
  const players = useSessionStore((s) => s.players);
  const isDM = useSessionStore((s) => s.isDM);
  const allCharacters = useCharacterStore((s) => s.allCharacters);

  return (
    <div style={styles.container}>
      <h3 style={styles.heading}>
        Players ({players.length})
      </h3>
      <div style={styles.list}>
        {players.map((player) => {
          const char = player.characterId
            ? allCharacters[player.characterId]
            : null;
          return (
            <div key={player.userId} style={styles.player}>
              {/* Avatar — prefer character portrait */}
              <div style={styles.avatar}>
                {char?.portraitUrl ? (
                  <img
                    src={char.portraitUrl}
                    alt={char.name}
                    style={styles.avatarImg}
                  />
                ) : player.avatarUrl ? (
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
                {/* Row 1: player name + DM badge */}
                <div style={styles.nameRow}>
                  <span style={styles.name}>
                    {char?.name ?? player.displayName}
                  </span>
                  {player.role === 'dm' && (
                    <span style={styles.dmBadge}>
                      <Crown size={10} />
                      DM
                    </span>
                  )}
                </div>

                {/* Row 2: class/race info if character linked */}
                {char && (
                  <div style={styles.charInfo}>
                    {char.race} {char.class} • Lv {char.level}
                  </div>
                )}

                {/* Row 3: HP bar if character linked */}
                {char && (
                  <div style={styles.hpRow}>
                    <HPBar
                      current={char.hitPoints}
                      max={char.maxHitPoints}
                      size="compact"
                      showNumeric={false}
                    />
                    <span style={styles.hpLabel}>
                      {char.hitPoints}/{char.maxHitPoints}
                    </span>
                  </div>
                )}

                {/* Row 4: connection status */}
                <div style={styles.status}>
                  {player.connected ? (
                    <Wifi size={11} color={theme.state.success} />
                  ) : (
                    <WifiOff size={11} color={theme.text.muted} />
                  )}
                  <span
                    style={{
                      fontSize: 10,
                      color: player.connected
                        ? theme.text.muted
                        : theme.text.muted,
                    }}
                  >
                    {player.connected ? 'Online' : 'Offline'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
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
    gap: 6,
  },
  player: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '10px 12px',
    borderRadius: theme.radius.md,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    transition: 'background 0.15s ease',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    background: theme.bg.elevated,
    border: `2px solid ${theme.gold.border}`,
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
    gap: 3,
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    fontSize: 13,
    fontWeight: 600,
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
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    background: theme.gold.bg,
    color: theme.gold.primary,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
  },
  charInfo: {
    fontSize: 10,
    color: theme.text.muted,
  },
  hpRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  hpLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: theme.text.muted,
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  hint: {
    fontSize: 12,
    color: theme.text.muted,
    fontStyle: 'italic',
    margin: 0,
    padding: '8px 12px',
  },
};
