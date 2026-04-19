export interface FeatEntry {
  slug: string;
  name: string;
  prerequisite?: string;
  snippet: string;
  description: string;
}

/**
 * 5e feats surfaced in the Wiki. Static client-side data — no server
 * round-trip. Paraphrased descriptions, not book text. The order
 * matches the wiki's usual grouping (combat → general → spellcasting)
 * so the list reads top-down in a useful way.
 */
export const FEATS: FeatEntry[] = [
  {
    slug: 'alert',
    name: 'Alert',
    snippet: '+5 initiative, immune to surprise, hidden attackers no advantage.',
    description: [
      '**+5** to initiative rolls.',
      'Cannot be **surprised** while conscious — you act normally on round 1 of any ambush.',
      'Other creatures do not gain advantage on attacks against you from being unseen or hidden.',
    ].join('\n\n'),
  },
  {
    slug: 'great-weapon-master',
    name: 'Great Weapon Master',
    prerequisite: 'Proficiency with a heavy weapon',
    snippet: 'Bonus action attack on crit or kill. Optional −5 atk / +10 dmg.',
    description: [
      'On your turn, when you **score a critical hit** with a melee weapon or **reduce a creature to 0 HP** with one, you can make **one melee weapon attack as a bonus action**.',
      'Before making a melee attack with a **heavy** weapon you\'re proficient with, you can choose to take **−5 to the attack roll** in exchange for **+10 to the damage roll** if it hits.',
    ].join('\n\n'),
  },
  {
    slug: 'sharpshooter',
    name: 'Sharpshooter',
    prerequisite: 'Proficiency with a ranged weapon',
    snippet: 'No long-range disadvantage. No cover penalty. −5/+10 trade.',
    description: [
      'Attacking at **long range** doesn\'t impose disadvantage on your ranged weapon attacks.',
      'Ranged weapon attacks ignore **half cover** and **three-quarters cover**.',
      '−5 to the attack roll in exchange for **+10 damage** on ranged weapon attacks with a weapon you\'re proficient in.',
    ].join('\n\n'),
  },
  {
    slug: 'polearm-master',
    name: 'Polearm Master',
    snippet: 'Bonus action butt-end 1d4. OA triggers on entering reach.',
    description: [
      'When you take the Attack action and attack with only a glaive, halberd, pike, or quarterstaff, you can use a **bonus action** to make a melee attack with the butt end of the weapon (**1d4 bludgeoning**, same modifiers as the main attack).',
      'While you\'re wielding such a weapon, other creatures provoke an **opportunity attack** from you when they **enter your reach**, not just when they leave it.',
    ].join('\n\n'),
  },
  {
    slug: 'sentinel',
    name: 'Sentinel',
    snippet: 'Hits from OAs set speed to 0. Disengage no longer prevents OAs from you.',
    description: [
      'When you hit a creature with an **opportunity attack**, the creature\'s **speed becomes 0** for the rest of the turn.',
      'Creatures provoke opportunity attacks from you **even if they take the Disengage action** before leaving your reach.',
      'When a creature within 5 ft of you attacks a target other than you (and that target doesn\'t have this feat), you can use your **reaction to make a melee weapon attack** against the attacking creature.',
    ].join('\n\n'),
  },
  {
    slug: 'war-caster',
    name: 'War Caster',
    prerequisite: 'The ability to cast at least one spell',
    snippet: 'Advantage on concentration CON saves. Can cast OAs. Cast while dual-wielding.',
    description: [
      'You have **advantage on Constitution saving throws** to maintain concentration on a spell when you take damage.',
      'You can perform the somatic components of spells even when you have weapons or a shield in one or both hands.',
      'When a hostile creature\'s movement provokes an opportunity attack from you, you can use your **reaction to cast a spell at the creature**, rather than making an opportunity attack — the spell must have a casting time of 1 action and target only that creature.',
    ].join('\n\n'),
  },
  {
    slug: 'lucky',
    name: 'Lucky',
    snippet: '3 luck points/long rest. Reroll attack, check, or save.',
    description: [
      'You have **3 luck points** that refresh on a long rest.',
      'Spend 1 to **roll an additional d20** when you make an attack roll, ability check, or saving throw, and choose which of the two d20s to use.',
      'Also spend when an attacker rolls against you — roll a d20 and choose which of the attacker\'s d20s is used.',
    ].join('\n\n'),
  },
  {
    slug: 'tough',
    name: 'Tough',
    snippet: '+2 HP per level (including past levels).',
    description: 'Your **hit point maximum increases by 2 for every level you have** (and every level you gain after taking the feat). Applied retroactively — a level 5 character gains +10 HP the moment they pick Tough.',
  },
  {
    slug: 'resilient',
    name: 'Resilient',
    snippet: '+1 to one ability. Proficiency in saving throws with that ability.',
    description: [
      'Choose one ability score. You gain the following benefits:',
      '- **+1 increase** to that ability (to a max of 20).',
      '- Gain **proficiency in saving throws** with that ability.',
    ].join('\n\n'),
  },
  {
    slug: 'mobile',
    name: 'Mobile',
    snippet: '+10 speed. Dash through difficult terrain. Immune to OAs from melee-attacked targets.',
    description: [
      'Your speed **increases by 10 feet**.',
      'When you use the **Dash** action, **difficult terrain doesn\'t cost you extra movement** that turn.',
      'When you make a melee attack against a creature, **you don\'t provoke an opportunity attack from that creature** for the rest of the turn, whether you hit or not.',
    ].join('\n\n'),
  },
  {
    slug: 'healer',
    name: 'Healer',
    snippet: 'Healer\'s Kit: stabilize + 1 HP. As an action: 1d6+4+level HP, once per short rest.',
    description: [
      'When you use a **healer\'s kit** to stabilize a dying creature, that creature also regains **1 hit point**.',
      'As an **action**, you can spend one use of a healer\'s kit to tend to a creature and restore **1d6 + 4 + the creature\'s maximum number of Hit Dice** hit points. The creature can\'t regain hit points from this feat again until it finishes a short or long rest.',
    ].join('\n\n'),
  },
  {
    slug: 'inspiring-leader',
    name: 'Inspiring Leader',
    prerequisite: 'Charisma 13+',
    snippet: '10-minute speech grants each ally temp HP = level + CHA mod.',
    description: 'You can spend **10 minutes** inspiring up to **6 friendly creatures** (including yourself) who can see or hear you and can understand you. Each gains **temporary hit points equal to your level + your Charisma modifier**. A creature can\'t receive temp HP from this feat again until it finishes a short or long rest.',
  },
  {
    slug: 'defensive-duelist',
    name: 'Defensive Duelist',
    prerequisite: 'Dexterity 13+',
    snippet: 'Reaction: +proficiency bonus to AC vs one melee attack.',
    description: 'When you are wielding a finesse weapon with which you are proficient and another creature hits you with a melee attack, you can use your **reaction** to add your **proficiency bonus to your AC for that attack**, potentially turning the hit into a miss.',
  },
  {
    slug: 'magic-initiate',
    name: 'Magic Initiate',
    snippet: 'Learn 2 cantrips + one 1st-level spell (once/long rest) from one class.',
    description: [
      'Choose a class: bard, cleric, druid, sorcerer, warlock, or wizard.',
      'You learn **two cantrips** of your choice from that class\'s spell list.',
      'You also learn **one 1st-level spell** from that list — you can cast it at its lowest level, and must finish a long rest before casting it again with this feat. (You can still cast it if you have other spell slots available.)',
      'Your spellcasting ability is the one tied to the class you chose.',
    ].join('\n\n'),
  },
];
