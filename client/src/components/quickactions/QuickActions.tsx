import type { CSSProperties } from 'react';
import { emitSystemMessage } from '../../socket/emitters';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { showToast } from '../ui';
import { performLongRest, triggerShortRestDialog } from '../../utils/rest';
import type { Character } from '@dnd-vtt/shared';

/**
 * Atlas Bound — QuickActions bottom bar.
 *
 * Replaces the old Hotbar (which was a drag-drop action slot MMO-style
 * system that was rarely used). This gives the player / DM one-click
 * access to the 5e standard actions that everyone forgets exist:
 * Dodge, Dash, Disengage, Hide, Help, Ready — plus Short Rest and
 * Long Rest buttons for recovery.
 *
 * ### Visual style
 * Rune-slab carved tiles matching the sidebar tab aesthetic:
 *   • Warm parchment gradient background
 *   • Gold rune edges
 *   • Small emoji + label stacked vertically
 *   • Gold glow on hover + active press
 *   • Grouped into Combat / Utility / Rest with small dividers
 *
 * ### What each button does
 * Each button emits a system chat message announcing the action.
 * The real mechanical effects (action economy consumption,
 * advantage on stealth, etc.) would be wired up later in a
 * follow-up; for now the chat message + toast notification is the
 * canonical "I did this" signal that the DM and other players see.
 *
 * For Short/Long Rest, we route through the character sheet's
 * existing rest functions by dispatching a custom event that the
 * Character Sheet listens for (same pattern as `switch-to-character-tab`).
 */

// ── Action definitions ───────────────────────────────────────
interface QuickAction {
  id: string;
  label: string;
  emoji: string;
  description: string;
  cost: 'action' | 'bonus' | 'free' | 'rest';
  onClick: (ctx: QuickActionContext) => void;
}

interface QuickActionContext {
  character: Character | null;
  characterName: string | null;
  selectedTokenId: string | null;
  inCombat: boolean;
  isDM: boolean;
}

function announce(verb: string, ctx: QuickActionContext, suffix = '') {
  const name = ctx.characterName ?? (ctx.isDM ? 'The DM' : 'Someone');
  const msg = `${name} ${verb}${suffix ? ' ' + suffix : ''}.`;
  emitSystemMessage(msg);
}

const COMBAT_ACTIONS: QuickAction[] = [
  {
    id: 'dodge',
    label: 'Dodge',
    emoji: EMOJI.combat.dodge,
    description: 'Take the Dodge action. Attacks against you have disadvantage until your next turn.',
    cost: 'action',
    onClick: (ctx) => {
      announce('takes the **Dodge** action', ctx);
      showToast({ emoji: EMOJI.combat.dodge, message: 'Dodge — attacks against you have disadvantage', variant: 'info', duration: 3500 });
    },
  },
  {
    id: 'dash',
    label: 'Dash',
    emoji: '🏃',
    description: 'Take the Dash action. Your movement speed is doubled for this turn.',
    cost: 'action',
    onClick: (ctx) => {
      announce('takes the **Dash** action', ctx);
      showToast({ emoji: '🏃', message: 'Dash — movement doubled this turn', variant: 'info', duration: 3500 });
    },
  },
  {
    id: 'disengage',
    label: 'Disengage',
    emoji: '🚶',
    description: 'Take the Disengage action. Your movement does not provoke opportunity attacks for the rest of your turn.',
    cost: 'action',
    onClick: (ctx) => {
      announce('takes the **Disengage** action', ctx);
      showToast({ emoji: '🚶', message: 'Disengage — no opportunity attacks this turn', variant: 'info', duration: 3500 });
    },
  },
];

const UTILITY_ACTIONS: QuickAction[] = [
  {
    id: 'hide',
    label: 'Hide',
    emoji: '🫥',
    description: 'Take the Hide action. Roll a Dexterity (Stealth) check to become hidden.',
    cost: 'action',
    onClick: (ctx) => {
      announce('attempts to **Hide**', ctx, '— roll Stealth');
      showToast({ emoji: '🫥', message: 'Hide — roll Dex (Stealth)', variant: 'info', duration: 3500 });
    },
  },
  {
    id: 'help',
    label: 'Help',
    emoji: '🤝',
    description: 'Take the Help action. An ally within 5 ft has advantage on their next ability check or attack roll against a target you can see.',
    cost: 'action',
    onClick: (ctx) => {
      announce('takes the **Help** action', ctx, '— ally gains advantage');
      showToast({ emoji: '🤝', message: 'Help — ally has advantage on next roll', variant: 'info', duration: 3500 });
    },
  },
  {
    id: 'ready',
    label: 'Ready',
    emoji: '⏳',
    description: 'Take the Ready action. Prepare a trigger and response to fire on another creature\'s turn.',
    cost: 'action',
    onClick: (ctx) => {
      announce('takes the **Ready** action', ctx);
      showToast({ emoji: '⏳', message: 'Ready — trigger prepared', variant: 'info', duration: 3500 });
    },
  },
];

const REST_ACTIONS: QuickAction[] = [
  {
    id: 'short-rest',
    label: 'Short Rest',
    emoji: EMOJI.rest.short,
    description: 'Take a Short Rest (1 hour). Recover HP with hit dice and regain some class features.',
    cost: 'rest',
    onClick: (ctx) => {
      if (!ctx.character) {
        showToast({
          emoji: EMOJI.status.warning,
          message: 'No character loaded',
          variant: 'warning',
        });
        return;
      }
      triggerShortRestDialog();
    },
  },
  {
    id: 'long-rest',
    label: 'Long Rest',
    emoji: EMOJI.rest.long,
    description: 'Take a Long Rest (8 hours). Recover all HP, half your hit dice, and refresh all spell slots.',
    cost: 'rest',
    onClick: (ctx) => {
      if (!ctx.character) {
        showToast({
          emoji: EMOJI.status.warning,
          message: 'No character loaded',
          variant: 'warning',
        });
        return;
      }
      performLongRest(ctx.character);
    },
  },
];

// ── Component ────────────────────────────────────────────────
export function QuickActions() {
  // `myCharacter` is the store's name for the current user's linked
  // character (as opposed to `allCharacters` which is indexed by id
  // for every PC/NPC the current user can see).
  const character = useCharacterStore((s) => s.myCharacter);
  const isDM = useSessionStore((s) => s.isDM);
  const selectedTokenId = useMapStore((s) => s.selectedTokenId);
  const inCombat = useCombatStore((s) => s.active);

  const ctx: QuickActionContext = {
    character,
    characterName: character?.name ?? null,
    selectedTokenId,
    inCombat,
    isDM,
  };

  const renderGroup = (actions: QuickAction[], groupTitle: string) => (
    <div style={styles.group}>
      <div style={styles.groupTitle}>{groupTitle}</div>
      <div style={styles.groupRow}>
        {actions.map((a) => (
          <QuickActionTile key={a.id} action={a} ctx={ctx} />
        ))}
      </div>
    </div>
  );

  return (
    <div style={styles.container}>
      {renderGroup(COMBAT_ACTIONS, 'Combat')}
      <div aria-hidden style={styles.separator} />
      {renderGroup(UTILITY_ACTIONS, 'Utility')}
      <div aria-hidden style={styles.separator} />
      {renderGroup(REST_ACTIONS, 'Rest')}
    </div>
  );
}

// ── Individual rune-slab tile ────────────────────────────────
function QuickActionTile({ action, ctx }: { action: QuickAction; ctx: QuickActionContext }) {
  return (
    <button
      onClick={() => action.onClick(ctx)}
      title={action.description}
      style={styles.tile}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = theme.gold.bright;
        e.currentTarget.style.background = `linear-gradient(180deg, rgba(232, 196, 85, 0.12), ${theme.gold.bg})`;
        e.currentTarget.style.boxShadow = `inset 0 -2px 0 ${theme.gold.primary}, ${theme.goldGlow.soft}`;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = theme.text.secondary;
        e.currentTarget.style.background = `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`;
        e.currentTarget.style.boxShadow = `inset 0 -1px 0 ${theme.border.default}, inset 0 1px 0 rgba(232, 196, 85, 0.15)`;
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <span style={styles.tileEmoji}>{action.emoji}</span>
      <span style={styles.tileLabel}>{action.label}</span>
    </button>
  );
}

// ── Styles ───────────────────────────────────────────────────
const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space.md,
    height: '100%',
    padding: `${theme.space.xs}px ${theme.space.md}px`,
    // When the viewport is narrow, scroll horizontally so users can
    // still reach all action groups rather than silently clipping.
    overflowX: 'auto' as const,
    overflowY: 'hidden' as const,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
  },
  groupTitle: {
    ...theme.type.micro,
    color: theme.gold.dim,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    paddingLeft: 2,
  },
  groupRow: {
    display: 'flex',
    gap: 4,
  },
  separator: {
    width: 2,
    height: 44,
    background: `
      linear-gradient(90deg,
        rgba(0,0,0,0.35) 0%,
        rgba(0,0,0,0.35) 50%,
        rgba(232, 196, 85, 0.4) 50%,
        rgba(232, 196, 85, 0.4) 100%
      )
    `,
    flexShrink: 0,
  },
  tile: {
    width: 50,
    height: 42,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: `${theme.space.xxs}px ${theme.space.xs}px`,
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    boxShadow: `inset 0 -1px 0 ${theme.border.default}, inset 0 1px 0 rgba(232, 196, 85, 0.15)`,
    color: theme.text.secondary,
    cursor: 'pointer',
    transition: `all ${theme.motion.normal}`,
    fontFamily: theme.font.body,
    outline: 'none',
  },
  tileEmoji: {
    fontSize: 14,
    lineHeight: 1,
  },
  tileLabel: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.3px',
    whiteSpace: 'nowrap' as const,
  },
};
