import { Sword, Zap, Footprints, Shield } from 'lucide-react';
import { useCombatStore } from '../../stores/useCombatStore';
import { theme } from '../../styles/theme';
import { InfoTooltip } from '../ui/InfoTooltip';

interface EconomyItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  used: boolean;
  color: string;
  tooltipTitle: string;
  tooltipBody: string;
  tooltipFooter: string;
  isMovement?: boolean;
}

export function ActionEconomy() {
  const economy = useCombatStore((s) => s.actionEconomy);

  // Status string flipped per slot — included in the footer so the
  // tooltip clearly tells the user "yes you've spent it" or "still
  // available". The full rules text in the body answers "can I take
  // a Bonus Action every turn?" type questions.
  const statusOf = (used: boolean) => used ? '⚠️ Already spent this turn' : '✓ Available';

  const items: EconomyItem[] = [
    {
      key: 'action',
      label: 'Action',
      icon: <Sword size={16} />,
      used: economy.action,
      color: '#e74c3c',
      tooltipTitle: 'Action',
      tooltipBody:
        'You get ONE Action on each of your turns in combat. Use it for any of:\n' +
        '• Attack (one weapon attack — features like Extra Attack let you make more)\n' +
        '• Cast a Spell (with a casting time of 1 action)\n' +
        '• Dash — gain extra movement equal to your speed\n' +
        '• Dodge — attacks against you have disadvantage\n' +
        '• Disengage — your movement won\u2019t provoke Opportunity Attacks\n' +
        '• Help — give an ally advantage on their next attack/check\n' +
        '• Hide — make a Stealth check to become hidden\n' +
        '• Ready — prepare a trigger and reaction\n' +
        '• Search — make a Perception/Investigation check\n' +
        '• Use an Object — draw, drink, push a button, etc.',
      tooltipFooter: `1 per turn  •  ${statusOf(economy.action)}`,
    },
    {
      key: 'bonus',
      label: 'Bonus',
      icon: <Zap size={16} />,
      used: economy.bonusAction,
      color: '#f39c12',
      tooltipTitle: 'Bonus Action',
      tooltipBody:
        'You can take a Bonus Action ONLY when a specific feature, spell, or other ability says you can — you don\u2019t get one automatically each turn. Examples:\n' +
        '• Off-hand attack from Two-Weapon Fighting (a Light melee weapon in your other hand)\n' +
        '• Cast a spell whose casting time is "1 bonus action" (Healing Word, Misty Step, Spiritual Weapon, Hex, Hunter\u2019s Mark, Spiritual Guardians)\n' +
        '• Class features like Cunning Action (Rogue), Flurry of Blows (Monk), Second Wind (Fighter), Bardic Inspiration\n\n' +
        'You can only take ONE Bonus Action per turn no matter how many features grant one. If you\u2019re holding two Light melee weapons, you can use this slot for the off-hand attack, but you can\u2019t also cast a bonus-action spell that turn.',
      tooltipFooter: `1 per turn (only if a feature grants one)  •  ${statusOf(economy.bonusAction)}`,
    },
    {
      key: 'movement',
      label: `${economy.movementRemaining}ft`,
      icon: <Footprints size={16} />,
      used: economy.movementRemaining <= 0,
      color: '#3498db',
      isMovement: true,
      tooltipTitle: 'Movement',
      tooltipBody:
        'You can move up to your speed each turn — your speed is set by race/class (typically 30 ft for Medium creatures). Movement can be SPLIT freely:\n' +
        '• Move 10 ft, attack, then move another 20 ft.\n' +
        '• You can also use it after your action.\n\n' +
        'Drag your token on the map to move — feet are deducted automatically as you go.\n\n' +
        'To get MORE movement this turn:\n' +
        '• Take the Dash action (or Bonus Action Dash from Cunning Action) → +speed feet\n' +
        '• Some spells boost speed (Haste = ×2, Longstrider = +10)\n\n' +
        'Difficult terrain costs 2 ft per ft moved (we don\u2019t auto-detect it).',
      tooltipFooter:
        `${economy.movementRemaining} / ${economy.movementMax} ft remaining this turn  •  resets at the start of your next turn`,
    },
    {
      key: 'reaction',
      label: 'Reaction',
      icon: <Shield size={16} />,
      used: economy.reaction,
      color: '#9b59b6',
      tooltipTitle: 'Reaction',
      tooltipBody:
        'A Reaction is an INSTANT response to a specific trigger — it can fire on someone else\u2019s turn, not just your own. Examples:\n' +
        '• Opportunity Attack — when an enemy you threaten leaves your reach without Disengaging\n' +
        '• Shield spell — when you\u2019re hit by an attack, +5 AC against it\n' +
        '• Counterspell — when you see another creature casting a spell\n' +
        '• Hellish Rebuke, Absorb Elements, Feather Fall — all reactions to specific triggers\n' +
        '• Ready action — you reserve your reaction earlier in the round\n\n' +
        'You get ONE reaction per ROUND (not per turn). It refreshes at the START of your next turn — meaning if you spend it on someone else\u2019s turn, you don\u2019t get another until your turn comes back around.',
      tooltipFooter: `1 per round  •  ${statusOf(economy.reaction)}`,
    },
  ];

  return (
    <div style={styles.container}>
      {items.map((item) => {
        const movementRatio = item.isMovement
          ? economy.movementMax > 0
            ? economy.movementRemaining / economy.movementMax
            : 0
          : undefined;

        return (
          <InfoTooltip
            key={item.key}
            title={item.tooltipTitle}
            body={item.tooltipBody}
            footer={item.tooltipFooter}
            accent={item.color}
            maxWidth={340}
          >
            <div
              style={{
                ...styles.item,
                opacity: item.used ? 0.35 : 1,
                cursor: 'help',
              }}
            >
              <div
                style={{
                  ...styles.iconWrapper,
                  borderColor: item.used ? theme.border.default : item.color,
                  background: item.used
                    ? theme.bg.deep
                    : `${item.color}15`,
                }}
              >
                <span style={{ color: item.used ? theme.text.muted : item.color }}>
                  {item.icon}
                </span>
              </div>
              <span
                style={{
                  ...styles.label,
                  color: item.used ? theme.text.muted : theme.text.secondary,
                }}
              >
                {item.label}
              </span>
              {/* Movement bar */}
              {item.isMovement && movementRatio !== undefined && (
                <div style={styles.moveBarBg}>
                  <div
                    style={{
                      ...styles.moveBarFill,
                      width: `${movementRatio * 100}%`,
                      background: item.color,
                    }}
                  />
                </div>
              )}
            </div>
          </InfoTooltip>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    gap: 12,
    padding: '8px 12px',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    transition: 'opacity 0.2s ease',
    minWidth: 52,
  },
  iconWrapper: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '2px solid',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease',
  },
  label: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  moveBarBg: {
    width: 40,
    height: 3,
    background: 'rgba(0,0,0,0.4)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  moveBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
};
