import type { RuleSource } from '@dnd-vtt/shared';

export interface FeatEntry {
  slug: string;
  name: string;
  prerequisite?: string;
  snippet: string;
  description: string;
  /** Rulebook this feat comes from. Absent = PHB (the default). Set
   *  explicitly for Xanathar / Tasha / etc. entries so the wiki can
   *  filter by the DM's enabled rulebooks. */
  source?: RuleSource;
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

  // --- PHB feats we hadn't surfaced yet ---
  {
    slug: 'actor',
    name: 'Actor',
    snippet: '+1 CHA. Advantage on Deception/Performance for impersonation. Mimic voices.',
    description: [
      '**+1 Charisma** (max 20).',
      '**Advantage on Deception and Performance** checks when trying to pass yourself off as a different person.',
      'You can mimic the speech of another person or the sounds of other creatures after listening for 1 minute. Insight vs your Deception to detect the ruse.',
    ].join('\n\n'),
  },
  {
    slug: 'athlete',
    name: 'Athlete',
    snippet: '+1 STR/DEX. Stand from prone with 5 ft. Climb at full speed. Running long jump after 5 ft.',
    description: [
      '**+1 to Strength or Dexterity** (max 20).',
      'Standing up from **prone** costs you only **5 feet of movement**.',
      '**Climbing** doesn\'t cost you extra movement.',
      'A **running jump** (long or high) requires only **5 ft** of movement instead of 10 ft.',
    ].join('\n\n'),
  },
  {
    slug: 'charger',
    name: 'Charger',
    snippet: 'Dash + melee/shove gets +5 damage or +10 ft shove.',
    description: 'When you use your action to **Dash**, you can use a **bonus action** to make one melee weapon attack or to shove a creature. If you **move at least 10 feet** in a straight line immediately before this attack, you either gain **+5 to the damage roll** (attack) or push the target **up to 10 ft** (shove).',
  },
  {
    slug: 'crossbow-expert',
    name: 'Crossbow Expert',
    snippet: 'Ignore loading. No ranged disadvantage in melee. Bonus action hand-crossbow shot.',
    description: [
      'You ignore the **loading** property of crossbows you are proficient with.',
      'Being **within 5 ft of a hostile creature** doesn\'t impose disadvantage on your ranged attack rolls.',
      'When you use the Attack action and attack with a one-handed weapon, you can use a **bonus action to attack with a hand crossbow** you are holding.',
    ].join('\n\n'),
  },
  {
    slug: 'dual-wielder',
    name: 'Dual Wielder',
    snippet: '+1 AC while dual-wielding. Use non-light weapons. Draw/stow two at once.',
    description: [
      '**+1 AC** while wielding a separate melee weapon in each hand.',
      'You can use **two-weapon fighting even when the one-handed melee weapons you are wielding aren\'t light**.',
      'You can **draw or stow two one-handed weapons** when you would normally draw or stow only one.',
    ].join('\n\n'),
  },
  {
    slug: 'dungeon-delver',
    name: 'Dungeon Delver',
    snippet: 'Advantage to find secret doors. Advantage vs traps. Full pace while alert.',
    description: [
      '**Advantage on Perception and Investigation** checks made to detect the presence of secret doors.',
      '**Advantage on saving throws against traps** and **resistance to trap damage**.',
      'You can travel at a **normal pace while searching for traps**, instead of being forced to slow down.',
    ].join('\n\n'),
  },
  {
    slug: 'elemental-adept',
    name: 'Elemental Adept',
    prerequisite: 'Ability to cast at least one spell',
    snippet: 'Choose a damage type. Ignore resistance. Reroll 1s.',
    description: [
      'Choose an element — **acid, cold, fire, lightning, or thunder**.',
      'Spells you cast **ignore resistance** to damage of that type.',
      'When you roll damage for a spell of that type, you **treat any 1 on a damage die as a 2**.',
      'You can take this feat multiple times — choose a different element each time.',
    ].join('\n\n'),
  },
  {
    slug: 'grappler',
    name: 'Grappler',
    prerequisite: 'Strength 13+',
    snippet: 'Advantage on attacks vs grappled targets. Pin a grappled creature (both restrained).',
    description: [
      '**Advantage on attack rolls** against a creature you are grappling.',
      'You can use your action to try to **pin a creature you grapple**. On a success the target is **restrained** until the grapple ends (you are also restrained).',
    ].join('\n\n'),
  },
  {
    slug: 'heavily-armored',
    name: 'Heavily Armored',
    prerequisite: 'Proficiency with medium armor',
    snippet: '+1 STR. Gain heavy armor proficiency.',
    description: '**+1 Strength** (max 20). Gain **proficiency with heavy armor**.',
  },
  {
    slug: 'heavy-armor-master',
    name: 'Heavy Armor Master',
    prerequisite: 'Proficiency with heavy armor',
    snippet: '+1 STR. Reduce bludgeoning/piercing/slashing damage by 3 while in heavy armor.',
    description: [
      '**+1 Strength** (max 20).',
      'While you are wearing **heavy armor**, **bludgeoning, piercing, and slashing damage** that you take from nonmagical weapons is **reduced by 3**.',
    ].join('\n\n'),
  },
  {
    slug: 'keen-mind',
    name: 'Keen Mind',
    snippet: '+1 INT. Perfect memory: direction, time, everything you\'ve seen for 1 month.',
    description: [
      '**+1 Intelligence** (max 20).',
      'You always know which way is **north**.',
      'You always know the **number of hours left before the next sunrise or sunset**.',
      'You can accurately recall **anything you have seen or heard within the past month**.',
    ].join('\n\n'),
  },
  {
    slug: 'linguist',
    name: 'Linguist',
    snippet: '+1 INT. Learn 3 languages. Create ciphers that take INT check vs DC 10+INT to crack.',
    description: [
      '**+1 Intelligence** (max 20).',
      'You learn **three languages** of your choice.',
      'You can **create ciphers**. Others can\'t decipher a coded message you send unless you teach them, they succeed on an Intelligence check vs DC **your Intelligence score + your proficiency bonus**, or they use magic.',
    ].join('\n\n'),
  },
  {
    slug: 'martial-adept',
    name: 'Martial Adept',
    snippet: 'Learn 2 maneuvers (battle master) + 1 d6 superiority die.',
    description: [
      'You learn **two maneuvers** of your choice from the Battle Master fighter\'s options. (If a maneuver requires a save, the DC is 8 + proficiency + STR or DEX.)',
      'You gain **one superiority die** (a **d6**), regained on a short or long rest.',
      'If you already have superiority dice, they combine and size to the bigger.',
    ].join('\n\n'),
  },
  {
    slug: 'medium-armor-master',
    name: 'Medium Armor Master',
    prerequisite: 'Proficiency with medium armor',
    snippet: 'No stealth disadvantage in medium armor. DEX bonus caps at +3 instead of +2.',
    description: [
      'Wearing medium armor **doesn\'t impose disadvantage on Stealth** checks.',
      'Your **Dexterity modifier to AC** from medium armor can be **+3** instead of +2 (if your DEX is 16+).',
    ].join('\n\n'),
  },
  {
    slug: 'mounted-combatant',
    name: 'Mounted Combatant',
    snippet: 'Advantage vs unmounted smaller foes. Redirect attack on mount to self. Mount takes half.',
    description: [
      '**Advantage on melee attacks** against unmounted creatures smaller than your mount.',
      'You can **force an attack targeted at your mount to target you instead**.',
      'If your mount is subjected to an effect that requires a Dex save for half damage, it takes **no damage on a success** and **half on a fail**.',
    ].join('\n\n'),
  },
  {
    slug: 'observant',
    name: 'Observant',
    snippet: '+1 INT/WIS. Read lips. Passive Perception and Investigation +5.',
    description: [
      '**+1 to Intelligence or Wisdom** (max 20).',
      'If you can see a creature\'s mouth, you can **read lips** in a language you know.',
      '**+5 to passive Perception and passive Investigation**.',
    ].join('\n\n'),
  },
  {
    slug: 'savage-attacker',
    name: 'Savage Attacker',
    snippet: 'Once/turn, reroll melee damage and take either result.',
    description: 'Once per turn when you roll damage for a melee weapon attack, you can **reroll the weapon\'s damage dice and use either total**.',
  },
  {
    slug: 'skilled',
    name: 'Skilled',
    snippet: 'Proficiency in 3 skills or tools (any combination).',
    description: 'Gain **proficiency in any combination of three skills or tools** of your choice.',
  },
  {
    slug: 'spell-sniper',
    name: 'Spell Sniper',
    prerequisite: 'Ability to cast at least one spell',
    snippet: 'Double spell attack range. Ignore cover. Learn an attack-roll cantrip.',
    description: [
      'When you cast a spell that requires an **attack roll**, the spell\'s **range is doubled**.',
      'Your ranged spell attacks **ignore half cover and three-quarters cover**.',
      'You learn **one cantrip that requires an attack roll** from a class of your choice. Your spellcasting ability for it is tied to that class.',
    ].join('\n\n'),
  },
  {
    slug: 'tavern-brawler',
    name: 'Tavern Brawler',
    snippet: '+1 STR/CON. Proficient with improvised weapons + unarmed strikes scale to d4. Grapple on unarmed hit.',
    description: [
      '**+1 to Strength or Constitution** (max 20).',
      'Proficiency with **improvised weapons**.',
      'Your **unarmed strike** uses a **d4** for damage.',
      'When you hit a creature with an unarmed strike or improvised weapon on your turn, you can use a **bonus action to attempt to grapple** the target.',
    ].join('\n\n'),
  },
  {
    slug: 'weapon-master',
    name: 'Weapon Master',
    snippet: '+1 STR/DEX. Proficiency with 4 weapons of your choice.',
    description: [
      '**+1 to Strength or Dexterity** (max 20).',
      'You gain **proficiency with four weapons** of your choice. Each weapon must be a simple or martial weapon.',
    ].join('\n\n'),
  },

  // --- Tasha's Cauldron of Everything ---
  {
    slug: 'artificer-initiate',
    name: 'Artificer Initiate',
    snippet: 'Learn an artificer cantrip + a 1st-level artificer spell (once/long rest). Tool proficiency.',
    description: [
      'You learn **one cantrip** of your choice from the **artificer** spell list.',
      'You also learn **one 1st-level artificer spell** — cast once per long rest at lowest level.',
      'Proficiency with **one type of artisan\'s tools**, and you can use those tools as a spellcasting focus.',
      'Spellcasting ability is Intelligence.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'chef',
    name: 'Chef',
    snippet: '+1 CON/WIS. Cook morning food: +CON bonus HP on short rest. Cook treats that heal 1d8.',
    description: [
      '**+1 to Constitution or Wisdom** (max 20).',
      'Proficiency with **cook\'s utensils** if you don\'t already have it.',
      'On a **short rest**, you can cook special food if you have utensils + ingredients. Up to **4+proficiency** creatures regain **extra 1d8 HP** on the short rest.',
      'On a **long rest**, you can cook **treats equal to your proficiency**. As a bonus action, a creature can eat a treat to regain **1d8 hit points**. Unused treats spoil after 8 hours.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'crusher',
    name: 'Crusher',
    snippet: '+1 STR/CON. Push 5 ft on bludgeoning hit once/turn. Crit grants advantage vs target.',
    description: [
      '**+1 to Strength or Constitution** (max 20).',
      'Once per turn, when you hit with an attack that deals **bludgeoning** damage, you can **move** the target **5 feet** to an unoccupied space (target must be your size or smaller).',
      'When you **score a critical hit** that deals bludgeoning damage, attacks against the target have **advantage** until the start of your next turn.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'eldritch-adept',
    name: 'Eldritch Adept',
    prerequisite: 'Spellcasting or Pact Magic feature',
    snippet: 'Learn one eldritch invocation (prerequisites still apply).',
    description: 'You learn **one eldritch invocation** of your choice from the warlock\'s list. You must meet the invocation\'s prerequisites. You can swap the invocation each time you level up.',
    source: 'tce',
  },
  {
    slug: 'fey-touched',
    name: 'Fey Touched',
    snippet: '+1 INT/WIS/CHA. Learn Misty Step + one 1st-level divination/enchantment. Once/day free + slots.',
    description: [
      '**+1 to Intelligence, Wisdom, or Charisma** (max 20).',
      'You learn **Misty Step** and **one 1st-level spell of your choice from the divination or enchantment school**.',
      'You can cast each once per long rest without a slot, and can also cast them using spell slots you have.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'fighting-initiate',
    name: 'Fighting Initiate',
    prerequisite: 'Proficiency with a martial weapon',
    snippet: 'Learn one Fighting Style (Archery, Defense, Dueling, etc.).',
    description: 'You learn **one Fighting Style** of your choice from the fighter\'s list (Archery, Defense, Dueling, Great Weapon Fighting, Protection, Two-Weapon Fighting, etc.). If you already have a fighting style feature, you gain this as an extra.',
    source: 'tce',
  },
  {
    slug: 'gunner',
    name: 'Gunner',
    snippet: '+1 DEX. Firearm proficiency. Ignore loading. No ranged disadvantage in melee.',
    description: [
      '**+1 Dexterity** (max 20).',
      'Proficiency with **firearms**.',
      'You ignore the **loading property** of firearms.',
      'Being **within 5 ft of a hostile creature** doesn\'t impose disadvantage on your ranged attack rolls.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'metamagic-adept',
    name: 'Metamagic Adept',
    prerequisite: 'Spellcasting or Pact Magic feature',
    snippet: 'Learn 2 metamagic options. Gain 2 sorcery points (pool with sorcerer).',
    description: [
      'You learn **two Metamagic options** from the sorcerer\'s list. Swap one per level-up.',
      'You gain **2 sorcery points**, which combine with any you already have. Regain on a long rest.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'piercer',
    name: 'Piercer',
    snippet: '+1 STR/DEX. Reroll one piercing damage die once/turn. Crits deal +1 damage die.',
    description: [
      '**+1 to Strength or Dexterity** (max 20).',
      'Once per turn when you roll damage for a piercing attack, you can **reroll one of the damage dice** and take the new result.',
      'When you score a **critical hit** with a piercing attack, you can roll **one additional damage die** when determining extra piercing damage.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'poisoner',
    name: 'Poisoner',
    snippet: 'Attacks ignore poison resistance. Coat weapon: +2d8 poison + possibly poisoned condition.',
    description: [
      'Your attacks **ignore resistance to poison damage**.',
      'You can apply **poison** to a weapon or up to 3 pieces of ammunition as a bonus action (lasts 1 minute). A hit creature takes **+2d8 poison damage** and must succeed on a DC 14 CON save or be **poisoned** until the end of your next turn.',
      'You gain proficiency with the **poisoner\'s kit**, and can craft poisons cheaper and faster.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'shadow-touched',
    name: 'Shadow Touched',
    snippet: '+1 INT/WIS/CHA. Learn Invisibility + one 1st-level illusion/necromancy. Once/day free + slots.',
    description: [
      '**+1 to Intelligence, Wisdom, or Charisma** (max 20).',
      'You learn **Invisibility** and **one 1st-level spell of your choice from the illusion or necromancy school**.',
      'You can cast each once per long rest without a slot, and can also cast them using spell slots.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'skill-expert',
    name: 'Skill Expert',
    snippet: '+1 any ability. Skill proficiency. Expertise in one skill.',
    description: [
      '**+1 to any ability** of your choice (max 20).',
      'Proficiency in **one skill** of your choice.',
      '**Expertise** in one skill you are proficient in (not the one you just chose via this feat if you picked one there — any prior proficiency works).',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'slasher',
    name: 'Slasher',
    snippet: '+1 STR/DEX. Slashing hits reduce speed by 10 ft. Crit imposes disadvantage on target.',
    description: [
      '**+1 to Strength or Dexterity** (max 20).',
      'Once per turn when you hit with a slashing attack, you can **reduce the target\'s speed by 10 ft** until the start of your next turn.',
      'When you score a **critical hit** with a slashing attack, the target has **disadvantage on attack rolls** until the start of your next turn.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'telekinetic',
    name: 'Telekinetic',
    snippet: '+1 INT/WIS/CHA. Learn Mage Hand (invisible, 30 ft). Shove creatures 5 ft as bonus action.',
    description: [
      '**+1 to Intelligence, Wisdom, or Charisma** (max 20).',
      'You learn **Mage Hand**. You can cast it without verbal or somatic components, the hand is **invisible**, and you can perform the Use an Object action with it.',
      'As a **bonus action**, telekinetically **shove** one creature within 30 ft. Target makes a STR save (DC 8 + proficiency + the ability you chose) or is pushed **5 ft**.',
    ].join('\n\n'),
    source: 'tce',
  },
  {
    slug: 'telepathic',
    name: 'Telepathic',
    snippet: '+1 INT/WIS/CHA. Send short messages 60 ft. Cast Detect Thoughts once/long rest.',
    description: [
      '**+1 to Intelligence, Wisdom, or Charisma** (max 20).',
      'Speak telepathically to a creature within **60 ft** you can see. They don\'t need to share a language.',
      'Cast **Detect Thoughts** once per long rest without a slot (save DC 8 + proficiency + the ability you chose), and with slots you have.',
    ].join('\n\n'),
    source: 'tce',
  },

  // --- Popular racial feats (Xanathar's / MPMM) ---
  {
    slug: 'bountiful-luck',
    name: 'Bountiful Luck',
    prerequisite: 'Halfling',
    snippet: 'Share your halfling luck — let an ally within 30 ft reroll a 1.',
    description: 'When an ally within **30 ft** rolls a **1** on the d20 for an attack roll, ability check, or saving throw, you can use your **reaction** to let them reroll and take the new roll.',
    source: 'xge',
  },
  {
    slug: 'dragon-fear',
    name: 'Dragon Fear',
    prerequisite: 'Dragonborn',
    snippet: '+1 STR/CON/CHA. Replace breath weapon with a 30-ft fear-inducing roar (once/rest).',
    description: [
      '**+1 to Strength, Constitution, or Charisma** (max 20).',
      'Instead of exhaling destructive energy, you can unleash a **roar**. Each creature of your choice within **30 ft** must succeed on a WIS save (DC 8 + prof + CHA) or be **frightened** for 1 minute.',
      'Usable a number of times equal to your proficiency bonus, recharging on a long rest.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'dragon-hide',
    name: 'Dragon Hide',
    prerequisite: 'Dragonborn',
    snippet: '+1 STR/CON/CHA. Claws (1d4 + STR slashing). Unarmored AC 13+DEX.',
    description: [
      '**+1 to Strength, Constitution, or Charisma** (max 20).',
      'You can manifest **claws** that deal **1d4 + STR** slashing damage on an unarmed strike.',
      'Your **unarmored AC** is **13 + DEX** (can use a shield and still gain this benefit).',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'drow-high-magic',
    name: 'Drow High Magic',
    prerequisite: 'Elf (drow)',
    snippet: 'Learn Detect Magic at will + Levitate + Dispel Magic, once/long rest each.',
    description: [
      'You learn **Detect Magic** (at will, no slot).',
      'You learn **Levitate**, castable once per long rest without a slot.',
      'You learn **Dispel Magic**, castable once per long rest without a slot.',
      'CHA is your spellcasting ability.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'dwarven-fortitude',
    name: 'Dwarven Fortitude',
    prerequisite: 'Dwarf',
    snippet: '+1 CON. Roll HD on Dodge.',
    description: [
      '**+1 Constitution** (max 20).',
      'When you take the **Dodge action**, you can spend **one Hit Die** to heal yourself — roll the die, add your CON mod, regain that many hit points.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'elven-accuracy',
    name: 'Elven Accuracy',
    prerequisite: 'Elf or half-elf',
    snippet: '+1 DEX/INT/WIS/CHA. Triple advantage on attacks with that ability.',
    description: [
      '**+1 to Dexterity, Intelligence, Wisdom, or Charisma** (max 20).',
      'When you have advantage on an attack roll using the chosen ability, you can **reroll one of the dice** once — effectively rolling **three d20s**.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'fade-away',
    name: 'Fade Away',
    prerequisite: 'Gnome',
    snippet: '+1 DEX/INT. Reaction to turn invisible after taking damage.',
    description: [
      '**+1 to Dexterity or Intelligence** (max 20).',
      'Immediately after you take damage, you can use a **reaction** to **turn invisible** until the end of your next turn or until you attack, deal damage, or force a save. Once per short rest.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'fey-teleportation',
    name: 'Fey Teleportation',
    prerequisite: 'High elf (eladrin)',
    snippet: '+1 INT/CHA. Learn Misty Step, cast once/short rest + slots. Learn Sylvan.',
    description: [
      '**+1 to Intelligence or Charisma** (max 20).',
      'Learn **Sylvan** (if not already).',
      'You learn **Misty Step** — cast once per short rest without a slot, or using slots you have.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'flames-of-phlegethos',
    name: 'Flames of Phlegethos',
    prerequisite: 'Tiefling',
    snippet: '+1 INT/CHA. Reroll fire damage 1s. Self-ignite: 1d4 fire to adjacent attackers.',
    description: [
      '**+1 to Intelligence or Charisma** (max 20).',
      'When you roll fire damage for a spell, **reroll any 1s** and must take the new result.',
      'When you cast a spell that deals fire damage, **flames wreath you** until end of your next turn — shed bright light 30 ft, and any creature within 5 ft that hits you with a melee attack takes **1d4 fire** damage.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'infernal-constitution',
    name: 'Infernal Constitution',
    prerequisite: 'Tiefling',
    snippet: '+1 CON. Resistance to cold and poison. Advantage on saves vs being poisoned.',
    description: [
      '**+1 Constitution** (max 20).',
      '**Resistance to cold damage and poison damage**.',
      '**Advantage on saving throws against being poisoned**.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'orcish-fury',
    name: 'Orcish Fury',
    prerequisite: 'Half-orc',
    snippet: '+1 STR/CON. Extra damage die once/short rest. Reaction attack after Relentless Endurance.',
    description: [
      '**+1 to Strength or Constitution** (max 20).',
      'When you hit with a weapon attack, you can roll one of the weapon\'s damage dice **one extra time** and add it. Once per short rest.',
      'Immediately after using **Relentless Endurance**, you can use your **reaction to make one weapon attack**.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'prodigy',
    name: 'Prodigy',
    prerequisite: 'Half-elf, half-orc, or human',
    snippet: '1 skill, 1 tool, 1 language. Expertise in one skill.',
    description: [
      'Gain proficiency in **one skill**, proficiency with **one tool**, and fluency in **one language** of your choice.',
      'Choose a skill you are proficient in — you gain **expertise** (double proficiency) with it.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'second-chance',
    name: 'Second Chance',
    prerequisite: 'Halfling',
    snippet: '+1 DEX/CON/CHA. Force attacker to reroll a hit on you (once/encounter).',
    description: [
      '**+1 to Dexterity, Constitution, or Charisma** (max 20).',
      'When a creature you can see hits you with an attack, you can use your **reaction** to force them to **reroll** the attack. Once per short rest (or when you roll initiative).',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'squat-nimbleness',
    name: 'Squat Nimbleness',
    prerequisite: 'Dwarf or Small-size race',
    snippet: '+1 STR/DEX. +5 ft speed. Acrobatics/Athletics prof. Advantage to escape grapples.',
    description: [
      '**+1 to Strength or Dexterity** (max 20).',
      'Speed **increases by 5 ft**.',
      'Proficiency in **Acrobatics or Athletics** (your choice).',
      '**Advantage on any STR or DEX check to escape from being grappled**.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'wood-elf-magic',
    name: 'Wood Elf Magic',
    prerequisite: 'Elf (wood)',
    snippet: 'Learn one druid cantrip + Longstrider + Pass Without Trace (once/long rest each).',
    description: [
      'You learn **one druid cantrip** of your choice.',
      'Learn **Longstrider** and **Pass Without Trace** — cast each once per long rest without a slot, or using slots.',
      'Spellcasting ability is Wisdom.',
    ].join('\n\n'),
    source: 'xge',
  },
  {
    slug: 'revenant-blade',
    name: 'Revenant Blade',
    prerequisite: 'Elf',
    snippet: '+1 DEX/STR. Wield double-bladed scimitar as finesse. +1 AC.',
    description: [
      '**+1 to Dexterity or Strength** (max 20).',
      'The **double-bladed scimitar** has the **finesse** property when you wield it.',
      'While holding it with two hands, you gain **+1 AC**.',
    ].join('\n\n'),
    source: 'eberron',
  },
];
