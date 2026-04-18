import type { CSSProperties } from 'react';
import { emitSystemMessage, emitUseAction, emitRoll } from '../../socket/emitters';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { showToast } from '../ui';
import { performLongRest, performShortRest } from '../../utils/rest';
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

/**
 * Add a condition to the currently selected token (if any) and consume
 * the Action slot. Used by Dodge and Disengage below. Falls back to
 * just announcing when no token is selected — this keeps the button
 * useful for a DM who hasn't clicked a creature yet without
 * silently appearing broken.
 *
 * `dodging` and `disengaged` are app-internal pseudo-conditions, not
 * in the shared `Condition` type. The canvas combat code already uses
 * the same string tags, so we follow its lead and cast through string.
 *
 * Returns true if the effect was applied to a token; false if the
 * handler only emitted a chat announcement.
 */
function applySelfEffect(
  ctx: QuickActionContext,
  condition: 'dodging' | 'disengaged',
): boolean {
  if (!ctx.selectedTokenId) return false;
  const token = useMapStore.getState().tokens[ctx.selectedTokenId];
  if (!token) return false;
  const current = [...((token.conditions as string[]) || [])];
  if (!current.includes(condition)) current.push(condition);
  useMapStore.getState().updateToken(token.id, {
    conditions: current as unknown as typeof token.conditions,
  });
  if (ctx.inCombat) emitUseAction('action');
  return true;
}

function abilityMod(character: Character | null, ability: 'str' | 'dex'): number {
  const score = character?.abilityScores?.[ability];
  if (typeof score !== 'number') return 0;
  return Math.floor((score - 10) / 2);
}

const COMBAT_ACTIONS: QuickAction[] = [
  {
    id: 'dodge',
    label: 'Dodge',
    emoji: EMOJI.combat.dodge,
    description: 'Take the Dodge action. Attacks against you have disadvantage until your next turn.',
    cost: 'action',
    onClick: (ctx) => {
      const applied = applySelfEffect(ctx, 'dodging');
      announce('takes the **Dodge** action', ctx);
      showToast({
        emoji: EMOJI.combat.dodge,
        message: applied
          ? 'Dodge — attacks against you have disadvantage'
          : 'Dodge announced — select a token to apply the condition',
        variant: 'info',
        duration: 3500,
      });
    },
  },
  {
    id: 'dash',
    label: 'Dash',
    emoji: '🏃',
    description: 'Take the Dash action. Your movement speed is doubled for this turn.',
    cost: 'action',
    onClick: (ctx) => {
      if (ctx.selectedTokenId && ctx.inCombat) emitUseAction('action');
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
      const applied = applySelfEffect(ctx, 'disengaged');
      announce('takes the **Disengage** action', ctx);
      showToast({
        emoji: '🚶',
        message: applied
          ? 'Disengage — no opportunity attacks this turn'
          : 'Disengage announced — select a token to apply the condition',
        variant: 'info',
        duration: 3500,
      });
    },
  },
  {
    id: 'grapple',
    label: 'Grapple',
    emoji: '🤼',
    description: 'Grapple a creature up to one size larger than you. Make an Athletics check contested by the target\'s Athletics or Acrobatics.',
    cost: 'action',
    onClick: (ctx) => {
      announce('attempts to **Grapple**', ctx, '— contested Athletics vs Athletics/Acrobatics');
      showToast({ emoji: '🤼', message: 'Grapple — roll Athletics (contested)', variant: 'info', duration: 3500 });
    },
  },
  {
    id: 'shove',
    label: 'Shove',
    emoji: '🫸',
    description: 'Shove a creature up to one size larger prone or 5 ft away. Athletics vs target\'s Athletics/Acrobatics.',
    cost: 'action',
    onClick: (ctx) => {
      // Roll the caller's Athletics check; the opposed roll is the
      // target's problem (they roll back via their own quick-action
      // or the DM adjudicates). If we have a character with athletics
      // proficiency, include prof bonus; otherwise just STR mod.
      const strMod = abilityMod(ctx.character, 'str');
      const athleticsProf = ctx.character?.skills?.athletics ?? 'none';
      const profBonus = athleticsProf === 'expertise' ? (ctx.character?.proficiencyBonus ?? 0) * 2
        : athleticsProf === 'proficient' ? (ctx.character?.proficiencyBonus ?? 0)
        : 0;
      const total = strMod + profBonus;
      const actor = ctx.characterName ?? (ctx.isDM ? 'The DM' : 'The actor');
      emitRoll(`1d20${total >= 0 ? '+' : ''}${total}`, `${actor} Shove (Athletics, contested)`);
      if (ctx.selectedTokenId && ctx.inCombat) emitUseAction('action');
      announce('attempts to **Shove**', ctx, '— contested Athletics vs Athletics/Acrobatics');
      showToast({ emoji: '🫸', message: 'Shove — Athletics roll sent to chat', variant: 'info', duration: 3500 });
    },
  },
  {
    id: 'disarm',
    label: 'Disarm',
    emoji: '🗡️',
    description: 'Try to knock a weapon or item out of a creature\'s grasp. Attack roll (with disadvantage if target is larger); on hit, target makes a Strength or Dexterity save (DC = 8 + your STR/DEX mod + proficiency).',
    cost: 'action',
    onClick: (ctx) => {
      announce('attempts to **Disarm**', ctx, '— attack roll, on hit target saves STR/DEX vs your DC');
      showToast({ emoji: '🗡️', message: 'Disarm — attack roll, then target saves', variant: 'info', duration: 4000 });
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
      // Roll Stealth automatically so the DM and other players see the
      // result in chat. If we have a character, pull DEX mod + stealth
      // proficiency; otherwise a blank d20.
      const dexMod = abilityMod(ctx.character, 'dex');
      const stealthProf = ctx.character?.skills?.stealth ?? 'none';
      const profBonus = stealthProf === 'expertise' ? (ctx.character?.proficiencyBonus ?? 0) * 2
        : stealthProf === 'proficient' ? (ctx.character?.proficiencyBonus ?? 0)
        : 0;
      const total = dexMod + profBonus;
      const actor = ctx.characterName ?? (ctx.isDM ? 'The DM' : 'The actor');
      emitRoll(`1d20${total >= 0 ? '+' : ''}${total}`, `${actor} Hide (Stealth)`);
      if (ctx.selectedTokenId && ctx.inCombat) emitUseAction('action');
      announce('attempts to **Hide**', ctx, '— roll Stealth');
      showToast({ emoji: '🫥', message: 'Hide — Stealth roll sent to chat', variant: 'info', duration: 3500 });
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
      // Short Rest now runs directly (no dialog) — matches the
      // behaviour of the Long Rest button on this bar. Players can
      // still open the full character sheet's Short Rest dialog
      // to spend Hit Dice one at a time for manual HP recovery.
      performShortRest(ctx.character);
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

  const renderTiles = (actions: QuickAction[]) =>
    actions.map((a) => <QuickActionTile key={a.id} action={a} ctx={ctx} />);

  // Rest buttons only make sense for a player with a loaded character.
  // DMs don't have a "myCharacter" so clicking rest previously fired a
  // confusing "No characters loaded" toast; players whose character
  // hadn't finished loading yet hit the same message. Hide the group
  // entirely in those cases so the user-facing error disappears.
  const showRestActions = !!character && !isDM;

  return (
    <div style={styles.container}>
      {renderTiles(COMBAT_ACTIONS)}
      <div aria-hidden style={styles.separator} />
      {renderTiles(UTILITY_ACTIONS)}
      {showRestActions && (
        <>
          <div aria-hidden style={styles.separator} />
          {renderTiles(REST_ACTIONS)}
        </>
      )}
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
const TILE_HEIGHT = 40;

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: '100%',
    padding: `0 ${theme.space.md}px`,
  },
  separator: {
    width: 1,
    height: 28,
    background: 'rgba(232, 196, 85, 0.35)',
    flexShrink: 0,
    margin: `0 ${theme.space.xs}px`,
  },
  tile: {
    minWidth: 54,
    height: TILE_HEIGHT,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    padding: `0 ${theme.space.sm}px`,
    flexShrink: 0,
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
    fontSize: 13,
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
