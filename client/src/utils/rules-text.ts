/**
 * D&D 5e rules dictionaries for use with the InfoTooltip component.
 * Keys are lowercased and canonicalized (no spaces, no punctuation)
 * so lookups are forgiving. Helper functions below normalize the
 * input string before looking it up.
 */

export interface RuleEntry {
  title: string;
  body: string;
  /** Optional footer line (e.g. "Action cost: 1 Action"). */
  footer?: string;
  /** Accent color override for the tooltip border. */
  accent?: string;
}

const C = {
  red: '#c53131',
  gold: '#d4a843',
  blue: '#3498db',
  green: '#27ae60',
  purple: '#9b59b6',
  teal: '#1abc9c',
  orange: '#e67e22',
  grey: '#7f8c8d',
  dark: '#4a4a4a',
};

/** ── Combat actions (Dash, Dodge, etc.) ───────────────────────── */
export const COMBAT_ACTIONS: Record<string, RuleEntry> = {
  dash: {
    title: 'Dash',
    body:
      'Gain extra movement for the current turn equal to your speed, ' +
      'after applying modifiers. If your speed is 30 ft, taking the ' +
      'Dash action gives you 30 extra feet of movement (60 total).\n\n' +
      'Any increase or decrease to your speed changes this additional ' +
      'movement by the same amount.',
    footer: 'Cost: 1 Action',
    accent: C.blue,
  },
  dodge: {
    title: 'Dodge',
    body:
      'Until the start of your next turn:\n' +
      '• Any attack roll made against you has disadvantage if you can see the attacker.\n' +
      '• You make Dexterity saving throws with advantage.\n\n' +
      'You lose this benefit if you are Incapacitated or if your speed drops to 0.',
    footer: 'Cost: 1 Action  •  Lasts: until your next turn',
    accent: C.purple,
  },
  disengage: {
    title: 'Disengage',
    body:
      'Your movement this turn doesn\u2019t provoke Opportunity Attacks. ' +
      'You can safely walk away from any creature that threatens you.',
    footer: 'Cost: 1 Action  •  Lasts: until end of turn',
    accent: C.teal,
  },
  hide: {
    title: 'Hide',
    body:
      'Make a Dexterity (Stealth) check in an attempt to hide, following ' +
      'the rules for hiding. If you succeed, you gain certain benefits — ' +
      'attacks against you have disadvantage, and attacks you make have ' +
      'advantage — until you\u2019re discovered or attack.\n\n' +
      'You can\u2019t hide from a creature that can see you clearly.',
    footer: 'Cost: 1 Action',
    accent: C.dark,
  },
  search: {
    title: 'Search',
    body:
      'Devote your attention to finding something. Depending on the ' +
      'nature of the search, the DM might have you make a Wisdom ' +
      '(Perception) check or an Intelligence (Investigation) check.',
    footer: 'Cost: 1 Action',
    accent: C.gold,
  },
  help: {
    title: 'Help',
    body:
      'Lend your aid to another creature in the completion of a task. ' +
      'The creature you aid gains advantage on the next ability check it ' +
      'makes to perform the task you are helping with, provided that it ' +
      'makes the check before the start of your next turn.\n\n' +
      'Alternatively, you can aid a friendly creature in attacking a ' +
      'creature within 5 ft of you — the next attack roll your ally makes ' +
      'against that creature has advantage.',
    footer: 'Cost: 1 Action  •  Benefit lasts: until your next turn',
    accent: C.green,
  },
  ready: {
    title: 'Ready',
    body:
      'Prepare to act later in the round in response to a trigger you ' +
      'specify. First, decide what perceivable circumstance will trigger ' +
      'your reaction. Then, choose the action you will take in response, ' +
      'or choose to move up to your speed in response.\n\n' +
      'When the trigger occurs, you can either take your reaction right ' +
      'after the trigger finishes or ignore the trigger.',
    footer: 'Cost: 1 Action + reserves your Reaction',
    accent: C.orange,
  },
  attack: {
    title: 'Attack',
    body:
      'Make one melee or ranged attack. See the descriptions of the ' +
      'specific weapons for details. Certain features, such as the ' +
      'Extra Attack feature of the Fighter, allow you to make more than ' +
      'one attack with this action.',
    footer: 'Cost: 1 Action',
    accent: C.red,
  },
  castspell: {
    title: 'Cast a Spell',
    body:
      'Spellcasters such as Wizards and Clerics, as well as many monsters, ' +
      'have access to spells and can use them to great effect in combat. ' +
      'Each spell has a casting time which specifies whether the caster ' +
      'must use an Action, a Bonus Action, a Reaction, or more time to ' +
      'cast the spell.',
    footer: 'Cost: varies by spell',
    accent: C.purple,
  },
};

/** ── Conditions ───────────────────────────────────────────────── */
export const CONDITIONS: Record<string, RuleEntry> = {
  blinded: {
    title: 'Blinded',
    body:
      '• A Blinded creature can\u2019t see and automatically fails any ' +
      'ability check that requires sight.\n' +
      '• Attack rolls against the creature have advantage, and the ' +
      'creature\u2019s attack rolls have disadvantage.',
    accent: C.dark,
  },
  charmed: {
    title: 'Charmed',
    body:
      '• A Charmed creature can\u2019t attack the charmer or target the ' +
      'charmer with harmful abilities or magical effects.\n' +
      '• The charmer has advantage on any ability check to socially ' +
      'interact with the creature.',
    accent: '#ff69b4',
  },
  deafened: {
    title: 'Deafened',
    body:
      '• A Deafened creature can\u2019t hear and automatically fails any ' +
      'ability check that requires hearing.',
    accent: C.grey,
  },
  frightened: {
    title: 'Frightened',
    body:
      '• A Frightened creature has disadvantage on ability checks and ' +
      'attack rolls while the source of its fear is within line of sight.\n' +
      '• The creature can\u2019t willingly move closer to the source of its fear.',
    accent: C.purple,
  },
  grappled: {
    title: 'Grappled',
    body:
      '• A Grappled creature\u2019s speed becomes 0, and it can\u2019t ' +
      'benefit from any bonus to its speed.\n' +
      '• The condition ends if the Grappler is Incapacitated, or if the ' +
      'Grappled creature is moved out of the reach of the Grappler.',
    accent: C.orange,
  },
  incapacitated: {
    title: 'Incapacitated',
    body: '• An Incapacitated creature can\u2019t take actions or reactions.',
    accent: C.grey,
  },
  invisible: {
    title: 'Invisible',
    body:
      '• An Invisible creature is impossible to see without the aid of ' +
      'magic or a special sense. For hiding purposes, the creature is ' +
      'heavily obscured.\n' +
      '• Attack rolls against the creature have disadvantage, and the ' +
      'creature\u2019s attack rolls have advantage.',
    accent: C.blue,
  },
  paralyzed: {
    title: 'Paralyzed',
    body:
      '• A Paralyzed creature is Incapacitated and can\u2019t move or speak.\n' +
      '• The creature automatically fails Strength and Dexterity saving throws.\n' +
      '• Attack rolls against the creature have advantage.\n' +
      '• Any attack that hits the creature is a critical hit if the attacker ' +
      'is within 5 ft of the creature.',
    accent: '#f1c40f',
  },
  petrified: {
    title: 'Petrified',
    body:
      '• A Petrified creature is transformed, along with any nonmagical ' +
      'object it is wearing or carrying, into a solid inanimate substance ' +
      '(usually stone). Its weight increases by a factor of ten, and it ' +
      'ceases aging.\n' +
      '• The creature is Incapacitated, can\u2019t move or speak, and is ' +
      'unaware of its surroundings.\n' +
      '• Attack rolls against the creature have advantage.\n' +
      '• The creature automatically fails Strength and Dexterity saving throws.\n' +
      '• The creature has resistance to all damage.\n' +
      '• The creature is immune to poison and disease.',
    accent: '#bdc3c7',
  },
  poisoned: {
    title: 'Poisoned',
    body:
      '• A Poisoned creature has disadvantage on attack rolls and ability checks.',
    accent: C.green,
  },
  prone: {
    title: 'Prone',
    body:
      '• A Prone creature\u2019s only movement option is to crawl, unless ' +
      'it stands up and thereby ends the condition.\n' +
      '• The creature has disadvantage on attack rolls.\n' +
      '• An attack roll against the creature has advantage if the attacker ' +
      'is within 5 ft. Otherwise, the attack roll has disadvantage.',
    accent: '#e74c3c',
  },
  restrained: {
    title: 'Restrained',
    body:
      '• A Restrained creature\u2019s speed becomes 0, and it can\u2019t ' +
      'benefit from any bonus to its speed.\n' +
      '• Attack rolls against the creature have advantage, and the ' +
      'creature\u2019s attack rolls have disadvantage.\n' +
      '• The creature has disadvantage on Dexterity saving throws.',
    accent: '#c0392b',
  },
  stunned: {
    title: 'Stunned',
    body:
      '• A Stunned creature is Incapacitated, can\u2019t move, and can ' +
      'speak only falteringly.\n' +
      '• The creature automatically fails Strength and Dexterity saving throws.\n' +
      '• Attack rolls against the creature have advantage.',
    accent: '#f39c12',
  },
  unconscious: {
    title: 'Unconscious',
    body:
      '• An Unconscious creature is Incapacitated, can\u2019t move or speak, ' +
      'and is unaware of its surroundings.\n' +
      '• The creature drops whatever it\u2019s holding and falls Prone.\n' +
      '• The creature automatically fails Strength and Dexterity saving throws.\n' +
      '• Attack rolls against the creature have advantage.\n' +
      '• Any attack that hits the creature is a critical hit if the attacker ' +
      'is within 5 ft of the creature.',
    accent: '#2c3e50',
  },
  exhaustion: {
    title: 'Exhaustion',
    body:
      'Exhaustion has six levels. Each level imposes a cumulative penalty:\n' +
      '1: Disadvantage on ability checks.\n' +
      '2: Speed halved.\n' +
      '3: Disadvantage on attack rolls and saving throws.\n' +
      '4: Hit point maximum halved.\n' +
      '5: Speed reduced to 0.\n' +
      '6: Death.',
    accent: '#8e44ad',
  },
  // ── Buff "conditions" from spells ─────────────────────────
  blessed: {
    title: 'Blessed',
    body:
      'Add 1d4 to each attack roll and saving throw you make. Bless is a ' +
      'concentration spell that targets up to three creatures and lasts up to 1 minute.',
    footer: 'Source: Bless (1st-level spell, concentration)',
    accent: C.gold,
  },
  baned: {
    title: 'Baned',
    body:
      'Subtract 1d4 from each attack roll and saving throw you make until ' +
      'the end of the spell. Bane is a concentration spell and lasts up to 1 minute.',
    footer: 'Source: Bane (1st-level spell, concentration)',
    accent: '#8b0000',
  },
  hasted: {
    title: 'Hasted',
    body:
      '• Speed is doubled.\n' +
      '• +2 bonus to AC.\n' +
      '• Advantage on Dexterity saving throws.\n' +
      '• Gains an additional Action on each of its turns. That action can ' +
      'only be used for Attack (one weapon attack only), Dash, Disengage, ' +
      'Hide, or Use an Object.\n\n' +
      'When the spell ends, the target can\u2019t move or take actions until ' +
      'after its next turn, as a wave of lethargy sweeps over it.',
    footer: 'Source: Haste (3rd-level spell, concentration)',
    accent: C.teal,
  },
  slowed: {
    title: 'Slowed',
    body:
      '• Speed is halved.\n' +
      '• -2 penalty to AC and Dexterity saving throws.\n' +
      '• Can\u2019t use reactions.\n' +
      '• On its turn, it can use either an action or a bonus action, not both.',
    footer: 'Source: Slow (3rd-level spell, concentration)',
    accent: C.grey,
  },
  shielded: {
    title: 'Shielded',
    body:
      '• +2 AC for the duration of the spell.',
    footer: 'Source: Shield of Faith (1st-level spell, concentration)',
    accent: C.blue,
  },
  'shield-spell': {
    title: 'Shield (spell)',
    body:
      '+5 AC until the start of the caster\u2019s next turn, including ' +
      'against the triggering attack. Also grants immunity to Magic Missile.',
    footer: 'Source: Shield (1st-level abjuration, reaction)',
    accent: C.blue,
  },
  'mage-armored': {
    title: 'Mage Armored',
    body:
      '• Base AC becomes 13 + Dexterity modifier. Ends if the target dons armor.',
    footer: 'Source: Mage Armor (1st-level spell, 8 hours)',
    accent: C.blue,
  },
  dodging: {
    title: 'Dodging',
    body:
      'Until the start of your next turn:\n' +
      '• Attack rolls against you have disadvantage if you can see the attacker.\n' +
      '• You make Dexterity saving throws with advantage.',
    footer: 'Source: Dodge action  •  Lasts: until your next turn',
    accent: C.purple,
  },
  disengaged: {
    title: 'Disengaged',
    body:
      'Your movement this turn doesn\u2019t provoke Opportunity Attacks.',
    footer: 'Source: Disengage action  •  Lasts: until end of turn',
    accent: C.teal,
  },
  stoneskin: {
    title: 'Stoneskin',
    body:
      '• Resistance to nonmagical bludgeoning, piercing, and slashing damage.',
    footer: 'Source: Stoneskin (4th-level spell, concentration)',
    accent: C.grey,
  },
  barkskin: {
    title: 'Barkskin',
    body:
      '• AC becomes 16 (if it was lower) regardless of what armor is worn.',
    footer: 'Source: Barkskin (2nd-level spell, concentration)',
    accent: '#6b8e23',
  },
};

/** ── Weapon properties ──────────────────────────────────────── */
export const WEAPON_PROPERTIES: Record<string, RuleEntry> = {
  ammunition: {
    title: 'Ammunition',
    body:
      'You can use a weapon that has the Ammunition property to make a ' +
      'ranged attack only if you have ammunition to fire from the weapon. ' +
      'Each time you attack with the weapon, you expend one piece of ' +
      'ammunition.\n\nDrawing ammunition is part of the attack. At the ' +
      'end of combat, you can recover half your expended ammunition by ' +
      'taking a minute to search the battlefield.',
  },
  finesse: {
    title: 'Finesse',
    body:
      'When making an attack with a Finesse weapon, you use your choice of ' +
      'your Strength or Dexterity modifier for the attack and damage rolls. ' +
      'You must use the same modifier for both rolls.',
    footer: 'Examples: Dagger, Rapier, Shortsword, Scimitar, Whip',
    accent: C.gold,
  },
  heavy: {
    title: 'Heavy',
    body:
      'Small creatures have disadvantage on attack rolls with Heavy weapons. ' +
      'A Heavy weapon\u2019s size and bulk make it too large for a Small ' +
      'creature to use effectively.',
    accent: C.grey,
  },
  light: {
    title: 'Light',
    body:
      'A Light weapon is small and easy to handle, making it ideal for use ' +
      'when fighting with two weapons (Two-Weapon Fighting).\n\n' +
      'You can hold a Light weapon in one hand and use your bonus action to ' +
      'make an additional attack with another Light weapon in your off hand ' +
      '(you don\u2019t add your ability modifier to the off-hand damage unless ' +
      'the modifier is negative).',
    footer: 'Examples: Dagger, Handaxe, Shortsword, Scimitar',
    accent: C.gold,
  },
  loading: {
    title: 'Loading',
    body:
      'Because of the time required to load this weapon, you can fire only ' +
      'one piece of ammunition from it when you use an action, bonus action, ' +
      'or reaction to fire it, regardless of the number of attacks you can ' +
      'normally make.',
    accent: C.grey,
  },
  range: {
    title: 'Range',
    body:
      'A weapon that can be used to make a ranged attack has a range in ' +
      'parentheses after the Ammunition or Thrown property. The range lists ' +
      'two numbers: the first is the weapon\u2019s normal range, and the ' +
      'second is its long range.\n\n' +
      'Attacking at long range imposes disadvantage, and you can\u2019t ' +
      'attack a target beyond the long range.',
    accent: C.blue,
  },
  reach: {
    title: 'Reach',
    body:
      'This weapon adds 5 feet to your reach when you attack with it, as ' +
      'well as when determining your reach for opportunity attacks with it.',
    footer: 'Examples: Glaive, Halberd, Pike, Whip',
    accent: C.blue,
  },
  thrown: {
    title: 'Thrown',
    body:
      'If a weapon has the Thrown property, you can throw the weapon to make ' +
      'a ranged attack. If the weapon is a melee weapon, you use the same ' +
      'ability modifier for that attack roll and damage roll as you would for ' +
      'a melee attack with it.\n\n' +
      'For example, if you throw a Handaxe, you use your Strength, but if ' +
      'you throw a Dagger, you can use either your Strength or your ' +
      'Dexterity, since the Dagger has the Finesse property.',
    footer: 'Examples: Dagger, Handaxe, Javelin, Spear, Trident',
    accent: C.orange,
  },
  'two-handed': {
    title: 'Two-Handed',
    body:
      'This weapon requires two hands when you attack with it.',
    accent: C.grey,
  },
  versatile: {
    title: 'Versatile',
    body:
      'This weapon can be used with one or two hands. A damage value in ' +
      'parentheses appears with the property — the damage when the weapon ' +
      'is used with two hands to make a melee attack.',
    footer: 'Examples: Longsword, Battleaxe, Warhammer, Quarterstaff',
    accent: C.gold,
  },
  silvered: {
    title: 'Silvered',
    body:
      'Some monsters that have immunity or resistance to nonmagical weapons ' +
      'are susceptible to silver weapons. A silvered weapon costs 100 gp ' +
      'more and treats nonmagical resistance as if the weapon were magical.',
    accent: '#c0c0c0',
  },
  adamantine: {
    title: 'Adamantine',
    body:
      'Any attack by an adamantine weapon against an object is treated as ' +
      'a critical hit. An adamantine weapon is also effective against some ' +
      'magical damage resistances.',
    accent: C.dark,
  },
  magical: {
    title: 'Magical',
    body:
      'Attacks and damage with this weapon bypass the nonmagical ' +
      'bludgeoning/piercing/slashing damage resistances that many monsters have.',
    accent: C.purple,
  },

  // ── 2024 PHB Weapon Mastery Properties ─────────────────────────
  // Introduced in the 2024 Player\u2019s Handbook. Characters with the
  // Weapon Mastery feature (Fighter, Barbarian, Paladin, Ranger, etc.)
  // can unlock a weapon's mastery property. Each one is a passive or
  // triggered effect that fires on a hit.
  cleave: {
    title: 'Cleave (Mastery)',
    body:
      'If you hit a creature with a melee attack roll using this weapon, ' +
      'you can make a melee attack roll with the weapon against a second ' +
      'creature within 5 feet of the first that is also within your reach. ' +
      'On a hit, the second creature takes the weapon\u2019s damage, but ' +
      'don\u2019t add your ability modifier to that damage unless that ' +
      'modifier is negative.\n\nYou can make this extra attack only once ' +
      'per turn.',
    footer: 'Examples: Greataxe, Halberd',
    accent: C.red,
  },
  flex: {
    title: 'Flex (Mastery)',
    body:
      'When you use this weapon one-handed to make an attack, its damage ' +
      'die changes to the Versatile die listed on the weapon\u2019s entry ' +
      '(the higher die).',
    footer: 'Examples: Quarterstaff, Battleaxe, Longsword',
    accent: C.gold,
  },
  graze: {
    title: 'Graze (Mastery)',
    body:
      'If your attack roll with this weapon misses a creature, you can ' +
      'deal damage to that creature equal to your ability modifier used to ' +
      'make the attack roll. This damage is the same type dealt by the ' +
      'weapon, and the damage can be increased only by increasing the ability ' +
      'modifier.',
    footer: 'Examples: Greatsword, Glaive',
    accent: C.orange,
  },
  nick: {
    title: 'Nick (Mastery)',
    body:
      'When you make the extra attack of the Light property, you can make ' +
      'it as part of the Attack action, instead of as a Bonus Action. You ' +
      'can make this extra attack only once per turn.\n\nIn practice: if ' +
      'you\u2019re two-weapon fighting with a Nick weapon in your off-hand, ' +
      'the off-hand attack becomes "free" — it no longer eats your Bonus ' +
      'Action, so you can still cast Healing Word or Second Wind on the ' +
      'same turn.',
    footer: 'Examples: Dagger, Light Hammer, Sickle, Scimitar',
    accent: C.gold,
  },
  push: {
    title: 'Push (Mastery)',
    body:
      'If you hit a creature with this weapon, you can push the creature ' +
      'up to 10 feet straight away from yourself, provided the creature is ' +
      'Large or smaller.',
    footer: 'Examples: Greatclub, Pike, Warhammer, Heavy Crossbow',
    accent: C.blue,
  },
  sap: {
    title: 'Sap (Mastery)',
    body:
      'If you hit a creature with this weapon, that creature has ' +
      'Disadvantage on its next attack roll before the start of your next ' +
      'turn.',
    footer: 'Examples: Mace, Spear, Morningstar, Longsword',
    accent: C.purple,
  },
  slow: {
    title: 'Slow (Mastery)',
    body:
      'If you hit a creature with this weapon and deal damage to it, you can ' +
      'reduce its Speed by 10 feet until the start of your next turn. If the ' +
      'creature is hit more than once by weapons that have this property, ' +
      'the Speed reduction doesn\u2019t exceed 10 feet.',
    footer: 'Examples: Club, Javelin, Sling, Longbow',
    accent: C.grey,
  },
  topple: {
    title: 'Topple (Mastery)',
    body:
      'If you hit a creature with this weapon, you can force the creature ' +
      'to make a Constitution saving throw (DC = 8 + your Proficiency Bonus ' +
      '+ the ability modifier used to make the attack roll). On a failed ' +
      'save, the creature has the Prone condition.',
    footer: 'Examples: Quarterstaff, Lance, Maul, Trident',
    accent: C.red,
  },
  vex: {
    title: 'Vex (Mastery)',
    body:
      'If you hit a creature with this weapon and deal damage to the ' +
      'creature, you have Advantage on your next attack roll against that ' +
      'creature before the end of your next turn.',
    footer: 'Examples: Shortsword, Rapier, Handaxe, Shortbow',
    accent: C.gold,
  },
};

/** Normalize a lookup key: lowercase, strip non-alphanum except hyphens. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9-]+/g, '');
}

export function lookupCombatAction(name: string): RuleEntry | null {
  return COMBAT_ACTIONS[normalize(name)] ?? null;
}

export function lookupCondition(name: string): RuleEntry | null {
  const key = normalize(name);
  return CONDITIONS[key] ?? null;
}

export function lookupWeaponProperty(name: string): RuleEntry | null {
  const key = normalize(name);
  // Try exact match first
  if (WEAPON_PROPERTIES[key]) return WEAPON_PROPERTIES[key];
  // Some properties come with values baked in (e.g. "range 80/320") —
  // strip trailing numbers/slashes and try the prefix.
  const prefix = key.replace(/[0-9/]+/g, '').replace(/[-]+$/, '');
  return WEAPON_PROPERTIES[prefix] ?? null;
}
