import type { CSSProperties } from 'react';
import type { SaveBreakdown } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

/**
 * Single-d20 save breakdown card. Covers:
 *   • Concentration saves triggered by incoming damage
 *   • Death saves at 0 HP (DC 10 implied, crit / fumble rules)
 *   • Standalone `!save <ability> <DC>` rolls
 *   • End-of-turn spell retry saves (Hold Person, Hideous Laughter)
 *
 * Layout:
 *   Header:  💪 Roller — Context (e.g. "Concentration on Fireball")
 *   d20 face + advantage rolls + per-source modifier list
 *   Total vs DC (or "DC 10 (death)" for death saves)
 *   Outcome chip: PASSED / FAILED / STABILIZED / DEAD
 *   Notes + spell-specific footer (concentration drop / death-save
 *   successes-failures counter)
 */
export function SaveResultCard({ result }: { result: SaveBreakdown }) {
  const critSuccess = !!result.deathSave?.critSuccess;
  const critFailure = !!result.deathSave?.critFailure;
  const stabilized = !!result.deathSave?.stabilized;
  const dead = !!result.deathSave?.dead;

  const accent =
    dead ? '#6b1d1d' :
    stabilized || critSuccess ? '#27ae60' :
    critFailure ? '#e74c3c' :
    result.passed ? '#9b59b6' :
    '#c0392b';

  const bg =
    dead ? 'rgba(107,29,29,0.1)' :
    stabilized || critSuccess ? 'rgba(39,174,96,0.06)' :
    critFailure ? 'rgba(192,57,43,0.06)' :
    result.passed ? 'rgba(155,89,182,0.06)' :
    'rgba(192,57,43,0.04)';

  // Icon per context kind — concentration is a brain, death save is
  // a skull, generic save is the muscle emoji.
  const icon =
    result.concentration ? '\uD83E\uDDE0' :
    result.ability === 'death' ? '\u2620\uFE0F' :
    '\uD83D\uDCAA';

  const outcomeLabel =
    dead ? 'DEAD' :
    stabilized ? 'STABILIZED' :
    critSuccess ? 'NAT 20 — 1 HP' :
    critFailure ? 'NAT 1 — 2 FAILURES' :
    result.passed ? (result.concentration ? 'MAINTAINED' : 'PASSED') :
    (result.concentration ? 'DROPPED' : 'FAILED');

  const outcomeChip: CSSProperties = {
    padding: '2px 10px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    background: accent + '22',
    color: accent,
    border: `1px solid ${accent}66`,
  };

  return (
    <div
      style={{
        background: bg,
        borderLeft: `3px solid ${accent}`,
        borderRadius: theme.radius.md,
        padding: '10px 12px',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text.primary }}>
          {icon} {result.roller.name}
        </span>
        <span style={{ fontSize: 11, color: theme.text.muted }}>—</span>
        <span style={{ fontSize: 11, color: theme.gold.dim, fontStyle: 'italic' }}>
          {result.context}
        </span>
        <span style={{ flex: 1 }} />
        <span style={outcomeChip}>{outcomeLabel}</span>
      </div>

      {/* d20 + modifier list */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <D20Face
          value={result.d20}
          isNat20={result.d20 === 20}
          isNat1={result.d20 === 1}
        />
        {result.d20Rolls && result.d20Rolls.length > 1 && (
          <span style={{ fontSize: 10, color: theme.text.muted, fontFamily: 'monospace' }}>
            ({result.advantage === 'advantage' ? 'adv' : 'disadv'}: {result.d20Rolls.join(', ')} → kept {result.d20})
          </span>
        )}
      </div>

      {result.modifiers.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {result.modifiers.map((m, i) => {
            const sign = m.value >= 0 ? '+' : '\u2212';
            const abs = Math.abs(m.value);
            return (
              <li key={i} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '2px 0', fontSize: 11,
              }}>
                <span style={{ fontSize: 9, color: accent }}>●</span>
                <span style={{ flex: 1, color: theme.text.secondary }}>{m.label}</span>
                <span style={{
                  fontFamily: 'monospace', fontWeight: 700,
                  color: m.value >= 0 ? '#2ecc71' : '#e74c3c',
                }}>
                  {sign}{abs}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Total vs DC */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        marginTop: 6, paddingTop: 6,
        borderTop: `1px dashed ${theme.border.default}`,
      }}>
        <span style={{ fontSize: 10, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Total
        </span>
        <span style={{
          fontSize: 20, fontWeight: 700, color: accent,
          fontFamily: theme.font.display, lineHeight: 1,
        }}>
          {result.total < -100 ? '—' : result.total}
        </span>
        {result.dc != null && (
          <>
            <span style={{ fontSize: 10, color: theme.text.muted }}>vs DC</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: theme.text.primary }}>
              {result.dc}
            </span>
          </>
        )}
        {result.ability === 'death' && result.dc == null && (
          <span style={{ fontSize: 10, color: theme.text.muted }}>vs DC 10</span>
        )}
      </div>

      {/* Death-save counter */}
      {result.deathSave && (
        <div style={{
          marginTop: 6, display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 11, fontFamily: 'monospace',
        }}>
          <span style={{ color: '#27ae60', fontWeight: 700 }}>
            {'\u2713'.repeat(result.deathSave.successes)}
            <span style={{ color: theme.text.muted }}>
              {'\u2713'.repeat(Math.max(0, 3 - result.deathSave.successes))}
            </span>
          </span>
          <span style={{ color: theme.text.muted }}>successes</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: '#e74c3c', fontWeight: 700 }}>
            {'\u2717'.repeat(result.deathSave.failures)}
            <span style={{ color: theme.text.muted }}>
              {'\u2717'.repeat(Math.max(0, 3 - result.deathSave.failures))}
            </span>
          </span>
          <span style={{ color: theme.text.muted }}>failures</span>
        </div>
      )}

      {/* Concentration footer */}
      {result.concentration && (
        <div style={{
          marginTop: 6, padding: '4px 8px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: theme.radius.sm,
          fontSize: 11, color: theme.text.secondary,
        }}>
          {result.concentration.dropped
            ? <span>⚡ Concentration on <strong>{result.concentration.spellName}</strong> dropped ({result.concentration.damageAmount} damage taken).</span>
            : <span>🎯 Concentration on <strong>{result.concentration.spellName}</strong> maintained ({result.concentration.damageAmount} damage taken).</span>}
          {result.concentration.warCaster && (
            <span style={{ marginLeft: 6, color: theme.gold.dim, fontStyle: 'italic' }}>
              (War Caster adv.)
            </span>
          )}
        </div>
      )}

      {/* Per-line notes */}
      {result.notes && result.notes.length > 0 && (
        <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
          {result.notes.map((n, i) => (
            <li key={i} style={{ fontSize: 10, color: theme.text.muted, padding: '1px 0' }}>
              • {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function D20Face({ value, isNat20, isNat1 }: { value: number; isNat20: boolean; isNat1: boolean }) {
  const color = isNat20 ? '#f1c40f' : isNat1 ? '#e74c3c' : '#9b59b6';
  const bg = isNat20 ? 'rgba(241,196,15,0.18)' : isNat1 ? 'rgba(192,57,43,0.18)' : 'rgba(155,89,182,0.12)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 30, height: 30,
      background: bg, border: `1.5px solid ${color}`,
      borderRadius: 6,
      fontSize: 14, fontWeight: 700, color,
      fontFamily: theme.font.display,
    }}>
      {value}
    </span>
  );
}
