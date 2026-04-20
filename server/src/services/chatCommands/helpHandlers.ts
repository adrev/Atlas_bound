import {
  registerChatCommand,
  whisperToCaller,
  type ChatCommandContext,
} from '../ChatCommands.js';

/**
 * !help — whisper a catalog of chat commands back to the caller.
 * Grouped by function so it's scannable. Kept as a static table
 * rather than a registry-introspection call: having human-written
 * one-liners per command is worth the duplication, and the list
 * changes slowly enough that drift is easy to catch in PR review.
 */

interface Entry { name: string; usage: string; dmOnly?: boolean; desc: string; }

const GROUPS: Array<{ title: string; entries: Entry[] }> = [
  {
    title: 'Combat — conditions',
    entries: [
      { name: 'cond', usage: '!cond <target> <name> [rounds]', dmOnly: true, desc: 'Apply a 5e condition; auto-expires if rounds given.' },
      { name: 'uncond', usage: '!uncond <target> <name>', dmOnly: true, desc: 'Clear a condition from a token.' },
      { name: 'rage', usage: '!rage [target]', desc: 'Enter Rage (+dmg/resist b-p-s) for 10 rounds.' },
      { name: 'unrage', usage: '!unrage [target]', desc: 'End Rage voluntarily.' },
      { name: 'inspire', usage: '!inspire <target>', dmOnly: true, desc: 'Award Inspiration — advantage on next roll.' },
      { name: 'uninspire', usage: '!uninspire [target]', desc: 'Spend / clear Inspiration.' },
      { name: 'assist', usage: '!assist <target>', desc: 'Help action — advantage on target\'s next attack or check.' },
      { name: 'unassist', usage: '!unassist [target]', desc: 'Clear the helped badge after the assisted action.' },
      { name: 'smite', usage: '!smite <1-5> [undead|fiend] [crit]', desc: 'Paladin Divine Smite — spends slot, rolls radiant dice.' },
      { name: 'power', usage: '!power [target] [on|off]', desc: 'GWM / Sharpshooter -5 / +10 toggle.' },
      { name: 'cover', usage: '!cover <target> <none|half|three|full>', dmOnly: true, desc: '+0 / +2 / +5 AC cover bonuses.' },
    ],
  },
  {
    title: 'Combat — DM turn hooks',
    entries: [
      { name: 'onturn', usage: '!onturn <target> <message>', dmOnly: true, desc: 'Broadcast <message> when <target>\'s turn starts.' },
      { name: 'onround', usage: '!onround <message>', dmOnly: true, desc: 'Broadcast at the start of each new round.' },
      { name: 'unhook', usage: '!unhook <target|round> [index]', dmOnly: true, desc: 'Clear queued hooks.' },
    ],
  },
  {
    title: 'Rests',
    entries: [
      { name: 'rest', usage: '!rest <short|long> [target]', dmOnly: true, desc: 'Trigger a rest on the whole party or a single target — runs performLongRest/ShortRest on each PC\'s client.' },
    ],
  },
  {
    title: 'Combat — maneuvers',
    entries: [
      { name: 'grapple', usage: '!grapple <target>', desc: 'Caller Athletics vs target Athletics/Acrobatics — on win, target is grappled.' },
      { name: 'shove', usage: '!shove <target> [prone|push]', desc: 'Caller Athletics vs target Athletics/Acrobatics — on win, target is knocked prone (default) or shoved 5 ft.' },
      { name: 'legendary', usage: '!legendary <target> [action] | set <target> <max> | clear <target>', desc: 'Monster legendary-action budget. Spends one, refreshes on monster\'s own turn.' },
    ],
  },
  {
    title: 'HP / damage',
    entries: [
      { name: 'hp', usage: '!hp <target> <value>', dmOnly: true, desc: 'Set a token\'s current HP.' },
      { name: 'damage', usage: '!damage <target> <amount>', dmOnly: true, desc: 'Subtract HP, fires concentration save.' },
      { name: 'heal', usage: '!heal <target> <amount>', dmOnly: true, desc: 'Add HP up to max.' },
      { name: 'thp', usage: '!thp <amount> [target]', desc: 'Set temp HP — 0 clears, higher replaces, lower keeps existing (RAW).' },
    ],
  },
  {
    title: 'Notes',
    entries: [
      { name: 'note', usage: '!note <title> | <body>', desc: 'Post a note visible to the whole party.' },
      { name: 'pcnote', usage: '!pcnote <title> | <body>', desc: 'Note visible only to PCs (not DM).' },
      { name: 'gmnote', usage: '!gmnote <title> | <body>', dmOnly: true, desc: 'DM-only note.' },
    ],
  },
  {
    title: 'Area of effect',
    entries: [
      { name: 'aoe', usage: '!aoe <shape> <size> [color]', dmOnly: true, desc: 'Drop a timed AoE template on the canvas.' },
    ],
  },
  {
    title: 'Dice',
    entries: [
      { name: 'roll', usage: '/roll <notation>', desc: 'Roll dice (3D physical roll). Alias: /r' },
    ],
  },
];

function formatHelp(isDM: boolean): string {
  const lines: string[] = ['**Chat commands** (case-insensitive):'];
  for (const g of GROUPS) {
    const visible = g.entries.filter((e) => isDM || !e.dmOnly);
    if (visible.length === 0) continue;
    lines.push('');
    lines.push(`__${g.title}__`);
    for (const e of visible) {
      const dmBadge = e.dmOnly ? ' [DM]' : '';
      lines.push(`\`${e.usage}\`${dmBadge} — ${e.desc}`);
    }
  }
  return lines.join('\n');
}

async function handleHelp(c: ChatCommandContext): Promise<boolean> {
  whisperToCaller(c.io, c.ctx, formatHelp(c.ctx.player.role === 'dm'));
  return true;
}

registerChatCommand(['help', 'commands', '?'], handleHelp);
