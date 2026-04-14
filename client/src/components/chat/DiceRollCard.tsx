import type { DiceRollData } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

// ── Skills list for detection ────────────────────────────────────
const SKILLS = [
  'acrobatics', 'animal handling', 'arcana', 'athletics', 'deception',
  'history', 'insight', 'intimidation', 'investigation', 'medicine',
  'nature', 'perception', 'performance', 'persuasion', 'religion',
  'sleight of hand', 'stealth', 'survival',
];

const ABILITIES = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
];

function detectRollType(content: string, rollData: DiceRollData): { label: string; sub?: string } {
  const lower = content.toLowerCase();
  const reason = rollData.reason?.toLowerCase() ?? '';
  const combined = `${lower} ${reason}`;

  // Check for skill names first
  for (const skill of SKILLS) {
    if (combined.includes(skill)) {
      return { label: skill.toUpperCase(), sub: 'CHECK' };
    }
  }

  // Ability checks
  for (const ability of ABILITIES) {
    if (combined.includes(ability)) {
      return { label: ability.toUpperCase(), sub: 'CHECK' };
    }
  }

  if (combined.includes('attack')) return { label: 'ATTACK', sub: 'ROLL' };
  if (combined.includes('save') || combined.includes('saving')) return { label: 'SAVING', sub: 'THROW' };
  if (combined.includes('initiative')) return { label: 'INITIATIVE', sub: 'ROLL' };
  if (combined.includes('death')) return { label: 'DEATH', sub: 'SAVE' };

  // If no d20 in the roll, it's probably damage
  const hasD20 = rollData.dice.some((d) => d.type === 20);
  if (!hasD20) return { label: 'DAMAGE', sub: undefined };

  return { label: 'DICE', sub: 'ROLL' };
}

// ── D20 SVG icon ─────────────────────────────────────────────────
function D20Icon({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {/* Outer hexagon-ish d20 shape */}
      <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" />
      {/* Inner triangle lines for the faceted look */}
      <line x1="12" y1="2" x2="12" y2="22" />
      <line x1="2" y1="8.5" x2="22" y2="8.5" />
      <line x1="2" y1="15.5" x2="12" y2="2" />
      <line x1="22" y1="15.5" x2="12" y2="2" />
      <line x1="2" y1="8.5" x2="12" y2="22" />
      <line x1="22" y1="8.5" x2="12" y2="22" />
    </svg>
  );
}

// ── CSS keyframes (injected once) ────────────────────────────────
let stylesInjected = false;
function injectKeyframes() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes diceCardGoldPulse {
      0%, 100% { box-shadow: 0 0 8px rgba(232,196,85,0.3), inset 0 0 20px rgba(232,196,85,0.05); }
      50% { box-shadow: 0 0 20px rgba(232,196,85,0.6), inset 0 0 30px rgba(232,196,85,0.12); }
    }
    @keyframes diceCardCritNumber {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.08); }
    }
    @keyframes diceCardRedPulse {
      0%, 100% { box-shadow: 0 0 8px rgba(192,57,43,0.3); }
      50% { box-shadow: 0 0 16px rgba(192,57,43,0.5); }
    }
    @keyframes diceCardSlideIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

// ── Component ────────────────────────────────────────────────────
interface DiceRollCardProps {
  rollData: DiceRollData;
  content: string;
  displayName: string;
  isHidden?: boolean;
}

export function DiceRollCard({ rollData, content, displayName, isHidden }: DiceRollCardProps) {
  injectKeyframes();

  const hasD20 = rollData.dice.some((d) => d.type === 20);
  const d20Value = rollData.dice.find((d) => d.type === 20)?.value;
  const isNat20 = hasD20 && d20Value === 20;
  const isNat1 = hasD20 && d20Value === 1;

  const rollType = detectRollType(content, rollData);

  // Build the formula: "14 + 5 = 19"
  const diceSum = rollData.dice.reduce((s, d) => s + d.value, 0);
  const mod = rollData.modifier;
  let formulaParts: string;
  if (mod !== 0) {
    formulaParts = `${diceSum} ${mod > 0 ? '+' : '-'} ${Math.abs(mod)} = ${rollData.total}`;
  } else {
    formulaParts = `${rollData.total}`;
  }

  // Colors based on crit state
  const accentColor = isHidden
    ? theme.purple
    : isNat20
    ? '#f1c40f'
    : isNat1
    ? theme.danger
    : theme.gold.primary;

  const totalColor = isHidden
    ? theme.purple
    : isNat20
    ? '#f1c40f'
    : isNat1
    ? '#e74c3c'
    : '#fff';

  const cardBg = isNat20
    ? 'rgba(241,196,15,0.08)'
    : isNat1
    ? 'rgba(192,57,43,0.08)'
    : 'rgba(212,168,67,0.06)';

  const cardAnimation = isNat20
    ? 'diceCardGoldPulse 2s ease-in-out 1, diceCardSlideIn 0.25s ease'
    : isNat1
    ? 'diceCardRedPulse 2s ease-in-out 1, diceCardSlideIn 0.25s ease'
    : 'diceCardSlideIn 0.25s ease';

  return (
    <div
      style={{
        background: cardBg,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: theme.radius.md,
        padding: '10px 12px',
        animation: cardAnimation,
        ...(isHidden
          ? { background: 'rgba(155,89,182,0.08)', borderLeft: `3px solid ${theme.purple}` }
          : {}),
      }}
    >
      {/* Header row: icon + roll type label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <D20Icon color={accentColor} size={16} />
        <span
          style={{
            ...theme.type.h3,
            color: accentColor,
            letterSpacing: '0.1em',
          }}
        >
          {rollType.label}
          {rollType.sub && (
            <span style={{ color: theme.text.muted, marginLeft: 4 }}>
              {rollType.sub}
            </span>
          )}
        </span>
        {isHidden && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: theme.purple,
              background: 'rgba(155,89,182,0.15)',
              padding: '1px 6px',
              borderRadius: 3,
              border: '1px solid rgba(155,89,182,0.3)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginLeft: 'auto',
            }}
          >
            Hidden
          </span>
        )}
      </div>

      {/* Critical hit / miss label */}
      {isNat20 && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#f1c40f',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          NATURAL 20 — CRITICAL HIT!
        </div>
      )}
      {isNat1 && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#e74c3c',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          NATURAL 1 — CRITICAL MISS!
        </div>
      )}

      {/* Main total + formula */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span
          style={{
            fontSize: 28,
            fontWeight: 700,
            fontFamily: theme.font.display,
            color: totalColor,
            lineHeight: 1,
            animation: isNat20 ? 'diceCardCritNumber 0.6s ease-in-out 1' : undefined,
          }}
        >
          {rollData.total}
        </span>
        {mod !== 0 && (
          <span
            style={{
              fontSize: 14,
              color: theme.text.secondary,
              fontFamily: 'monospace',
            }}
          >
            {formulaParts}
          </span>
        )}
      </div>

      {/* Dice breakdown: notation + individual dice badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <span
          style={{
            fontSize: 11,
            color: theme.text.muted,
            fontFamily: 'monospace',
          }}
        >
          {rollData.notation}
        </span>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {rollData.dice.map((d, i) => {
            const isCritValue = d.type === 20 && d.value === 20;
            const isFumbleValue = d.type === 20 && d.value === 1;
            const isMax = d.value === d.type;
            const isMin = d.value === 1;
            return (
              <span
                key={i}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 22,
                  height: 20,
                  padding: '0 4px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'monospace',
                  background: isCritValue
                    ? 'rgba(241,196,15,0.25)'
                    : isFumbleValue
                    ? 'rgba(192,57,43,0.25)'
                    : isMax
                    ? 'rgba(39,174,96,0.2)'
                    : isMin
                    ? 'rgba(192,57,43,0.15)'
                    : 'rgba(255,255,255,0.07)',
                  color: isCritValue
                    ? '#f1c40f'
                    : isFumbleValue
                    ? '#e74c3c'
                    : isMax
                    ? '#2ecc71'
                    : isMin
                    ? '#e74c3c'
                    : theme.text.secondary,
                  border: `1px solid ${
                    isCritValue
                      ? 'rgba(241,196,15,0.4)'
                      : isFumbleValue
                      ? 'rgba(192,57,43,0.4)'
                      : 'rgba(255,255,255,0.08)'
                  }`,
                }}
              >
                {d.value}
              </span>
            );
          })}
        </div>
      </div>

      {/* Reason (if any) */}
      {rollData.reason && (
        <div
          style={{
            fontSize: 11,
            fontStyle: 'italic',
            color: theme.text.secondary,
            marginBottom: 4,
          }}
        >
          {rollData.reason}
        </div>
      )}

      {/* Divider */}
      <div
        style={{
          height: 1,
          background: theme.ornate.divider,
          margin: '6px 0',
        }}
      />

      {/* Footer */}
      <div
        style={{
          fontSize: 10,
          color: theme.text.muted,
        }}
      >
        Rolled by {displayName}
      </div>
    </div>
  );
}
