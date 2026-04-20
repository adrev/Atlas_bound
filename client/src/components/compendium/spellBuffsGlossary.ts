import type { RuleSource } from '@dnd-vtt/shared';

export interface SpellBuffEntry {
  slug: string;
  name: string;
  snippet: string;
  description: string;
  color?: string;
  source?: RuleSource;
}

/**
 * Common pseudo-conditions the VTT tracks from spells / class features —
 * distinct from the 15 5e standard conditions but show up in the chat
 * roll-modifier line and on token badge strips, so players need a
 * wiki definition. All PHB-sourced (default).
 */
export const SPELL_BUFFS: SpellBuffEntry[] = [
  {
    slug: 'blessed',
    name: 'Blessed',
    color: '#f1c40f',
    snippet: '+1d4 to attacks + saves.',
    description: [
      'Under the effect of the **Bless** spell (concentration, 1 min). You add **1d4** to each attack roll AND saving throw you make while the spell is active.',
      'Works alongside advantage — the d4 is a flat addition, not a die replacement.',
    ].join('\n\n'),
  },
  {
    slug: 'baned',
    name: 'Baned',
    color: '#c0392b',
    snippet: '−1d4 to attacks + saves.',
    description: 'Under the effect of the **Bane** spell (concentration, 1 min). You **subtract 1d4** from every attack roll and saving throw until the spell ends or you make the initial CHA save to avoid it. The reverse of Bless — stacks against other penalties, never against the same caster\'s Bless.',
  },
  {
    slug: 'hasted',
    name: 'Hasted',
    color: '#3498db',
    snippet: 'Speed x2, +2 AC, advantage on DEX saves, extra 1-attack action.',
    description: [
      'Under the effect of **Haste** (concentration, 1 min). You get:',
      '- **+2 AC**',
      '- **Advantage on DEX saving throws**',
      '- **Speed doubled**',
      '- One additional **action** on each of your turns, limited to: the Attack (one weapon attack only), Dash, Disengage, Hide, or Use an Object action.',
      'When the spell ends, the affected creature can\'t move or take actions until after its next turn — the lethargy penalty.',
    ].join('\n\n'),
  },
  {
    slug: 'slowed',
    name: 'Slowed',
    color: '#8e44ad',
    snippet: 'Half speed, −2 AC + DEX save, only one attack or reaction.',
    description: [
      'Under the effect of the **Slow** spell (WIS save, concentration, 1 min). You suffer:',
      '- **Half speed**',
      '- **−2 AC and −2 on DEX saves**',
      '- Can\'t take **reactions**',
      '- On its turn, can only take a single **Action** — not a bonus + action — and can\'t take a bonus action at all',
      '- If it tries to **cast a spell** with casting time of 1 action, roll a d20; on 1–10 the spell fails.',
    ].join('\n\n'),
  },
  {
    slug: 'dodging',
    name: 'Dodging',
    color: '#2ecc71',
    snippet: 'Attacks against have disadvantage; DEX saves with advantage.',
    description: 'You took the **Dodge** action. Until the start of your next turn, attack rolls against you have **disadvantage** (if you can see the attacker) and you make DEX saving throws with **advantage**. You lose the benefit if you\'re incapacitated or your speed drops to 0.',
  },
  {
    slug: 'disengaged',
    name: 'Disengaged',
    color: '#27ae60',
    snippet: 'Movement this turn doesn\'t provoke opportunity attacks.',
    description: 'You took the **Disengage** action. Your movement doesn\'t provoke opportunity attacks for the rest of the turn. Useful to step away from a front-liner without getting smacked on the way out.',
  },
  {
    slug: 'hidden',
    name: 'Hidden',
    color: '#95a5a6',
    snippet: 'Attack rolls against have disadvantage until spotted.',
    description: 'Successfully hidden via the **Hide** action (Dex Stealth vs target\'s passive Perception). Attack rolls against you have disadvantage until a creature actively searches or you leave cover. You have advantage on your first attack from hiding — after which you\'re revealed.',
  },
  {
    slug: 'raging',
    name: 'Raging',
    color: '#e74c3c',
    snippet: 'Advantage on STR, +2 damage, resistance to b/p/s.',
    description: 'Under the effect of a Barbarian\'s **Rage** feature. Advantage on Strength checks and Strength saving throws. Bonus damage on melee Strength attacks (+2 at level 1, scaling with barbarian level). Resistance to bludgeoning, piercing, and slashing damage. Ends after 1 minute or if a turn passes without attacking / taking damage.',
  },
  {
    slug: 'concentrating',
    name: 'Concentrating',
    color: '#1abc9c',
    snippet: 'Sustaining a spell. Drop on failed CON save or incapacitation.',
    description: [
      'Maintaining a spell that requires concentration. When you take damage, make a **Constitution saving throw** (DC = max(10, half the damage taken)) or the spell ends.',
      'You can only concentrate on one spell at a time — casting a new concentration spell immediately ends the old one. Becoming incapacitated (stunned, unconscious, paralyzed, petrified) also drops concentration.',
    ].join('\n\n'),
  },
  {
    slug: 'half-cover',
    name: 'Half Cover',
    color: '#7f8c8d',
    snippet: '+2 AC and +2 DEX saves against ranged/targeted effects.',
    description: [
      'Standing behind a low wall, a piece of furniture, another creature, or a narrow tree. **+2 bonus to AC** and **+2 to DEX saves** against attacks or effects that originate from the other side of the cover.',
      'DM toggles with `!cover <target> half`. Clear with `!cover <target> none`.',
    ].join('\n\n'),
  },
  {
    slug: 'three-quarters-cover',
    name: 'Three-Quarters Cover',
    color: '#576574',
    snippet: '+5 AC and +5 DEX saves against ranged/targeted effects.',
    description: [
      'Behind an arrow slit, thick tree trunk, portcullis, or partially open doorway. **+5 bonus to AC** and **+5 to DEX saves** against attacks or effects that originate from the other side.',
      'DM toggles with `!cover <target> three`. Clear with `!cover <target> none`.',
    ].join('\n\n'),
  },
  {
    slug: 'full-cover',
    name: 'Full Cover',
    color: '#2c3e50',
    snippet: 'Cannot be targeted directly by attack or targeted spell.',
    description: [
      'Completely obscured — behind a solid wall, total blockage, etc. **Cannot be targeted directly** by attacks or targeted spells. Area-of-effect spells may still reach around corners depending on shape.',
      'DM toggles with `!cover <target> full`. Clear with `!cover <target> none`.',
    ].join('\n\n'),
  },
  {
    slug: 'helped',
    name: 'Helped',
    color: '#5cb77a',
    snippet: 'Advantage on the next attack or ability check (Help action).',
    description: [
      'An ally just took the **Help** action to assist you. On your **next attack roll** or **ability check**, you have **advantage**. Once consumed, the badge should clear — `!unassist [target]` or the DM removes it manually.',
      'Apply: `!assist <target>`. Helper must be able to meaningfully assist (within 5 ft of the target of an attack, or proficient with the tool / skill for a check).',
    ].join('\n\n'),
  },
  {
    slug: 'inspired',
    name: 'Inspired',
    color: '#f39c12',
    snippet: 'Holding Inspiration — expend for advantage on a roll.',
    description: [
      'You\'ve been awarded **Inspiration** by the DM for great roleplay or a heroic moment. You can expend it on any **attack roll, ability check, or saving throw** to gain **advantage** on that roll.',
      'Award: `!inspire <target>` (DM-only). Spend: `!uninspire [target]` (player or DM).',
    ].join('\n\n'),
  },
  {
    slug: 'power-attack',
    name: 'Power Attack',
    color: '#e67e22',
    snippet: '-5 to hit, +10 damage (GWM heavy melee or Sharpshooter ranged).',
    description: [
      'The **Great Weapon Master** and **Sharpshooter** feats let an attacker trade accuracy for damage: **-5 on the attack roll, +10 on the damage roll**.',
      '- GWM requires a **heavy melee weapon** (greatsword, maul, greataxe, polearm with the Heavy tag).',
      '- Sharpshooter requires a **ranged weapon attack**. Also lets the attacker ignore half and three-quarters cover.',
      'The attacker must actually have the matching feat for the trade-off to apply. Toggle with `!power [target] [on|off]`. Leave the badge on to keep committing each round.',
    ].join('\n\n'),
  },
];
