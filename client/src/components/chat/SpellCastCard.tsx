import type { CSSProperties } from 'react';
import type { SpellCastBreakdown, SpellTargetOutcome } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

/**
 * Renders a full spell-cast breakdown in chat. Built from the
 * `SpellCastBreakdown` structured payload the resolver attaches to
 * the cast's system message. Multi-target spells (Fireball, Eldritch
 * Blast, Hypnotic Pattern) get one card with a row per target,
 * collapsed to keep chat scrollable but every modifier, save, and
 * damage source stays visible.
 *
 * Layout:
 *   Header:  🔮 Caster casts SPELL NAME (L3 fire, DEX DC 14)
 *   Caster notes (optional): global annotations (concentration,
 *                             upcast slot, etc.)
 *   Targets: one row per target
 *       • Target name · kind-specific inline: attack d20+mod vs AC,
 *                                              save d20+mod vs DC,
 *                                              heal, damage
 *       • expanded modifier list (save bonus sources, attack mods)
 *       • damage sub-card with dice + bonuses + HP delta
 *       • per-target notes (Magic Resistance, prone, paralyzed)
 */
export function SpellCastCard({ result }: { result: SpellCastBreakdown }) {
  const accent =
    result.spell.kind === 'heal' ? '#27ae60' :
    result.spell.kind === 'utility' ? theme.gold.primary :
    result.spell.kind === 'attack' ? '#3498db' :
    result.spell.kind === 'save' ? '#9b59b6' :
    '#e67e22';

  const bg =
    result.spell.kind === 'heal' ? 'rgba(39,174,96,0.06)' :
    result.spell.kind === 'utility' ? 'rgba(212,168,67,0.05)' :
    result.spell.kind === 'attack' ? 'rgba(52,152,219,0.06)' :
    result.spell.kind === 'save' ? 'rgba(155,89,182,0.06)' :
    'rgba(230,126,34,0.06)';

  // Sub-title string: "L3 fire, DEX DC 14"
  const subParts: string[] = [];
  subParts.push(result.spell.level === 0 ? 'cantrip' : `L${result.spell.level}`);
  if (result.spell.damageType) subParts.push(result.spell.damageType);
  if (result.spell.saveAbility && result.spell.saveDc != null) {
    subParts.push(`${result.spell.saveAbility.toUpperCase()} DC ${result.spell.saveDc}`);
  }
  if (result.spell.kind === 'attack' && result.spell.spellAttackBonus != null) {
    const sign = result.spell.spellAttackBonus >= 0 ? '+' : '';
    subParts.push(`spell atk ${sign}${result.spell.spellAttackBonus}`);
  }

  return (
    <div
      style={{
        background: bg,
        borderLeft: `3px solid ${accent}`,
        borderRadius: theme.radius.md,
        padding: '10px 12px',
      }}
    >
      {/* Header: caster casts SPELL */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text.primary }}>
          🔮 {result.caster.name}
        </span>
        <span style={{ fontSize: 11, color: theme.text.muted }}>casts</span>
        <span style={{
          fontSize: 13, fontWeight: 700, color: accent,
          fontFamily: theme.font.display, letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {result.spell.name}
        </span>
      </div>
      <div style={{
        fontSize: 10, color: theme.text.muted, marginBottom: 6,
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        {subParts.join(' · ')}
        {result.spell.halfOnSave && <span style={{ marginLeft: 8 }}>(save halves)</span>}
      </div>

      {/* Caster-side notes — vertical list so long arrays stay readable. */}
      {result.notes.length > 0 && (
        <div style={{
          marginBottom: 6, padding: '4px 8px',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: theme.radius.sm,
          border: `1px solid ${theme.border.default}`,
        }}>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {result.notes.map((n, i) => (
              <li key={i} style={{
                fontSize: 10, color: theme.text.secondary,
                fontStyle: 'italic', padding: '1px 0',
              }}>
                • {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Target rows */}
      {result.targets.length === 0 ? (
        <div style={{ fontSize: 11, color: theme.text.muted, fontStyle: 'italic' }}>
          (cast successfully — no target resolution)
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {result.targets.map((t, i) => (
            <TargetRow key={t.tokenId ?? `${t.name}-${i}`} target={t} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Per-target row ────────────────────────────────────────────── */

function TargetRow({ target, accent }: { target: SpellTargetOutcome; accent: string }) {
  const outcomeChipStyle: CSSProperties = {
    padding: '1px 6px',
    borderRadius: 8,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    marginLeft: 'auto',
  };

  let chip: React.ReactNode = null;
  let summary: React.ReactNode = null;

  if (target.attack) {
    const a = target.attack;
    const chipStyle: CSSProperties = {
      ...outcomeChipStyle,
      ...(a.hitResult === 'crit' ? { background: 'rgba(241,196,15,0.22)', color: '#f1c40f', border: '1px solid rgba(241,196,15,0.5)' } :
          a.hitResult === 'fumble' ? { background: 'rgba(192,57,43,0.22)', color: '#e74c3c', border: '1px solid rgba(192,57,43,0.5)' } :
          a.hitResult === 'hit' ? { background: 'rgba(39,174,96,0.2)', color: '#2ecc71', border: '1px solid rgba(39,174,96,0.4)' } :
          { background: 'rgba(192,57,43,0.18)', color: '#e74c3c', border: '1px solid rgba(192,57,43,0.4)' }),
    };
    chip = <span style={chipStyle}>{a.hitResult}</span>;
    summary = (
      <span style={{ fontSize: 11, color: theme.text.secondary, fontFamily: 'monospace' }}>
        d20={a.d20}
        {a.d20Rolls && a.d20Rolls.length > 1 && ` [${a.d20Rolls.join(',')}]`}
        {' \u2192 '}
        <strong style={{ color: theme.text.primary }}>{a.total}</strong>
        {' vs AC '}{a.targetAc}
      </span>
    );
  } else if (target.save) {
    const s = target.save;
    const chipStyle: CSSProperties = {
      ...outcomeChipStyle,
      ...(s.saved ? { background: 'rgba(39,174,96,0.2)', color: '#2ecc71', border: '1px solid rgba(39,174,96,0.4)' } :
          { background: 'rgba(192,57,43,0.18)', color: '#e74c3c', border: '1px solid rgba(192,57,43,0.4)' }),
    };
    chip = <span style={chipStyle}>{s.saved ? 'saved' : 'failed'}</span>;
    summary = (
      <span style={{ fontSize: 11, color: theme.text.secondary, fontFamily: 'monospace' }}>
        {s.ability.toUpperCase()} d20={s.d20}
        {s.d20Rolls && s.d20Rolls.length > 1 && ` [${s.d20Rolls.join(',')}]`}
        {' \u2192 '}
        <strong style={{ color: theme.text.primary }}>{s.total}</strong>
        {' vs DC '}{s.dc}
        {s.autoFailed && ' (auto-fail)'}
        {s.autoSucceeded && ' (auto-succeed)'}
      </span>
    );
  } else if (target.healing) {
    chip = <span style={{ ...outcomeChipStyle, background: 'rgba(39,174,96,0.22)', color: '#2ecc71', border: '1px solid rgba(39,174,96,0.4)' }}>healed</span>;
  } else if (target.damage && !target.attack && !target.save) {
    chip = <span style={{ ...outcomeChipStyle, background: 'rgba(230,126,34,0.2)', color: '#e67e22', border: '1px solid rgba(230,126,34,0.4)' }}>hit</span>;
  } else if (target.conditionsApplied && target.conditionsApplied.length > 0) {
    chip = <span style={{ ...outcomeChipStyle, background: 'rgba(52,152,219,0.18)', color: '#3498db', border: '1px solid rgba(52,152,219,0.4)' }}>buffed</span>;
  }

  return (
    <div style={{
      padding: '6px 8px',
      background: 'rgba(255,255,255,0.02)',
      borderRadius: theme.radius.sm,
      border: `1px solid ${theme.border.default}`,
    }}>
      {/* Header row: name + d20 summary + outcome chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: theme.text.primary }}>
          {target.name}
        </span>
        {summary && <span style={{ flex: 1, minWidth: 0 }}>{summary}</span>}
        {chip}
      </div>

      {/* Attack modifiers */}
      {target.attack && target.attack.modifiers.length > 0 && (
        <ModifierList modifiers={target.attack.modifiers} accent={accent} />
      )}
      {target.attack?.acNotes && target.attack.acNotes.length > 0 && (
        <div style={{ fontSize: 10, color: theme.text.muted, fontStyle: 'italic', marginTop: 2 }}>
          AC {target.attack.baseAc ?? '?'} {target.attack.acNotes.join(' ')}
        </div>
      )}

      {/* Save modifiers */}
      {target.save && target.save.modifiers.length > 0 && (
        <ModifierList modifiers={target.save.modifiers} accent={accent} />
      )}

      {/* Damage block */}
      {target.damage && (
        <DamageBlock damage={target.damage} />
      )}

      {/* Healing block */}
      {target.healing && (
        <HealingBlock healing={target.healing} />
      )}

      {/* Applied conditions */}
      {target.conditionsApplied && target.conditionsApplied.length > 0 && (
        <div style={{ fontSize: 10, color: theme.text.secondary, marginTop: 2 }}>
          now: <strong>{target.conditionsApplied.join(', ')}</strong>
        </div>
      )}

      {/* Per-target notes */}
      {target.notes && target.notes.length > 0 && (
        <ul style={{ margin: '3px 0 0', padding: 0, listStyle: 'none' }}>
          {target.notes.map((n, i) => (
            <li key={i} style={{ fontSize: 10, color: theme.text.muted, padding: '1px 0' }}>
              • {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────── */

function ModifierList({
  modifiers, accent,
}: {
  modifiers: SpellTargetOutcome['attack'] extends infer T ? T extends { modifiers: infer M } ? M : never : never;
  accent: string;
}) {
  if (!modifiers || modifiers.length === 0) return null;
  return (
    <ul style={{ margin: '2px 0 0 0', padding: 0, listStyle: 'none' }}>
      {modifiers.map((m, i) => {
        const sign = m.value >= 0 ? '+' : '\u2212';
        const abs = Math.abs(m.value);
        return (
          <li key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '1px 0', fontSize: 10,
          }}>
            <span style={{ fontSize: 8, color: sourceColor(m.source, accent) }}>●</span>
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

function DamageBlock({ damage }: { damage: NonNullable<SpellTargetOutcome['damage']> }) {
  return (
    <div style={{
      marginTop: 4, padding: '4px 6px',
      background: 'rgba(230,126,34,0.04)',
      borderRadius: theme.radius.sm,
      border: '1px solid rgba(230,126,34,0.15)',
    }}>
      {/* Base damage roll */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, flexWrap: 'wrap' }}>
        <span style={{ color: theme.text.muted, fontFamily: 'monospace', minWidth: 40 }}>
          {damage.dice}
        </span>
        {damage.diceRolls.length > 0 && (
          <span style={{ color: theme.text.secondary, fontFamily: 'monospace' }}>
            [{damage.diceRolls.join(',')}]
          </span>
        )}
        <span style={{ color: theme.text.muted }}>→</span>
        <span style={{ color: theme.text.primary, fontWeight: 700 }}>
          {damage.mainRoll}
        </span>
      </div>
      {/* Per-source bonuses */}
      {damage.bonuses.length > 0 && (
        <ul style={{ margin: '2px 0 0 0', padding: 0, listStyle: 'none' }}>
          {damage.bonuses.map((b, i) => {
            const resisted = b.resisted !== undefined && b.resisted !== b.amount;
            return (
              <li key={i} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 10, padding: '1px 0',
              }}>
                <span style={{ color: '#e67e22', fontSize: 8 }}>●</span>
                <span style={{ flex: 1, color: theme.text.secondary }}>{b.label}</span>
                {resisted ? (
                  <span style={{ fontFamily: 'monospace' }}>
                    <span style={{ color: theme.text.muted, textDecoration: 'line-through' }}>
                      {b.amount}
                    </span>
                    {' \u2192 '}
                    <span style={{ fontWeight: 700, color: '#e67e22' }}>{b.resisted}</span>
                  </span>
                ) : (
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#e67e22' }}>
                    +{b.amount}
                  </span>
                )}
                <span style={{ fontSize: 8, color: theme.text.muted }}>
                  {b.damageType}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {/* Final total + HP delta. Some emitters (Smite, Wand of Magic
          Missiles, auto-damage riders) don't know the target's HP and
          pass 0/0 as a sentinel — in that case we skip the HP ticker
          and the DOWN badge instead of rendering the misleading
          "HP 0 \u2192 0 \u2014 DOWN" combo. */}
      {(() => {
        const hpKnown = !(damage.targetHpBefore === 0 && damage.targetHpAfter === 0);
        const droppedToZero = hpKnown && damage.targetHpAfter === 0;
        return (
          <>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 6,
              marginTop: 4, paddingTop: 4,
              borderTop: `1px dashed ${theme.border.default}`,
              fontSize: 10,
            }}>
              <span style={{ color: theme.text.muted }}>
                {damage.halfDamage ? 'Half' : 'Final'}
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#e67e22', fontFamily: theme.font.display }}>
                {damage.finalDamage}
              </span>
              <span style={{ flex: 1 }} />
              {hpKnown && (
                <span style={{ color: theme.text.muted, fontFamily: 'monospace' }}>
                  HP {damage.targetHpBefore} → <span style={{
                    color: droppedToZero ? '#e74c3c' : theme.text.primary,
                    fontWeight: 700,
                  }}>{damage.targetHpAfter}</span>
                </span>
              )}
            </div>
            {droppedToZero && (
              <div style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: '#e74c3c' }}>
                💀 DOWN
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

function HealingBlock({ healing }: { healing: NonNullable<SpellTargetOutcome['healing']> }) {
  // Same "unknown HP" sentinel as DamageBlock — skip the HP ticker
  // when both numbers are zero (emitters for non-character targets).
  const hpKnown = !(healing.targetHpBefore === 0 && healing.targetHpAfter === 0);
  return (
    <div style={{
      marginTop: 4, padding: '4px 6px',
      background: 'rgba(39,174,96,0.05)',
      borderRadius: theme.radius.sm,
      border: '1px solid rgba(39,174,96,0.15)',
      display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 10, flexWrap: 'wrap',
    }}>
      <span style={{ color: theme.text.muted, fontFamily: 'monospace', minWidth: 40 }}>
        {healing.dice}
      </span>
      {healing.diceRolls.length > 0 && (
        <span style={{ color: theme.text.secondary, fontFamily: 'monospace' }}>
          [{healing.diceRolls.join(',')}]
        </span>
      )}
      <span style={{ color: '#2ecc71', fontWeight: 700 }}>
        +{healing.mainRoll} HP
      </span>
      <span style={{ flex: 1 }} />
      {hpKnown && (
        <span style={{ color: theme.text.muted, fontFamily: 'monospace' }}>
          HP {healing.targetHpBefore} → <strong style={{ color: theme.text.primary }}>{healing.targetHpAfter}</strong>
        </span>
      )}
    </div>
  );
}

function sourceColor(source: string | undefined, fallback: string): string {
  switch (source) {
    case 'ability': return '#3498db';
    case 'proficiency': return '#f1c40f';
    case 'feat': return '#e67e22';
    case 'fighting-style': return '#9b59b6';
    case 'condition': return '#2ecc71';
    case 'magic': return '#1abc9c';
    default: return fallback;
  }
}
