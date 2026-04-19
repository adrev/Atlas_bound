export interface RuleEntry {
  slug: string;
  name: string;
  snippet: string;
  description: string;
}

/**
 * Static 5e rules glossary surfaced in the Wiki. Not authoritative —
 * paraphrased for quick table reference. Stored client-side as
 * constants so the wiki never has to hit the server for these.
 *
 * Ordered by topic family (Actions first, then Saves / Checks, then
 * Combat geometry). The DetailPopup treats `description` as
 * markdown-ish text (newlines render as paragraph breaks, `**bold**`
 * rendered via the ReactMarkdown path already in place).
 */
export const RULES_GLOSSARY: RuleEntry[] = [
  {
    slug: 'advantage-disadvantage',
    name: 'Advantage & Disadvantage',
    snippet: 'Roll 2d20, keep higher (adv) or lower (disadv).',
    description: [
      'When you have **advantage**, roll two d20s and use the higher result.',
      'When you have **disadvantage**, roll two d20s and use the lower result.',
      'If one circumstance gives advantage and another disadvantage on the same roll, the two cancel out — you just roll one d20, no matter how many of each you have.',
      'You can never stack advantage or disadvantage; they don\'t accumulate.',
    ].join('\n\n'),
  },
  {
    slug: 'action',
    name: 'Action',
    snippet: 'On your turn: Attack, Cast, Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use Object.',
    description: [
      'On your turn you can take one **Action** in addition to a move and any reactions you can muster. Common actions:',
      '- **Attack** — one weapon attack (two at higher levels for fighters, rangers, etc.)',
      '- **Cast a Spell** — a single casting of a spell with a casting time of 1 action',
      '- **Dash** — double your speed this turn',
      '- **Disengage** — movement doesn\'t provoke opportunity attacks',
      '- **Dodge** — attacks against you have disadvantage until your next turn',
      '- **Help** — grant an ally advantage on their next check or attack',
      '- **Hide** — roll Dexterity (Stealth) to become hidden',
      '- **Ready** — prepare an action + trigger to fire on another creature\'s turn',
      '- **Search** — roll Wisdom (Perception) or Intelligence (Investigation)',
      '- **Use an Object** — interact with a second object (the first is free)',
    ].join('\n\n'),
  },
  {
    slug: 'bonus-action',
    name: 'Bonus Action',
    snippet: 'One per turn, only if a feature grants it.',
    description: 'A **Bonus Action** is an extra action you can take on your turn only when a specific class feature, spell, or item grants one. Examples: a Monk spending a ki point for a Flurry of Blows, a Rogue using Cunning Action (Dash / Disengage / Hide), Two-Weapon Fighting to attack with your off-hand. You can take only one bonus action per turn, and you must have a specific source to trigger it — there is no default bonus action.',
  },
  {
    slug: 'reaction',
    name: 'Reaction',
    snippet: 'Instant response triggered off-turn. One per round.',
    description: 'A **Reaction** is an instant response to a trigger that happens outside of your turn. You can take only one reaction per round, and you regain it at the start of your turn. The most common example is an **Opportunity Attack** — a creature within your reach that moves out of it provokes a melee attack. Other reactions include casting Shield, Counterspell, a Ready action triggering, or class-specific features (e.g. a Rogue\'s Uncanny Dodge).',
  },
  {
    slug: 'opportunity-attack',
    name: 'Opportunity Attack',
    snippet: 'Melee attack when a creature leaves your reach.',
    description: 'When a hostile creature you can see moves out of your **reach** (usually 5 ft for most melee weapons), you can use your reaction to make a single melee attack against it. You don\'t provoke an opportunity attack if you **Disengage**, if the creature teleports, or if the movement is forced (e.g. shoved, or pulled by a spell like Thorn Whip).',
  },
  {
    slug: 'cover',
    name: 'Cover',
    snippet: 'Half (+2 AC), Three-Quarters (+5 AC), Total (immune).',
    description: [
      'A target benefits from cover if at least half of it is obscured by an obstacle:',
      '- **Half cover** — +2 to AC and Dexterity saves. Low walls, medium-sized creatures, furniture.',
      '- **Three-quarters cover** — +5 to AC and Dexterity saves. Arrowslits, tree trunks.',
      '- **Total cover** — can\'t be targeted directly. Must be fully concealed.',
      'A target only gets cover from the most protective source — they don\'t stack.',
    ].join('\n\n'),
  },
  {
    slug: 'saving-throw',
    name: 'Saving Throw',
    snippet: 'd20 + ability mod + proficiency (if proficient) vs DC.',
    description: 'A **saving throw** resists a specific threat — a spell, trap, poison, or hazard. Roll a d20, add the relevant ability modifier (STR / DEX / CON / INT / WIS / CHA), add your proficiency bonus if you\'re proficient in saves with that ability, and compare the total to the effect\'s **save DC**. Meet or beat the DC = you succeed. Most classes are proficient in exactly two save abilities determined by class (e.g. Wizard = INT + WIS).',
  },
  {
    slug: 'ability-check',
    name: 'Ability Check',
    snippet: 'd20 + ability mod + proficiency (if skill-proficient).',
    description: 'When you try to do something whose outcome isn\'t certain, the DM may call for an **ability check** — usually a skill check like Stealth, Perception, or Athletics. Roll a d20, add the ability modifier (the one governing that skill), and add your proficiency bonus if you\'re proficient in the skill (double it with **expertise**). The result is compared against a DC set by the DM.',
  },
  {
    slug: 'critical-hit',
    name: 'Critical Hit',
    snippet: 'Nat 20 on attack: double weapon dice.',
    description: 'Rolling a natural 20 on an **attack roll** is always a **critical hit**, regardless of the target\'s AC. Roll all the attack\'s damage dice twice and add them together — then add any modifiers once. Extra dice from features like Sneak Attack or a paladin\'s Divine Smite also double. A natural 1 on an attack roll is an automatic **miss**, with no bonuses considered.',
  },
  {
    slug: 'concentration',
    name: 'Concentration',
    snippet: 'Sustain a spell; CON save on damage (DC = max(10, dmg/2)).',
    description: 'Some spells require you to maintain **concentration** to keep their magic going. You can only concentrate on one spell at a time — casting a new concentration spell ends the old one immediately. When you take damage while concentrating, make a **Constitution saving throw** with a DC equal to 10 or half the damage taken, whichever is higher. If you fail, you lose concentration and the spell ends.',
  },
  {
    slug: 'short-rest',
    name: 'Short Rest',
    snippet: '1 hour. Spend hit dice to recover HP. Short-rest class features reset.',
    description: 'A **Short Rest** is at least **1 hour** of light activity — eating, tending wounds, reading. During or at the end of it, you can spend any number of your **Hit Dice** to recover HP: roll each and add your Constitution modifier, up to your total HD pool. You also regain any class features keyed to a short rest (e.g. a Warlock\'s spell slots, a Fighter\'s Second Wind / Action Surge, a Monk\'s ki).',
  },
  {
    slug: 'long-rest',
    name: 'Long Rest',
    snippet: '8 hours. Full HP, half max HD, all slots, most features reset.',
    description: 'A **Long Rest** is at least **8 hours** with ≤1 hour of walking/fighting/reading. At the end, you regain **all lost HP**, **half your total Hit Dice** (minimum 1), **all spell slots**, and any class features keyed to a long rest. You can only benefit from one long rest per 24 hours, and you must have at least 1 HP at the start — an unconscious character can\'t begin one.',
  },
  {
    slug: 'grappling',
    name: 'Grapple',
    snippet: 'Replace an attack: STR (Athletics) vs STR (Athletics) / DEX (Acrobatics).',
    description: 'As an **Attack action**, you can try to **grapple** a creature no more than one size larger than you. Replace one of your attacks with a contested check: your **Strength (Athletics)** vs the target\'s **Strength (Athletics) or Dexterity (Acrobatics)**, their choice. On success, the target\'s speed becomes 0 and moves with you at half your speed if you drag them. The grapple ends if the target moves out of reach or you\'re incapacitated.',
  },
  {
    slug: 'shove',
    name: 'Shove',
    snippet: 'Replace an attack: knock prone or push 5 ft.',
    description: 'As an **Attack action**, you can replace one attack with a **Shove**: same contested check as Grapple (STR Athletics vs STR Athletics / DEX Acrobatics). On success, you either knock the target **prone** or push them **5 ft away**. You can only shove a creature up to one size larger than yourself.',
  },
  {
    slug: 'surprise',
    name: 'Surprise',
    snippet: 'Unaware combatants can\'t act or react on round 1.',
    description: 'At the start of combat, any combatant who is **surprised** — typically because they were unaware of the ambushers — takes no turn on the first round and can\'t take reactions until the end of that turn. They still roll initiative normally. The **Alert feat** makes you immune to being surprised while conscious.',
  },
];
