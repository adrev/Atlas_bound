import type { ActionBreakdown } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

/**
 * Generic "something mechanical happened" card. Used for events that
 * don't involve a d20 roll but still deserve structured presentation:
 *   • Legendary actions (Dragon tail swipe, Beholder eye ray)
 *   • Lair actions (environment shifts at init 20)
 *   • Magic-item activations (ring of protection toggled, potion
 *     consumed, wand charge spent)
 *   • Downtime / chase / environment commands
 *
 * Shows actor → action → effect, with optional per-target rows when
 * the action fans out (AoE lair actions, AoE magic items).
 */
export function ActionResultCard({ result }: { result: ActionBreakdown }) {
  const accent =
    result.action.category === 'legendary' ? '#b0754a' :
    result.action.category === 'lair' ? '#8e44ad' :
    result.action.category === 'magic-item' ? '#1abc9c' :
    result.action.category === 'class-feature' ? '#3498db' :
    result.action.category === 'racial' ? '#e67e22' :
    result.action.category === 'environment' ? '#5dade2' :
    result.action.category === 'chase' ? '#e67e22' :
    result.action.category === 'downtime' ? theme.gold.dim :
    theme.gold.primary;

  const bg =
    result.action.category === 'legendary' ? 'rgba(176,117,74,0.06)' :
    result.action.category === 'lair' ? 'rgba(142,68,173,0.06)' :
    result.action.category === 'magic-item' ? 'rgba(26,188,156,0.06)' :
    result.action.category === 'class-feature' ? 'rgba(52,152,219,0.05)' :
    result.action.category === 'racial' ? 'rgba(230,126,34,0.05)' :
    result.action.category === 'environment' ? 'rgba(93,173,226,0.05)' :
    result.action.category === 'chase' ? 'rgba(230,126,34,0.05)' :
    'rgba(212,168,67,0.05)';

  const icon = result.action.icon || defaultIcon(result.action.category);

  return (
    <div
      style={{
        background: bg,
        borderLeft: `3px solid ${accent}`,
        borderRadius: theme.radius.md,
        padding: '10px 12px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text.primary }}>
          {icon} {result.actor.name}
        </span>
        <span style={{ fontSize: 11, color: theme.text.muted }}>→</span>
        <span style={{
          fontSize: 12, fontWeight: 700, color: accent,
          fontFamily: theme.font.display, letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {result.action.name}
        </span>
      </div>
      <div style={{
        fontSize: 10, color: theme.text.muted, marginBottom: 6,
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        {result.action.category.replace('-', ' ')}
        {result.action.cost && <span style={{ marginLeft: 8 }}>({result.action.cost})</span>}
      </div>

      {/* Effect */}
      <div style={{
        fontSize: 12, color: theme.text.primary,
        marginBottom: result.targets && result.targets.length > 0 ? 6 : 0,
        lineHeight: 1.4,
      }}>
        {result.effect}
      </div>

      {/* Per-target rows */}
      {result.targets && result.targets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
          {result.targets.map((t, i) => (
            <TargetRow key={t.tokenId ?? `${t.name}-${i}`} target={t} accent={accent} />
          ))}
        </div>
      )}

      {/* Notes */}
      {result.notes && result.notes.length > 0 && (
        <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
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

function TargetRow({
  target, accent,
}: {
  target: NonNullable<ActionBreakdown['targets']>[number];
  accent: string;
}) {
  const hasDamage = !!target.damage;
  const hasHealing = !!target.healing;
  const hasConditions = target.conditionsApplied && target.conditionsApplied.length > 0;

  return (
    <div style={{
      padding: '4px 8px',
      background: 'rgba(255,255,255,0.02)',
      borderRadius: theme.radius.sm,
      border: `1px solid ${theme.border.default}`,
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: theme.text.primary }}>
        {target.name}
      </span>
      {target.effect && (
        <span style={{ fontSize: 10, color: theme.text.secondary, fontStyle: 'italic' }}>
          — {target.effect}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {hasDamage && target.damage && (
        <span style={{ fontSize: 10, fontFamily: 'monospace' }}>
          <span style={{ color: '#e67e22', fontWeight: 700 }}>
            {target.damage.amount}
          </span>{' '}
          <span style={{ color: theme.text.muted }}>{target.damage.damageType}</span>
          {target.damage.hpAfter != null && (
            <span style={{ color: theme.text.muted, marginLeft: 4 }}>
              (HP {target.damage.hpBefore ?? '?'}→
              <strong style={{ color: target.damage.hpAfter === 0 ? '#e74c3c' : theme.text.primary }}>
                {target.damage.hpAfter}
              </strong>)
            </span>
          )}
        </span>
      )}
      {hasHealing && target.healing && (
        <span style={{ fontSize: 10, fontFamily: 'monospace' }}>
          <span style={{ color: '#2ecc71', fontWeight: 700 }}>
            +{target.healing.amount} HP
          </span>
          {target.healing.hpAfter != null && (
            <span style={{ color: theme.text.muted, marginLeft: 4 }}>
              ({target.healing.hpBefore ?? '?'}→<strong style={{ color: theme.text.primary }}>{target.healing.hpAfter}</strong>)
            </span>
          )}
        </span>
      )}
      {hasConditions && target.conditionsApplied && (
        <span style={{ fontSize: 10, color: accent, fontWeight: 600 }}>
          {target.conditionsApplied.join(', ')}
        </span>
      )}
    </div>
  );
}

function defaultIcon(category: ActionBreakdown['action']['category']): string {
  switch (category) {
    case 'legendary': return '\uD83D\uDC51';
    case 'lair': return '\uD83C\uDFF0';
    case 'magic-item': return '\uD83D\uDD2E';
    case 'class-feature': return '\u2728';
    case 'racial': return '\uD83E\uDDEC';
    case 'environment': return '\uD83C\uDF0A';
    case 'chase': return '\uD83C\uDFC3';
    case 'downtime': return '\uD83C\uDF05';
    default: return '\u2728';
  }
}
