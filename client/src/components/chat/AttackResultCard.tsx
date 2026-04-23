import type { CSSProperties } from 'react';
import type { AttackBreakdown } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

/**
 * Renders a full attack → damage breakdown inline in chat. Built from
 * the `AttackBreakdown` structured payload the resolver in
 * TokenActionPanel attaches to its system message. Every modifier,
 * condition, feat, fighting style, damage rider, and resistance lands
 * as its own row so the DM can verify the math at a glance.
 *
 * Layout:
 *   Header:  ⚔ Attacker → Target | Weapon (damageType)
 *   Attack:  d20 visual + per-source modifier list + total vs AC + HIT/MISS chip
 *   Damage:  dice + rolled faces + per-source bonus list + resistance notes
 *            + final "HP X → Y" ticker
 *   Notes:   extra situational flags (power attack, sharpshooter cover, …)
 */
export function AttackResultCard({ result }: { result: AttackBreakdown }) {
  const accent =
    result.hitResult === 'crit' ? '#f1c40f' :
    result.hitResult === 'fumble' ? '#e74c3c' :
    result.hitResult === 'hit' ? '#3498db' :
    '#95a5a6';

  const bg =
    result.hitResult === 'crit' ? 'rgba(241,196,15,0.08)' :
    result.hitResult === 'fumble' ? 'rgba(192,57,43,0.08)' :
    result.hitResult === 'hit' ? 'rgba(52,152,219,0.06)' :
    'rgba(149,165,166,0.04)';

  const hitChipStyle: CSSProperties = {
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    ...(result.hitResult === 'crit' ? { background: 'rgba(241,196,15,0.22)', color: '#f1c40f', border: '1px solid rgba(241,196,15,0.5)' } :
        result.hitResult === 'fumble' ? { background: 'rgba(192,57,43,0.22)', color: '#e74c3c', border: '1px solid rgba(192,57,43,0.5)' } :
        result.hitResult === 'hit' ? { background: 'rgba(39,174,96,0.18)', color: '#2ecc71', border: '1px solid rgba(39,174,96,0.4)' } :
        { background: 'rgba(192,57,43,0.18)', color: '#e74c3c', border: '1px solid rgba(192,57,43,0.4)' }),
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
      {/* Header: attacker → target | weapon */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text.primary }}>
          ⚔ {result.attacker.name}
        </span>
        <span style={{ fontSize: 11, color: theme.text.muted }}>→</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: theme.text.primary }}>
          {result.target.name}
        </span>
        <span style={{ fontSize: 10, color: theme.text.muted, marginLeft: 4 }}>•</span>
        <span style={{ fontSize: 11, color: theme.gold.dim, fontStyle: 'italic' }}>
          {result.weapon.name}
        </span>
      </div>

      {/* Attack roll section */}
      <Section title="Attack Roll" accent={accent}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          {/* Kept d20 */}
          <D20Face value={result.attackRoll.d20} isNat20={result.attackRoll.isCrit} isNat1={result.attackRoll.isFumble} />
          {result.attackRoll.d20Rolls && result.attackRoll.d20Rolls.length > 1 && (
            <span style={{ fontSize: 11, color: theme.text.muted, fontFamily: 'monospace' }}>
              ({result.attackRoll.advantage === 'advantage' ? 'adv' : 'disadv'}: {result.attackRoll.d20Rolls.join(', ')} → kept {result.attackRoll.d20})
            </span>
          )}
        </div>

        {/* Per-source modifier lines */}
        <ModifierList modifiers={result.attackRoll.modifiers} />

        {/* Total + AC + hit chip */}
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${theme.border.default}`,
        }}>
          <span style={{ fontSize: 11, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Total
          </span>
          <span style={{
            fontSize: 22, fontWeight: 700, color: accent,
            fontFamily: theme.font.display, lineHeight: 1,
          }}>
            {result.attackRoll.total}
          </span>
          <span style={{ fontSize: 11, color: theme.text.muted }}>vs AC</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: theme.text.primary }}>
            {result.target.ac}
          </span>
          {result.target.acNotes && result.target.acNotes.length > 0 && (
            <span style={{ fontSize: 10, color: theme.text.muted, fontStyle: 'italic' }}>
              ({result.target.baseAc ?? '?'} {result.target.acNotes.join(' ')})
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={hitChipStyle}>
            {result.hitResult}
          </span>
        </div>
      </Section>

      {/* Damage section — only when the attack landed. */}
      {result.damage && (
        <Section title={result.attackRoll.isCrit ? 'Damage (Critical)' : 'Damage'} accent={accent}>
          {/* Base weapon damage row — dice faces visualised */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: theme.text.muted, fontFamily: 'monospace', minWidth: 46 }}>
              {result.damage.dice}
            </span>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {result.damage.diceRolls.map((face, i) => (
                <DieFace key={i} value={face} />
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: theme.text.secondary }}>
              = {result.damage.mainRoll} {result.weapon.damageType}
            </span>
          </div>

          {/* Bonus damage sources (Rage, Sneak, Hex, Smite, etc.) */}
          {result.damage.bonuses.length > 0 && (
            <DamageBonusList bonuses={result.damage.bonuses} />
          )}

          {/* Weapon-type resistance / vulnerability row. Only renders
              when the target's defenses actually altered the sum of
              weapon-type sources (base + Rage + Sneak + Power Attack +
              Dueling + TWF) — so the user can see "base 8 + Rage 2 +
              Sneak 14 = 24 \u2192 12" instead of the final damage
              appearing unexplained. */}
          {result.damage.weaponTotalPre != null
            && result.damage.weaponTotalPost != null
            && result.damage.weaponTotalPre !== result.damage.weaponTotalPost && (
            <div style={{
              marginTop: 4, padding: '4px 8px',
              background: 'rgba(230,126,34,0.04)',
              borderRadius: theme.radius.sm,
              border: '1px solid rgba(230,126,34,0.2)',
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, flexWrap: 'wrap',
            }}>
              <span style={{ color: theme.text.muted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Weapon-type
              </span>
              <span style={{ fontFamily: 'monospace' }}>
                <span style={{ color: theme.text.muted, textDecoration: 'line-through' }}>
                  {result.damage.weaponTotalPre}
                </span>
                {' \u2192 '}
                <span style={{ fontWeight: 700, color: '#e67e22' }}>
                  {result.damage.weaponTotalPost}
                </span>
              </span>
              {result.damage.weaponResistanceNote && (
                <span style={{ color: theme.text.muted, fontStyle: 'italic' }}>
                  ({result.damage.weaponResistanceNote})
                </span>
              )}
            </div>
          )}

          {/* Final damage + HP delta. Same 0/0 "unknown HP" sentinel
              as the spell card so rider-style AttackBreakdowns that
              don't know the target's HP don't flash a bogus DOWN. */}
          {(() => {
            const dmg = result.damage!;
            const hpKnown = !(dmg.targetHpBefore === 0 && dmg.targetHpAfter === 0);
            const droppedToZero = hpKnown && dmg.targetHpAfter === 0;
            return (
              <>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 8,
                  marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${theme.border.default}`,
                }}>
                  <span style={{ fontSize: 11, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Final
                  </span>
                  <span style={{
                    fontSize: 22, fontWeight: 700, color: '#e67e22',
                    fontFamily: theme.font.display, lineHeight: 1,
                  }}>
                    {dmg.finalDamage}
                  </span>
                  <span style={{ fontSize: 10, color: theme.text.muted }}>damage</span>
                  <span style={{ flex: 1 }} />
                  {hpKnown && (
                    <span style={{ fontSize: 11, color: theme.text.muted, fontFamily: 'monospace' }}>
                      HP {dmg.targetHpBefore} → <span style={{
                        color: droppedToZero ? '#e74c3c' : theme.text.primary,
                        fontWeight: 700,
                      }}>{dmg.targetHpAfter}</span>
                    </span>
                  )}
                </div>
                {droppedToZero && (
                  <div style={{ marginTop: 4, fontSize: 11, fontWeight: 700, color: '#e74c3c', letterSpacing: '0.04em' }}>
                    💀 DOWN
                  </div>
                )}
              </>
            );
          })()}
        </Section>
      )}

      {/* Situational notes — advantage sources, feat triggers, etc. */}
      {result.notes.length > 0 && (
        <div style={{
          marginTop: 6, padding: '6px 8px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: theme.radius.sm,
          border: `1px solid ${theme.border.default}`,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: theme.text.muted, marginBottom: 3,
          }}>
            Situational
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {result.notes.map((n, i) => (
              <li key={i} style={{ fontSize: 11, color: theme.text.secondary, padding: '1px 0' }}>
                • {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Shield reaction outcome */}
      {result.shieldSpell && (
        <div style={{
          marginTop: 4, fontSize: 11, fontStyle: 'italic',
          color: result.shieldSpell === 'miss' ? '#27ae60' : '#e67e22',
        }}>
          🛡 Target cast Shield (+5 AC) — {
            result.shieldSpell === 'miss' ? 'attack now MISSES' : 'still hits'
          }
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────── */

function Section({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: accent, marginBottom: 4,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ModifierList({ modifiers }: { modifiers: AttackBreakdown['attackRoll']['modifiers'] }) {
  if (modifiers.length === 0) {
    return (
      <div style={{ fontSize: 11, color: theme.text.muted, fontStyle: 'italic' }}>
        (no modifiers — straight d20)
      </div>
    );
  }
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {modifiers.map((m, i) => {
        const sign = m.value >= 0 ? '+' : '\u2212';
        const abs = Math.abs(m.value);
        return (
          <li key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '2px 0', fontSize: 11,
          }}>
            <span style={{ fontSize: 10, color: sourceColor(m.source) }}>●</span>
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
  );
}

function DamageBonusList({ bonuses }: { bonuses: AttackBreakdown['damage'] extends infer T ? T extends { bonuses: infer B } ? B : never : never }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {bonuses.map((b, i) => {
        const resisted = b.resisted !== undefined && b.resisted !== b.amount;
        return (
          <li key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '2px 0', fontSize: 11,
          }}>
            <span style={{ fontSize: 10, color: '#e67e22' }}>●</span>
            <span style={{ flex: 1, color: theme.text.secondary }}>{b.label}</span>
            {resisted ? (
              <span style={{ fontFamily: 'monospace' }}>
                <span style={{ color: theme.text.muted, textDecoration: 'line-through' }}>{b.amount}</span>
                {' → '}
                <span style={{ fontWeight: 700, color: '#e67e22' }}>{b.resisted}</span>
                <span style={{ fontSize: 9, color: theme.text.muted, marginLeft: 4 }}>
                  {b.damageType}
                  {b.resistanceNote ? ` (${b.resistanceNote})` : ''}
                </span>
              </span>
            ) : (
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#e67e22' }}>
                +{b.amount}
                <span style={{ fontSize: 9, color: theme.text.muted, marginLeft: 4, fontWeight: 400 }}>
                  {b.damageType}
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function D20Face({ value, isNat20, isNat1 }: { value: number; isNat20: boolean; isNat1: boolean }) {
  const color = isNat20 ? '#f1c40f' : isNat1 ? '#e74c3c' : '#3498db';
  const bg = isNat20 ? 'rgba(241,196,15,0.18)' : isNat1 ? 'rgba(192,57,43,0.18)' : 'rgba(52,152,219,0.12)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 34, height: 34,
      background: bg, border: `1.5px solid ${color}`,
      borderRadius: 6,
      fontSize: 15, fontWeight: 700, color,
      fontFamily: theme.font.display,
    }}>
      {value}
    </span>
  );
}

function DieFace({ value }: { value: number }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 22, height: 20,
      padding: '0 4px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, fontFamily: 'monospace',
      background: 'rgba(255,255,255,0.07)',
      color: theme.text.secondary,
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      {value}
    </span>
  );
}

function sourceColor(source?: string): string {
  switch (source) {
    case 'ability': return '#3498db';
    case 'proficiency': return '#f1c40f';
    case 'feat': return '#e67e22';
    case 'fighting-style': return '#9b59b6';
    case 'condition': return '#2ecc71';
    case 'magic': return '#1abc9c';
    default: return theme.text.muted;
  }
}
