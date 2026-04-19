import { useState, useEffect, useRef, useCallback } from 'react';
import { SkipForward, X } from 'lucide-react';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { emitNextTurn, emitEndCombat } from '../../socket/emitters';
import { ActionEconomy } from './ActionEconomy';
import { theme } from '../../styles/theme';

export function InitiativeTracker() {
  const combatants = useCombatStore((s) => s.combatants);
  const currentTurnIndex = useCombatStore((s) => s.currentTurnIndex);
  const roundNumber = useCombatStore((s) => s.roundNumber);
  const active = useCombatStore((s) => s.active);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const tokens = useMapStore((s) => s.tokens);
  const settings = useSessionStore((s) => s.settings);
  const turnTimerEnabled = !!settings.turnTimerEnabled;
  const turnTimerSeconds = settings.turnTimerSeconds ?? 60;
  // Default to "visible" when the setting has never been set.
  const showCreatureStats = settings.showCreatureStatsToPlayers !== false;
  const showPlayerStats = settings.showPlayersToPlayers !== false;

  if (!active || combatants.length === 0) return null;

  const currentCombatant = combatants[currentTurnIndex];
  // The current turn's token owner can also end their own turn now (the
  // server-side check matches). Used to be DM-only.
  const currentToken = currentCombatant ? tokens[currentCombatant.tokenId] : null;
  const isCurrentOwner = currentToken?.ownerUserId === userId;
  const isMyTurn = isDM || isCurrentOwner;

  // For each combatant row, whether the caller is allowed to see its
  // HP numbers + initiative value. DM always sees all; a PC's owner
  // always sees their own row; otherwise gated by session settings.
  const canSeeStatsFor = (combatantTokenId: string): boolean => {
    if (isDM) return true;
    const token = tokens[combatantTokenId];
    if (!token) return true;
    const isOwn = token.ownerUserId === userId;
    if (isOwn) return true;
    // If the combatant has a human owner, it's another player's PC
    // — gated by showPlayersToPlayers. Otherwise it's an NPC — gated
    // by showCreatureStatsToPlayers.
    const isAnotherPC = !!token.ownerUserId;
    return isAnotherPC ? showPlayerStats : showCreatureStats;
  };

  return (
    <div style={styles.container}>
      {/* Round counter */}
      <div style={styles.header}>
        <span style={styles.roundLabel}>Round {roundNumber}</span>
        {isDM && (
          <button
            className="btn-icon"
            onClick={() => emitEndCombat()}
            title="End Combat"
            style={{ color: theme.danger }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Initiative list — vertical so we can see the whole turn order
          at a glance and each combatant row has room for HP + init +
          name on one line. */}
      <div style={styles.list}>
        {combatants.map((combatant, index) => {
          const isCurrent = index === currentTurnIndex;
          const showStats = canSeeStatsFor(combatant.tokenId);
          const hpRatio = combatant.maxHp > 0 ? combatant.hp / combatant.maxHp : 1;
          const hpColor =
            hpRatio > 0.5 ? theme.hp.full : hpRatio > 0.25 ? theme.hp.half : theme.hp.low;
          const isDown = combatant.hp <= 0;

          return (
            <div
              key={combatant.tokenId}
              onClick={() => {
                // Select the token AND pan the camera to it. BattleMap
                // listens for 'canvas-center-on' and moves the viewport
                // at the current zoom level so the party can instantly
                // jump to the active combatant.
                useMapStore.getState().selectToken(combatant.tokenId);
                window.dispatchEvent(new CustomEvent('canvas-center-on', {
                  detail: { tokenId: combatant.tokenId },
                }));
              }}
              title={showStats
                ? `${combatant.name} — Initiative ${combatant.initiative} • HP ${combatant.hp}/${combatant.maxHp} • AC ${combatant.armorClass}\nClick to jump camera to this combatant`
                : `${combatant.name}\nClick to jump camera to this combatant`}
              style={{
                ...styles.row,
                ...(isCurrent ? styles.rowActive : {}),
                ...(isDown ? styles.rowDown : {}),
              }}
            >
              {/* Initiative number on the left. Hidden from other
                  players when the DM has gated that combatant's stats
                  — the turn order itself is unchanged, but the numeric
                  roll is private info. */}
              <div
                style={{
                  ...styles.initBadge,
                  color: isCurrent ? theme.gold.primary : theme.text.secondary,
                  borderColor: isCurrent ? theme.gold.primary : theme.border.default,
                }}
              >
                {showStats ? combatant.initiative : '•'}
              </div>

              {/* Portrait */}
              <div
                style={{
                  ...styles.rowPortrait,
                  borderColor: isCurrent ? theme.gold.primary : theme.border.default,
                }}
              >
                {combatant.portraitUrl ? (
                  <img
                    src={combatant.portraitUrl}
                    alt={combatant.name}
                    style={styles.portraitImg}
                    // P8 — if the portrait URL 404s (PC never uploaded
                    // an avatar, NPC missing from GCS), collapse the
                    // <img> and let the initial fallback show through.
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <span style={styles.portraitInitial}>
                    {combatant.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>

              {/* Name + HP bar stacked on the right. When stats are
                  hidden the HP numbers become "??" but the bar still
                  animates so the party can see a target is "bloodied"
                  vs "fresh" without the exact numbers — matches the
                  typical pen-and-paper DM narration style. */}
              <div style={styles.rowInfo}>
                <span
                  style={{
                    ...styles.rowName,
                    color: isCurrent ? theme.gold.primary : theme.text.primary,
                  }}
                >
                  {combatant.name}
                </span>
                <div style={styles.hpRow}>
                  <div style={styles.hpBarBg}>
                    <div
                      style={{
                        ...styles.hpBarFill,
                        width: `${Math.max(0, hpRatio * 100)}%`,
                        background: hpColor,
                      }}
                    />
                  </div>
                  <span style={styles.hpText}>
                    {showStats ? `${combatant.hp}/${combatant.maxHp}` : '??'}
                  </span>
                </div>
              </div>

              {/* Turn timer for current combatant */}
              {isCurrent && turnTimerEnabled && (
                <TurnTimer
                  durationSeconds={turnTimerSeconds}
                  currentTurnIndex={currentTurnIndex}
                  roundNumber={roundNumber}
                  isDM={isDM}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Action economy for current turn */}
      {isMyTurn && <ActionEconomy />}

      {/* End turn button */}
      {isMyTurn && (
        <button
          className="btn-primary"
          onClick={() => emitNextTurn()}
          style={{ margin: '8px 12px', width: 'calc(100% - 24px)' }}
        >
          <SkipForward size={16} />
          End Turn
        </button>
      )}
    </div>
  );
}

// ── Turn Timer ─────────────────────────────────────────────
function TurnTimer({
  durationSeconds,
  currentTurnIndex,
  roundNumber,
  isDM,
}: {
  durationSeconds: number;
  currentTurnIndex: number;
  roundNumber: number;
  isDM: boolean;
}) {
  const [secondsLeft, setSecondsLeft] = useState(durationSeconds);
  const [paused, setPaused] = useState(false);
  const [timesUp, setTimesUp] = useState(false);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef(Date.now());

  // Reset timer when the turn changes
  useEffect(() => {
    setSecondsLeft(durationSeconds);
    setPaused(false);
    setTimesUp(false);
    startRef.current = Date.now();
  }, [currentTurnIndex, roundNumber, durationSeconds]);

  // Tick the timer
  useEffect(() => {
    if (paused || timesUp) return;
    timerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      const remaining = Math.max(0, durationSeconds - elapsed);
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        setTimesUp(true);
        if (timerRef.current) window.clearInterval(timerRef.current);
      }
    }, 100);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [paused, timesUp, durationSeconds]);

  const handleClick = useCallback(() => {
    if (!isDM) return;
    if (timesUp) return;
    if (paused) {
      // Resume — adjust startRef so elapsed time is preserved
      startRef.current = Date.now() - (durationSeconds - secondsLeft) * 1000;
      setPaused(false);
    } else {
      setPaused(true);
    }
  }, [isDM, paused, timesUp, durationSeconds, secondsLeft]);

  const ratio = secondsLeft / durationSeconds;
  const circumference = 2 * Math.PI * 14;
  const offset = circumference * (1 - ratio);
  const ringColor =
    ratio > 0.5 ? theme.state.success :
    ratio > 0.25 ? theme.state.warning :
    theme.state.danger;

  return (
    <div
      onClick={handleClick}
      title={isDM ? (paused ? 'Click to resume' : 'Click to pause') : undefined}
      style={{
        position: 'relative',
        width: 36,
        height: 36,
        flexShrink: 0,
        cursor: isDM ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width={36} height={36} viewBox="0 0 36 36">
        <circle
          cx={18} cy={18} r={14}
          fill="none"
          stroke={theme.border.default}
          strokeWidth={3}
        />
        <circle
          cx={18} cy={18} r={14}
          fill="none"
          stroke={ringColor}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 18 18)"
          style={{ transition: 'stroke-dashoffset 0.1s linear, stroke 0.3s ease' }}
        />
      </svg>
      <span style={{
        position: 'absolute',
        fontSize: timesUp ? 7 : 10,
        fontWeight: 700,
        color: timesUp ? theme.state.danger : theme.text.primary,
        fontFamily: 'monospace',
        textAlign: 'center',
        animation: timesUp ? 'timerFlash 0.5s ease-in-out 3' : undefined,
      }}>
        {timesUp ? "TIME!" : Math.ceil(secondsLeft)}
      </span>
      {paused && (
        <span style={{
          position: 'absolute',
          bottom: -2,
          fontSize: 6,
          fontWeight: 700,
          color: theme.state.warning,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}>
          PAUSED
        </span>
      )}
      <style>{`
        @keyframes timerFlash {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 0',
    // Fill the parent initiativeSection (max 45vh) so the inner list
    // can take whatever vertical space is left after the header /
    // action economy / end turn button and scroll inside that area.
    maxHeight: '100%',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
  },
  roundLabel: {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1px',
    color: theme.gold.primary,
  },
  /* Vertical list of combatants. The parent `initiativeSection` in
     Sidebar.tsx caps the whole tracker at ~45% of the viewport and
     scrolls the overflow, so we don't need our own inner scroll
     anymore — keeping the list unconstrained means the action economy
     and End Turn button stay pinned to the bottom of whatever is
     visible. */
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '4px 8px',
  },
  /* Single row per combatant: [init] [portrait] [name + hp] */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: theme.radius.md,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    background: 'transparent',
  },
  rowActive: {
    background: theme.gold.bg,
    boxShadow: `inset 0 0 0 1px ${theme.gold.primary}`,
  },
  rowDown: {
    opacity: 0.4,
    filter: 'grayscale(0.7)',
  },
  /* Large, clearly visible initiative number on the left side */
  initBadge: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: '2px solid',
    background: theme.bg.deep,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 800,
    flexShrink: 0,
  },
  rowPortrait: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '2px solid',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.elevated,
    flexShrink: 0,
  },
  portraitImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  portraitInitial: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.text.secondary,
  },
  rowInfo: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  rowName: {
    fontSize: 12,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hpRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  hpBarBg: {
    flex: 1,
    height: 4,
    background: 'rgba(0,0,0,0.4)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  hpBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  hpText: {
    fontSize: 9,
    fontWeight: 600,
    color: theme.text.muted,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
};
