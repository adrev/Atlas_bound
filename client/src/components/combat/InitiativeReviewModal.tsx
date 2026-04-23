import { useEffect, useState } from 'react';
import { Swords, X } from 'lucide-react';
import type { Combatant } from '@dnd-vtt/shared';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitSetInitiative, emitLockInitiative, emitCancelReview, emitSetSurprise } from '../../socket/emitters';
import { theme } from '../../styles/theme';

/**
 * Initiative review modal. Shown for the DM while the combat store
 * is in `reviewPhase`. Server already rolled every combatant's d20 +
 * bonus and broadcast combat:started; the modal surfaces the full
 * breakdown (raw d20, bonus, total) and lets the DM hand-edit any
 * value before turns actually start advancing.
 *
 * Edits propagate via the existing `combat:set-initiative` event so
 * all clients stay in sync even before the DM commits. "Start Combat"
 * fires `combat:lock-initiative` — the server broadcasts
 * `combat:review-complete` and every client clears its review UI.
 * "Cancel" ends combat entirely (fires `combat:end`).
 *
 * Players see a lightweight waiting banner elsewhere (see
 * ReviewWaitingBanner below) — they don't need the editing surface.
 */
export function InitiativeReviewModal() {
  const reviewPhase = useCombatStore((s) => s.reviewPhase);
  const combatants = useCombatStore((s) => s.combatants);
  const isDM = useSessionStore((s) => s.isDM);

  // Sorted copy — descending by initiative total, ties broken by
  // initiativeBonus (DEX) then name so the table reads stably.
  const sorted = [...combatants].sort((a, b) =>
    b.initiative - a.initiative ||
    b.initiativeBonus - a.initiativeBonus ||
    a.name.localeCompare(b.name));

  if (!reviewPhase || !isDM) return null;
  return <ReviewCard combatants={sorted} />;
}

function ReviewCard({ combatants }: { combatants: Combatant[] }) {
  // Local draft of each combatant's total so the DM can type without
  // firing the socket on every keystroke. We flush the pending edits
  // into emitSetInitiative when the input loses focus.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(combatants.map((c) => [c.tokenId, String(c.initiative)])));

  // If the combatants list changes (e.g. DM adds one mid-review),
  // seed the new entries in the draft without overwriting the DM's
  // in-flight edits on existing rows.
  useEffect(() => {
    setDraft((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const c of combatants) {
        if (next[c.tokenId] === undefined) next[c.tokenId] = String(c.initiative);
      }
      return next;
    });
  }, [combatants]);

  const flush = (tokenId: string) => {
    const raw = draft[tokenId];
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const live = combatants.find((c) => c.tokenId === tokenId);
    if (!live) return;
    if (parsed === live.initiative) return;
    emitSetInitiative(tokenId, parsed);
  };

  const bump = (tokenId: string, delta: number) => {
    const current = parseInt(draft[tokenId] ?? '0', 10) || 0;
    const next = current + delta;
    setDraft((d) => ({ ...d, [tokenId]: String(next) }));
    emitSetInitiative(tokenId, next);
  };

  return (
    <div style={styles.backdrop}>
      <div style={styles.card} role="dialog" aria-label="Initiative review">
        <div style={styles.header}>
          <Swords size={18} color={theme.gold.primary} />
          <h2 style={styles.title}>Review Initiative</h2>
          <span style={styles.subtitle}>
            Round 1 — adjust any roll, then lock in
          </span>
        </div>

        <div style={styles.tableWrap}>
          <div style={styles.tableHeadRow}>
            <span style={{ ...styles.col, ...styles.colOrder }}>#</span>
            <span style={{ ...styles.col, ...styles.colName }}>Combatant</span>
            <span style={{ ...styles.col, ...styles.colRoll }}>Roll</span>
            <span style={{ ...styles.col, ...styles.colBonus }}>Bonus</span>
            <span style={{ ...styles.col, ...styles.colTotal }}>Total</span>
            <span style={{ ...styles.col, ...styles.colSurprise }} title="Skip first turn (ambush)">😱</span>
          </div>
          {combatants.map((c, i) => {
            // Prefer the structured breakdown when the server sent
            // one (combat-start emits it now). Fall back to deriving
            // from initiative - initiativeBonus for older combat
            // state that pre-dates the breakdown field.
            const breakdown = c.initiativeBreakdown;
            const d20 = breakdown?.d20 ?? (c.initiative - c.initiativeBonus);
            const advantage = breakdown?.advantage ?? 'normal';
            const d20Rolls = breakdown?.d20Rolls;
            const bonusStr = c.initiativeBonus >= 0
              ? `+${c.initiativeBonus}` : String(c.initiativeBonus);
            return (
              <div key={c.tokenId} style={styles.tableRow}>
                <span style={{ ...styles.col, ...styles.colOrder }}>{i + 1}</span>
                <span style={{ ...styles.col, ...styles.colName }}>
                  {c.portraitUrl ? (
                    <img
                      src={c.portraitUrl}
                      alt=""
                      style={styles.portrait}
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : (
                    <span style={{ ...styles.portrait, ...styles.portraitInitial }}>
                      {c.name[0] ?? '?'}
                    </span>
                  )}
                  <span style={styles.nameText}>{c.name}</span>
                  {!c.isNPC && <span style={styles.pcTag}>PC</span>}
                </span>
                <span style={{ ...styles.col, ...styles.colRoll }}>
                  <span
                    style={styles.d20Badge}
                    title={advantage !== 'normal' && d20Rolls
                      ? `${advantage} — rolled [${d20Rolls.join(', ')}], kept ${d20}`
                      : `d20 = ${d20}`}
                  >
                    {d20}
                  </span>
                  {advantage !== 'normal' && (
                    <span style={styles.advChip} title={`${advantage} on initiative`}>
                      {advantage === 'advantage' ? 'ADV' : 'DIS'}
                    </span>
                  )}
                </span>
                <span style={{ ...styles.col, ...styles.colBonus }}>
                  <span style={styles.bonusText}>{bonusStr}</span>
                  {c.hasAlert && !breakdown && (
                    <span style={styles.alertChip} title="Alert feat: +5 initiative">
                      ALERT
                    </span>
                  )}
                </span>
                <span style={{ ...styles.col, ...styles.colTotal }}>
                  <button
                    onClick={() => bump(c.tokenId, -1)}
                    style={styles.stepper}
                    aria-label={`Decrease ${c.name}'s initiative`}
                  >−</button>
                  <input
                    type="number"
                    value={draft[c.tokenId] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [c.tokenId]: e.target.value }))}
                    onBlur={() => flush(c.tokenId)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={styles.totalInput}
                  />
                  <button
                    onClick={() => bump(c.tokenId, 1)}
                    style={styles.stepper}
                    aria-label={`Increase ${c.name}'s initiative`}
                  >+</button>
                </span>
                <span style={{ ...styles.col, ...styles.colSurprise }}>
                  <input
                    type="checkbox"
                    checked={c.surprised === true}
                    disabled={c.hasAlert}
                    title={c.hasAlert
                      ? 'Alert feat: immune to surprise'
                      : c.surprised ? 'Surprised — skips first turn' : 'Mark as surprised'}
                    onChange={(e) => emitSetSurprise(c.tokenId, e.target.checked)}
                    style={styles.surpriseBox}
                  />
                </span>
                {/* Per-source modifier breakdown — one pill per source
                    (DEX, Alert, Jack of All Trades, Remarkable Athlete,
                    Rakish Audacity, Dread Ambusher, Sheet bonus, …).
                    Rendered as a second row under the main row so the
                    DM sees exactly what built the bonus and can decide
                    whether to hand-edit the total. Collapses when the
                    combatant has no breakdown (pre-feature combats). */}
                {breakdown && breakdown.modifiers.length > 0 && (
                  <div style={styles.breakdownRow}>
                    {breakdown.modifiers.map((m, idx) => (
                      <span key={idx} style={styles.modPill}>
                        <span style={styles.modLabel}>{m.label}</span>
                        <span style={{
                          ...styles.modValue,
                          color: m.value >= 0 ? theme.state.success : theme.state.danger,
                        }}>
                          {m.value >= 0 ? '+' : ''}{m.value}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={styles.footer}>
          <button
            onClick={() => {
              // Bail out of the review cleanly — the server tears
              // down combat state the same way end-combat would, but
              // WITHOUT the post-battle ritual (no XP summary, no
              // Discord notification, no recap modal). Lets the DM
              // redo token setup / HP before re-rolling initiative.
              emitCancelReview();
            }}
            style={styles.cancelBtn}
          >
            <X size={14} /> Cancel Combat
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => {
              // Flush any unsent text edits before locking.
              for (const c of combatants) flush(c.tokenId);
              emitLockInitiative();
            }}
            style={styles.startBtn}
          >
            <Swords size={14} /> Start Combat
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Small sticky banner rendered at the top of the canvas while combat
 * is in `reviewPhase` for non-DM players. They can't edit anything —
 * this is just a "the DM is setting initiative, hang on" signal so
 * they don't think the app has frozen while the DM is typing.
 */
export function ReviewWaitingBanner() {
  const reviewPhase = useCombatStore((s) => s.reviewPhase);
  const isDM = useSessionStore((s) => s.isDM);
  if (!reviewPhase || isDM) return null;
  return (
    <div style={styles.waitingBanner}>
      <Swords size={14} color={theme.gold.primary} />
      <span>Initiative rolled — DM is reviewing the order…</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(4,4,8,0.65)',
    backdropFilter: 'blur(2px)',
    zIndex: 300,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: 600,
    maxWidth: '100%',
    maxHeight: '85vh',
    overflowY: 'auto',
    background: `linear-gradient(180deg, ${theme.bg.deepest} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.lg,
    boxShadow: '0 20px 60px rgba(0,0,0,0.55), 0 0 40px rgba(232,196,85,0.1)',
    padding: '16px 18px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    margin: 0,
    fontFamily: theme.font.display,
    fontSize: 18,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: theme.gold.primary,
  },
  subtitle: {
    fontSize: 11,
    color: theme.text.muted,
    marginLeft: 'auto',
    fontStyle: 'italic',
  },
  tableWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    background: theme.border.default,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  tableHeadRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    background: theme.bg.deep,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: theme.gold.dim,
  },
  tableRow: {
    display: 'flex',
    alignItems: 'center',
    // Wrap so the per-source modifier row drops below the main row
    // without clipping on narrow screens.
    flexWrap: 'wrap' as const,
    rowGap: 6,
    padding: '8px 10px',
    background: theme.bg.elevated,
    color: theme.text.primary,
  },
  breakdownRow: {
    // Full-width second row; pushes below the columnar main row by
    // taking 100% of the flex line. Renders the per-source modifier
    // pills so the DM can scan what built the bonus.
    width: '100%',
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    paddingLeft: 36, // align under the combatant name
    marginTop: 2,
  },
  modPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 6px',
    borderRadius: 10,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    fontSize: 9,
    fontFamily: 'monospace',
  },
  modLabel: {
    color: theme.text.muted,
    letterSpacing: '0.04em',
  },
  modValue: {
    fontWeight: 700,
  },
  advChip: {
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: theme.gold.primary,
    background: 'rgba(232,196,85,0.14)',
    border: `1px solid ${theme.gold.border}`,
    padding: '1px 4px',
    borderRadius: 3,
    marginLeft: 4,
  },
  col: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  colOrder: {
    width: 24,
    justifyContent: 'center',
    color: theme.text.muted,
    fontSize: 11,
    fontWeight: 700,
  },
  colName: {
    flex: 1,
    gap: 8,
  },
  colRoll: { width: 58, justifyContent: 'center' },
  colBonus: { width: 94, justifyContent: 'center', gap: 4 },
  colTotal: { width: 128, justifyContent: 'flex-end', gap: 4 },
  colSurprise: { width: 28, justifyContent: 'center' },
  portrait: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    objectFit: 'cover',
    border: `1px solid ${theme.gold.border}`,
    flexShrink: 0,
  },
  portraitInitial: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.deep,
    color: theme.gold.primary,
    fontSize: 12,
    fontWeight: 700,
  },
  nameText: {
    fontSize: 12,
    fontWeight: 600,
  },
  pcTag: {
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: theme.state.success,
    background: 'rgba(39,174,96,0.15)',
    border: '1px solid rgba(39,174,96,0.35)',
    padding: '1px 5px',
    borderRadius: 3,
  },
  d20Badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 22,
    borderRadius: theme.radius.sm,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'monospace',
  },
  bonusText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: theme.text.secondary,
  },
  alertChip: {
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: theme.gold.primary,
    background: 'rgba(232,196,85,0.14)',
    border: `1px solid ${theme.gold.border}`,
    padding: '1px 5px',
    borderRadius: 3,
    flexShrink: 0,
  },
  totalInput: {
    width: 52,
    textAlign: 'center',
    background: theme.bg.deep,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.gold.primary,
    fontSize: 13,
    fontWeight: 700,
    fontFamily: 'monospace',
    padding: '4px 4px',
    outline: 'none',
  },
  stepper: {
    width: 22,
    height: 22,
    padding: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
  },
  surpriseBox: {
    width: 16,
    height: 16,
    cursor: 'pointer',
    accentColor: theme.gold.primary,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
  },
  cancelBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    background: 'transparent',
    color: theme.text.muted,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    fontFamily: theme.font.body,
  },
  startBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 18px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: theme.bg.base,
    background: theme.gold.primary,
    border: `1px solid ${theme.gold.primary}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    fontFamily: theme.font.display,
    boxShadow: '0 0 18px rgba(232,196,85,0.4)',
  },
  waitingBanner: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    color: theme.gold.primary,
    background: 'rgba(10,8,6,0.85)',
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    backdropFilter: 'blur(6px)',
    zIndex: 50,
    pointerEvents: 'none',
  },
};
