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
      { name: 'bardic', usage: '!bardic <target> [d6|d8|d10|d12]', desc: 'Bardic Inspiration — grant a bonus die.' },
      { name: 'unbardic', usage: '!unbardic <target> [add|waste]', desc: 'Spend (add: rolls die) or waste the Bardic Inspiration.' },
      { name: 'smite', usage: '!smite <1-5> [undead|fiend] [crit]', desc: 'Paladin Divine Smite — spends slot, rolls radiant dice.' },
      { name: 'secondwind', usage: '!secondwind', desc: 'Fighter Second Wind — bonus action, heal 1d10 + level.' },
      { name: 'actionsurge', usage: '!actionsurge', desc: 'Fighter Action Surge — grants an extra action this turn.' },
      { name: 'cunning', usage: '!cunning <dash|disengage|hide>', desc: 'Rogue Cunning Action — bonus action version.' },
      { name: 'protect', usage: '!protect <ally>', desc: 'Protection fighting style (reaction + shield) — ally within 5 ft gets attack-against disadvantage.' },
      { name: 'pam', usage: '!pam <target>', desc: 'Polearm Master butt-end strike (bonus action, 1d4 bludgeoning).' },
      { name: 'uncanny', usage: '!uncanny <dmg>', desc: 'Rogue Uncanny Dodge reaction — halves incoming damage.' },
      { name: 'evasion', usage: '!evasion <pass|fail> <dmg>', desc: 'Rogue/Monk Evasion — no damage on save, half on fail (refund applied dmg).' },
      { name: 'cuttingwords', usage: '!cuttingwords <enemy>', desc: 'Bard Lore reaction — spends BI die to subtract from enemy roll.' },
      { name: 'ki', usage: '!ki status | use <n> | reset | set <n>', desc: 'Monk Ki pool (defaults to level).' },
      { name: 'flurry', usage: '!flurry', desc: 'Monk Flurry of Blows — 2 unarmed strikes (1 ki, bonus action).' },
      { name: 'patient', usage: '!patient', desc: 'Monk Patient Defense — Dodge as bonus action (1 ki).' },
      { name: 'stepwind', usage: '!stepwind <dash|disengage>', desc: 'Monk Step of the Wind — Dash/Disengage as bonus action (1 ki).' },
      { name: 'stunstrike', usage: '!stunstrike <target> <dc>', desc: 'Monk Stunning Strike (L5, 1 ki) — CON save vs stunned.' },
      { name: 'sp', usage: '!sp status | use <n> | reset | set <n>', desc: 'Sorcerer Sorcery Point pool.' },
      { name: 'meta', usage: '!meta <careful|distant|empowered|extended|heightened|quickened|seeking|subtle|twinned [lvl]>', desc: 'Sorcerer Metamagic — burns SP + announces effect.' },
      { name: 'flexible', usage: '!flexible slot2sp <lvl> | sp2slot <lvl>', desc: 'Sorcerer Flexible Casting — convert slots ↔ sorcery points.' },
      { name: 'xp', usage: '!xp <target…> <amount> | threshold | report', desc: 'Award XP (DM) or check thresholds + level ups.' },
      { name: 'wildshape', usage: '!wildshape <beast> <hp> [ac] [speed]', desc: 'Druid Wild Shape — announce + track beast HP pool.' },
      { name: 'revert', usage: '!revert', desc: 'Revert Wild Shape back to Druid form.' },
      { name: 'beast', usage: '!beast dmg|heal|status <n>', desc: 'Apply damage/heal to Wild-Shape beast pool.' },
      { name: 'reckless', usage: '!reckless', desc: 'Barbarian Reckless Attack — toggle until next turn.' },
      { name: 'endurance', usage: '!endurance | reset | status', desc: 'Half-Orc Relentless Endurance — drop to 1 HP instead of 0 (1/long rest).' },
      { name: 'arcanerecovery', usage: '!arcanerecovery', desc: 'Wizard short-rest slot recovery — announces budget.' },
      { name: 'breath', usage: '!breath <dice>/<ability>/<dc> <target1> […]', desc: 'Dragonborn Breath Weapon — rolls each target\'s save + applies damage.' },
      { name: 'eldritch', usage: '!eldritch <bolts> <cha-mod> [label]', desc: 'Eldritch Blast — rolls N beams, +CHA per beam with Agonizing Blast.' },
      { name: 'superiority', usage: '!superiority status | use | reset', desc: 'Battle Master Superiority Dice pool.' },
      { name: 'maneuver', usage: '!maneuver <name> [target] [dc]', desc: 'Battle Master maneuver — spends sup die, auto-rolls save if trip/pushing/disarming/menacing.' },
      { name: 'crit', usage: '!crit <d20>', desc: 'Champion Improved Crit check — is that 19 a crit for you?' },
      { name: 'encounter', usage: '!encounter <cr1> [cr2 …]', desc: 'Whisper the adjusted XP + difficulty rating (easy/medium/hard/deadly).' },
      { name: 'hd', usage: '!hd <n> [dN]', desc: 'Spend N Hit Dice — rolls from the sheet pool, adds CON × N, heals HP.' },
      { name: 'indomitable', usage: '!indomitable', desc: 'Fighter L9: reroll a failed save (1/2/3 per long rest at L9/L13/L17).' },
      { name: 'reliable', usage: '!reliable <d20>', desc: 'Rogue L11: treat d20<10 as 10 on proficient check.' },
      { name: 'lucky1', usage: '!lucky1 <d20>', desc: 'Halfling Lucky racial: reroll natural 1, must keep the new roll.' },
      { name: 'divinesense', usage: '!divinesense', desc: 'Paladin Divine Sense — detect celestial/fiend/undead in 60 ft.' },
      { name: 'songofrest', usage: '!songofrest', desc: 'Bard L2 — allies spending HD on short rest gain +d6/d8/d10/d12 HP.' },
      { name: 'surge', usage: '!surge', desc: 'Wild Magic Sorcerer — roll d100 on the chaos table.' },
      { name: 'ward', usage: '!ward status|init|dmg|heal|reset [n]', desc: 'Abjuration Wizard Arcane Ward HP pool.' },
      { name: 'courage', usage: '!courage', desc: 'Paladin L10 Aura of Courage — clears frightened from allies in radius.' },
      { name: 'sculpt', usage: '!sculpt <spell-level>', desc: 'Evocation Wizard Sculpt Spells — announce how many allies to exempt.' },
      { name: 'portent', usage: '!portent roll | use <d20> | list', desc: 'Diviner Wizard L2 — reserve 2-3 d20 rolls at dawn, swap into any roll.' },
      { name: 'colossus', usage: '!colossus', desc: 'Hunter Ranger L3 — +1d8 damage once/turn vs wounded target.' },
      { name: 'assassinate', usage: '!assassinate <target> <atk-bonus> [surprised]', desc: 'Assassin Rogue L3 — adv vs not-yet-acted, auto-crit on surprised.' },
      { name: 'guided', usage: '!guided', desc: 'War Cleric Channel Divinity — +10 to the attack roll just made.' },
      { name: 'hbc', usage: '!hbc <target> | clear <target>', desc: 'Hexblade\'s Curse — +prof dmg, 19-20 crit, HP regen on kill.' },
      { name: 'wrath', usage: '!wrath <attacker> <dc> [lightning|thunder]', desc: 'Tempest Cleric reaction — 2d8 on DEX save fail.' },
      { name: 'bear', usage: '!bear on | off', desc: 'Barbarian Bear Totem — resist all but psychic while raging.' },
      { name: 'stillness', usage: '!stillness', desc: 'Monk L7 — action: clears charmed + frightened on self.' },
      { name: 'fasthands', usage: '!fasthands [label]', desc: 'Thief Rogue L3 — bonus action Object Use / Sleight of Hand / Thieves\' Tools.' },
      { name: 'sacredweapon', usage: '!sacredweapon', desc: 'Devotion Paladin CD — +CHA attack, magical, shed light (1 min).' },
      { name: 'vow', usage: '!vow <target>', desc: 'Vengeance Paladin CD — advantage on attacks vs target (1 min).' },
      { name: 'discipleoflife', usage: '!discipleoflife <spell-level>', desc: 'Life Cleric — heal spells give +2 + level extra HP.' },
      { name: 'darkblessing', usage: '!darkblessing', desc: 'Fiend Warlock — gain CHA+level temp HP on kill.' },
      { name: 'feypresence', usage: '!feypresence <charm|fear> <target1> [target2 …]', desc: 'Archfey Warlock — WIS save vs charm/fear in 10 ft cube.' },
      { name: 'wardingflare', usage: '!wardingflare <attacker>', desc: 'Light Cleric reaction — impose disadvantage on an attack.' },
      { name: 'grimharvest', usage: '!grimharvest <spell-level> [necro]', desc: 'Necromancy Wizard — regain 2× (or 3× for necromancy) spell-level HP on kill.' },
      { name: 'lay', usage: '!lay <target> <amount>', desc: 'Paladin Lay on Hands — heal target (track ≤ 5*level/day).' },
      { name: 'channel', usage: '!channel <effect>', desc: 'Cleric / Paladin Channel Divinity — DM-narrated effect.' },
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
    title: 'Attunement',
    entries: [
      { name: 'attune', usage: '!attune <item> | list', desc: 'Attune to an item in your inventory (cap: 3).' },
      { name: 'unattune', usage: '!unattune <item>', desc: 'Break attunement with an item.' },
    ],
  },
  {
    title: 'Combat — maneuvers',
    entries: [
      { name: 'grapple', usage: '!grapple <target>', desc: 'Caller Athletics vs target Athletics/Acrobatics — on win, target is grappled.' },
      { name: 'shove', usage: '!shove <target> [prone|push]', desc: 'Caller Athletics vs target Athletics/Acrobatics — on win, target is knocked prone (default) or shoved 5 ft.' },
      { name: 'legendary', usage: '!legendary <target> [action] | set <target> <max> | clear <target>', desc: 'Monster legendary-action budget. Spends one, refreshes on monster\'s own turn.' },
      { name: 'legres', usage: '!legres <target> | set <target> <max> | list | reset', desc: 'Legendary Resistance pool. Spend one to flip a failed save into a success.' },
      { name: 'lair', usage: '!lair enable|disable <target> | <target> <action> | list', desc: 'Lair actions — reminder at round start (init 20). DM narrates the action.' },
      { name: 'recharge', usage: '!recharge set <target> <ability> <min> | use <target> <ability> | list <target> | clear <target>', desc: 'Track monster recharge abilities (breath weapon). Auto-rolls 1d6 on turn start.' },
    ],
  },
  {
    title: 'HP / damage',
    entries: [
      { name: 'hp', usage: '!hp <target> <value>', dmOnly: true, desc: 'Set a token\'s current HP.' },
      { name: 'damage', usage: '!damage <target> <amount>', dmOnly: true, desc: 'Subtract HP, fires concentration save.' },
      { name: 'heal', usage: '!heal <target> <amount>', dmOnly: true, desc: 'Add HP up to max.' },
      { name: 'thp', usage: '!thp <amount> [target]', desc: 'Set temp HP — 0 clears, higher replaces, lower keeps existing (RAW).' },
      { name: 'potion', usage: '!potion <target> [dice]', desc: 'Drink a healing potion (default 2d4+2).' },
      { name: 'stabilize', usage: '!stabilize <target>', desc: 'Medicine DC 10 — stabilize a 0-HP creature.' },
    ],
  },
  {
    title: 'Damage riders / concentration spells',
    entries: [
      { name: 'hex', usage: '!hex <target> / !unhex', desc: 'Warlock Hex — caster\'s attacks deal +1d6 necrotic vs target.' },
      { name: 'mark', usage: '!mark <target> / !unmark', desc: 'Ranger Hunter\'s Mark — caster\'s weapon attacks deal +1d6.' },
      { name: 'turnundead', usage: '!turnundead <target> [target2 …]', desc: 'Cleric/Paladin CD — WIS save vs fright for 1 min.' },
      { name: 'bless', usage: '!bless <target1> [target2] [target3]', desc: 'Apply blessed (+1d4 attacks + saves, 10 rounds).' },
      { name: 'bane', usage: '!bane <target1> [target2] [target3] <dc>', desc: 'Apply baned (-1d4 attacks + saves, 10 rounds).' },
      { name: 'faeriefire', usage: '!faeriefire <target1> [target2 …] <dc>', desc: 'Apply outlined (adv to attackers, no invisibility).' },
      { name: 'holdperson', usage: '!holdperson <target> <dc>', desc: 'Paralyze a humanoid. WIS save at end of each turn, 1 min.' },
      { name: 'holdmonster', usage: '!holdmonster <target> <dc>', desc: 'Paralyze any creature. WIS save at end of each turn.' },
      { name: 'sleep', usage: '!sleep <target>', desc: 'Knock target unconscious. Ends on any damage. 1 min max.' },
      { name: 'fear', usage: '!fear <target> <dc>', desc: 'Frighten target for 1 min. WIS save at end of each turn.' },
      { name: 'slow', usage: '!slow <target> <dc>', desc: 'Slow target for 1 min. -2 AC/DEX, half speed, no reactions.' },
      { name: 'ritual', usage: '!ritual <spell>', desc: 'Cast a ritual-tagged spell without a slot (+10 min).' },
      { name: 'components', usage: '!components <spell>', desc: 'Check V/S/M components — warns if silenced or hands full.' },
    ],
  },
  {
    title: 'Meta',
    entries: [
      { name: 'lucky', usage: '!lucky use | status | reset', desc: 'Lucky feat — spend a luck point to roll an extra d20 (3/long rest).' },
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
      { name: 'save', usage: '!save <ability> <dc> <dice>/<type> <target1> [target2 …]', dmOnly: true, desc: 'Resolve a spell save + damage against multiple targets. Half on save.' },
      { name: 'stealth', usage: '!stealth [hide]', desc: 'Roll Stealth vs each visible enemy\'s passive Perception. `hide` auto-applies the badge if you beat them all.' },
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
