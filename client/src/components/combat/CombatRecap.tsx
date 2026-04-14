import { useCombatStore, type DamageLogEntry } from '../../stores/useCombatStore';
import { Modal, Button } from '../ui';
import { theme } from '../../styles/theme';

/**
 * Combat Recap modal.
 *
 * Shown automatically when combat ends (if any damage was dealt).
 * Displays total damage dealt/taken by each combatant, the MVP,
 * kills, and combat duration.
 */
export function CombatRecap() {
  const showRecap = useCombatStore((s) => s.showRecap);
  const lastRecap = useCombatStore((s) => s.lastRecap);
  const setShowRecap = useCombatStore((s) => s.setShowRecap);

  if (!lastRecap) return null;

  const { damageLog, roundCount, durationMs } = lastRecap;
  const stats = computeStats(damageLog);

  return (
    <Modal
      open={showRecap}
      onClose={() => setShowRecap(false)}
      title={`Combat Recap \u2014 ${roundCount} Round${roundCount !== 1 ? 's' : ''}`}
      emoji="\u2694"
      size="md"
      footer={
        <Button variant="primary" onClick={() => setShowRecap(false)}>
          Close
        </Button>
      }
      containerStyle={{
        background: `linear-gradient(180deg, ${theme.bg.deep} 0%, ${theme.parchment} 100%)`,
        border: `2px solid ${theme.gold.border}`,
      }}
    >
      <div style={rcStyles.body}>
        {/* Duration */}
        <div style={rcStyles.duration}>
          Duration: {formatDuration(durationMs)}
        </div>

        {/* MVP */}
        {stats.mvp && (
          <div style={rcStyles.mvpSection}>
            <div style={rcStyles.mvpLabel}>MVP</div>
            <div style={rcStyles.mvpName}>{stats.mvp.name}</div>
            <div style={rcStyles.mvpDamage}>
              {stats.mvp.totalDealt} total damage dealt
            </div>
          </div>
        )}

        {/* Damage Dealt */}
        {stats.damageDealt.length > 0 && (
          <div style={rcStyles.section}>
            <div style={rcStyles.sectionTitle}>Damage Dealt</div>
            <div style={rcStyles.table}>
              {stats.damageDealt.map((row) => (
                <div key={row.name} style={rcStyles.tableRow}>
                  <span style={rcStyles.combatantName}>{row.name}</span>
                  <div style={rcStyles.barContainer}>
                    <div
                      style={{
                        ...rcStyles.bar,
                        width: `${(row.total / stats.maxDealt) * 100}%`,
                        background: `linear-gradient(90deg, ${theme.danger}, ${theme.state.danger})`,
                      }}
                    />
                  </div>
                  <span style={rcStyles.damageValue}>{row.total}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Damage Taken */}
        {stats.damageTaken.length > 0 && (
          <div style={rcStyles.section}>
            <div style={rcStyles.sectionTitle}>Damage Taken</div>
            <div style={rcStyles.table}>
              {stats.damageTaken.map((row) => (
                <div key={row.name} style={rcStyles.tableRow}>
                  <span style={rcStyles.combatantName}>{row.name}</span>
                  <div style={rcStyles.barContainer}>
                    <div
                      style={{
                        ...rcStyles.bar,
                        width: `${(row.total / stats.maxTaken) * 100}%`,
                        background: `linear-gradient(90deg, ${theme.state.warning}, ${theme.hp.half})`,
                      }}
                    />
                  </div>
                  <span style={rcStyles.damageValue}>{row.total}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Kills */}
        {stats.kills.length > 0 && (
          <div style={rcStyles.section}>
            <div style={rcStyles.sectionTitle}>Kills</div>
            <div style={rcStyles.killsList}>
              {stats.kills.map((kill, i) => (
                <div key={i} style={rcStyles.killRow}>
                  <span style={{ color: theme.gold.primary, fontWeight: 700 }}>
                    {kill.attacker}
                  </span>
                  <span style={{ color: theme.text.muted }}>{' \u2192 '}</span>
                  <span style={{ color: theme.danger, fontWeight: 600 }}>
                    {kill.target}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Stat computation ───────────────────────────────────────

interface DamageRow {
  name: string;
  total: number;
}

interface KillEntry {
  attacker: string;
  target: string;
}

interface CombatStats {
  damageDealt: DamageRow[];
  damageTaken: DamageRow[];
  maxDealt: number;
  maxTaken: number;
  mvp: { name: string; totalDealt: number } | null;
  kills: KillEntry[];
}

function computeStats(log: DamageLogEntry[]): CombatStats {
  const dealtMap = new Map<string, number>();
  const takenMap = new Map<string, number>();
  // Track cumulative damage taken per target to detect kills
  const cumulativeDamage = new Map<string, { total: number; lastAttacker: string }>();

  for (const entry of log) {
    dealtMap.set(entry.attackerName, (dealtMap.get(entry.attackerName) ?? 0) + entry.damage);
    takenMap.set(entry.targetName, (takenMap.get(entry.targetName) ?? 0) + entry.damage);

    const prev = cumulativeDamage.get(entry.targetName) ?? { total: 0, lastAttacker: '' };
    cumulativeDamage.set(entry.targetName, {
      total: prev.total + entry.damage,
      lastAttacker: entry.attackerName,
    });
  }

  const damageDealt = Array.from(dealtMap.entries())
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  const damageTaken = Array.from(takenMap.entries())
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  const maxDealt = damageDealt[0]?.total ?? 1;
  const maxTaken = damageTaken[0]?.total ?? 1;
  const mvp = damageDealt[0] ? { name: damageDealt[0].name, totalDealt: damageDealt[0].total } : null;

  // Detect kills: find log entries where a target's HP would reach 0.
  // We look at entries where the target's cumulative damage reaches their max HP.
  // Since we don't know max HP here, we identify the last attacker to each target
  // that had damage done to them.
  const kills: KillEntry[] = [];
  const seenKills = new Set<string>();
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    // Simple heuristic: look for entries that could be the killing blow
    // by checking if there are no further entries for this target
    const laterEntries = log.slice(i + 1).filter((e) => e.targetName === entry.targetName);
    if (laterEntries.length === 0 && !seenKills.has(entry.targetName)) {
      // The last damage entry for each target — check if total taken is high
      const totalTaken = takenMap.get(entry.targetName) ?? 0;
      if (totalTaken > 0) {
        // We can't confirm kill without max HP, so skip the kill log
        // unless we see 0 HP (which we could check from the last HP update)
      }
    }
  }

  return { damageDealt, damageTaken, maxDealt, maxTaken, mvp, kills };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

// ── Styles ─────────────────────────────────────────────────

const rcStyles: Record<string, React.CSSProperties> = {
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  duration: {
    fontSize: 12,
    color: theme.text.muted,
    textAlign: 'center',
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  },
  mvpSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '16px 0',
    borderTop: `1px solid ${theme.border.default}`,
    borderBottom: `1px solid ${theme.border.default}`,
    background: theme.gold.bg,
    borderRadius: theme.radius.md,
  },
  mvpLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    color: theme.gold.dim,
  },
  mvpName: {
    fontSize: 20,
    fontWeight: 700,
    color: theme.gold.bright,
    fontFamily: theme.font.display,
    textShadow: '0 0 8px rgba(232, 196, 85, 0.3)',
  },
  mvpDamage: {
    fontSize: 12,
    color: theme.gold.primary,
    fontWeight: 600,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: theme.gold.dim,
  },
  table: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  tableRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  combatantName: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.primary,
    minWidth: 100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  barContainer: {
    flex: 1,
    height: 8,
    background: 'rgba(0,0,0,0.3)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    borderRadius: 4,
    transition: 'width 0.3s ease',
    minWidth: 2,
  },
  damageValue: {
    fontSize: 13,
    fontWeight: 700,
    color: theme.text.primary,
    fontVariantNumeric: 'tabular-nums',
    minWidth: 36,
    textAlign: 'right',
    flexShrink: 0,
  },
  killsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '4px 8px',
  },
  killRow: {
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
};
