export interface RaceEntry {
  slug: string;
  name: string;
  size: 'Small' | 'Medium';
  speed: number;
  asi: string;
  subraces: string[];
  snippet: string;
  description: string;
}

/**
 * 5e PHB player species (races). Static reference — mechanical
 * enforcement of traits (darkvision, innate spells, etc.) hooks into
 * the rules engine as each race handler lands.
 */
export const RACES: RaceEntry[] = [
  {
    slug: 'human',
    name: 'Human',
    size: 'Medium',
    speed: 30,
    asi: '+1 to all six ability scores (standard) — or +1 to two + skill + feat (variant)',
    subraces: ['Standard', 'Variant (with feat at L1)'],
    snippet: 'Adaptable, ambitious, ubiquitous.',
    description: 'Most common race. Standard humans get +1 to every ability score. Variant humans (PHB optional rule, most groups use it) swap that for +1 to two abilities, one extra skill proficiency, and one feat at level 1.',
  },
  {
    slug: 'elf',
    name: 'Elf',
    size: 'Medium',
    speed: 30,
    asi: '+2 DEX; subrace adds more',
    subraces: ['High Elf (+1 INT)', 'Wood Elf (+1 WIS)', 'Drow / Dark Elf (+1 CHA)', 'Eladrin (SCAG — +1 INT or CHA)'],
    snippet: '60 ft darkvision. Keen Senses. Fey Ancestry.',
    description: '**Darkvision 60 ft.** **Keen Senses**: proficiency in Perception. **Fey Ancestry**: advantage on saves vs. charmed, magic can\'t put you to sleep. **Trance**: 4h meditation instead of 8h sleep. Subrace features: **High Elf** picks a wizard cantrip + 1 language + longsword/longbow/shortsword/shortbow proficiency. **Wood Elf** gets 35 ft speed + Mask of the Wild. **Drow** gets Superior Darkvision (120 ft) + faerie fire / darkness innate spells at levels 3/5.',
  },
  {
    slug: 'dwarf',
    name: 'Dwarf',
    size: 'Medium',
    speed: 25,
    asi: '+2 CON; subrace adds more',
    subraces: ['Hill Dwarf (+1 WIS)', 'Mountain Dwarf (+2 STR)', 'Duergar (SCAG — +1 STR, invisibility spells)'],
    snippet: '60 ft darkvision. Resilience (adv + resistance to poison).',
    description: '**Darkvision 60 ft.** **Dwarven Resilience**: advantage on saves vs. poison, resistance to poison damage. **Dwarven Combat Training**: battleaxe, handaxe, light hammer, warhammer proficiency. **Stonecunning**: double proficiency on History checks about stonework. Subraces: **Hill Dwarf** adds +1 HP per level (Dwarven Toughness). **Mountain Dwarf** gets light + medium armor proficiency.',
  },
  {
    slug: 'halfling',
    name: 'Halfling',
    size: 'Small',
    speed: 25,
    asi: '+2 DEX; subrace adds more',
    subraces: ['Lightfoot Halfling (+1 CHA)', 'Stout Halfling (+1 CON)'],
    snippet: 'Lucky (reroll nat 1). Brave (adv vs fear). Small.',
    description: '**Lucky**: when you roll a 1 on an attack, ability check, or save, reroll and must use the new roll. **Brave**: advantage on saves vs. frightened. **Halfling Nimbleness**: move through the space of any creature of a size larger than yours. **Lightfoot**: Naturally Stealthy — hide behind a creature one size larger. **Stout**: dwarf-like poison resistance (adv on saves vs. poison + damage resistance).',
  },
  {
    slug: 'dragonborn',
    name: 'Dragonborn',
    size: 'Medium',
    speed: 30,
    asi: '+2 STR, +1 CHA',
    subraces: ['Black (acid)', 'Blue (lightning)', 'Brass (fire)', 'Bronze (lightning)', 'Copper (acid)', 'Gold (fire)', 'Green (poison)', 'Red (fire)', 'Silver (cold)', 'White (cold)'],
    snippet: 'Breath weapon once per short rest + damage resistance.',
    description: 'Pick a **Draconic Ancestry** — determines your breath weapon damage type + shape (line or cone) + resistance. **Breath Weapon**: action, DEX or CON save (DC = 8 + CON mod + prof). 2d6 / 3d6 / 4d6 / 5d6 damage scaling at L1/6/11/16. Recharges on short or long rest. **Damage Resistance**: same type as your breath weapon.',
  },
  {
    slug: 'gnome',
    name: 'Gnome',
    size: 'Small',
    speed: 25,
    asi: '+2 INT; subrace adds more',
    subraces: ['Forest Gnome (+1 DEX)', 'Rock Gnome (+1 CON)', 'Deep Gnome / Svirfneblin (SCAG — +1 DEX)'],
    snippet: '60 ft darkvision. Gnome Cunning (adv on INT/WIS/CHA magic saves).',
    description: '**Darkvision 60 ft.** **Gnome Cunning**: advantage on INT, WIS, and CHA saving throws against magic. Subraces: **Forest Gnome** gets Speak with Small Beasts + Minor Illusion cantrip. **Rock Gnome** gets Artificer\'s Lore (double proficiency on magical / alchemical / technological lore) + Tinker (crafting minor clockwork toys).',
  },
  {
    slug: 'half-elf',
    name: 'Half-Elf',
    size: 'Medium',
    speed: 30,
    asi: '+2 CHA, +1 to two other abilities',
    subraces: ['Standard'],
    snippet: '60 ft darkvision. Fey Ancestry. 2 skill proficiencies.',
    description: '**Darkvision 60 ft.** **Fey Ancestry**: advantage on saves vs. charmed, immune to magical sleep. **Skill Versatility**: proficiency in 2 skills of your choice. **Extra Language**.',
  },
  {
    slug: 'half-orc',
    name: 'Half-Orc',
    size: 'Medium',
    speed: 30,
    asi: '+2 STR, +1 CON',
    subraces: ['Standard'],
    snippet: '60 ft darkvision. Relentless Endurance (drop to 1 HP once/long rest).',
    description: '**Darkvision 60 ft.** **Menacing**: proficient in Intimidation. **Relentless Endurance**: when reduced to 0 HP but not killed outright, drop to 1 HP instead (once per long rest). **Savage Attacks**: when you score a critical hit with a melee weapon attack, roll one additional weapon damage die.',
  },
  {
    slug: 'tiefling',
    name: 'Tiefling',
    size: 'Medium',
    speed: 30,
    asi: '+2 CHA, +1 INT',
    subraces: ['Asmodeus (PHB default)', 'Baalzebul (MToF)', 'Dispater (MToF)', 'Fierna (MToF)', 'Glasya (MToF)', 'Levistus (MToF)', 'Mammon (MToF)', 'Mephistopheles (MToF)', 'Zariel (MToF)'],
    snippet: '60 ft darkvision. Fire resistance. Innate spells (Thaumaturgy + Hellish Rebuke + Darkness).',
    description: '**Darkvision 60 ft.** **Hellish Resistance**: damage resistance to fire. **Infernal Legacy**: Thaumaturgy cantrip at L1, Hellish Rebuke once per long rest at L3, Darkness once per long rest at L5. Casting ability is Charisma.',
  },
];
