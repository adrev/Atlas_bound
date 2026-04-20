export interface BackgroundEntry {
  slug: string;
  name: string;
  skills: string[];
  tools?: string[];
  languages?: number;
  feature: string;
  snippet: string;
  description: string;
}

/**
 * 5e PHB backgrounds. Static data. Most of a background's effect is
 * narrative (the RP flavor + optional characteristics) — mechanically
 * they grant 2 skill proficiencies, sometimes tools or languages, and
 * a signature feature.
 */
export const BACKGROUNDS: BackgroundEntry[] = [
  {
    slug: 'acolyte',
    name: 'Acolyte',
    skills: ['Insight', 'Religion'],
    languages: 2,
    feature: 'Shelter of the Faithful',
    snippet: 'Temple-raised. Free lodging at your faith\'s shrines.',
    description: 'You served a temple, mediated the divine, and now walk the world armed with scripture. **Shelter of the Faithful**: you (and your adventuring companions) can expect free healing and care at a temple, shrine, or other established presence of your faith.',
  },
  {
    slug: 'charlatan',
    name: 'Charlatan',
    skills: ['Deception', 'Sleight of Hand'],
    tools: ['Disguise kit', 'Forgery kit'],
    feature: 'False Identity',
    snippet: 'Professional liar. Can forge documents, adopt personas.',
    description: 'You have always had a way with people. **False Identity**: you have created a second identity that includes documentation, established acquaintances, and disguises. You can also forge documents (including official papers and personal letters) as long as you have seen an example.',
  },
  {
    slug: 'criminal',
    name: 'Criminal',
    skills: ['Deception', 'Stealth'],
    tools: ['One gaming set', 'Thieves\' tools'],
    feature: 'Criminal Contact',
    snippet: 'You know a guy. Underworld-connected.',
    description: 'You are an experienced criminal with a history of breaking the law. **Criminal Contact**: you have a reliable and trustworthy contact who acts as your liaison to a network of other criminals. You can send messages through a chain of trusted intermediaries.',
  },
  {
    slug: 'entertainer',
    name: 'Entertainer',
    skills: ['Acrobatics', 'Performance'],
    tools: ['Disguise kit', 'One musical instrument'],
    feature: 'By Popular Demand',
    snippet: 'Performer. Free lodging + audience.',
    description: 'You thrive in front of an audience. **By Popular Demand**: you can always find a place to perform — usually an inn or tavern, sometimes a circus. At such a place, you receive free lodging and food of a modest or comfortable standard, and your performances are well-received.',
  },
  {
    slug: 'folk-hero',
    name: 'Folk Hero',
    skills: ['Animal Handling', 'Survival'],
    tools: ['One artisan\'s tools', 'Vehicles (land)'],
    feature: 'Rustic Hospitality',
    snippet: 'Common-folk champion. Commoners shelter you.',
    description: 'You come from a humble social rank, but you are destined for so much more. **Rustic Hospitality**: since you come from the ranks of common folk, you fit in among them with ease. You can find a place to hide, rest, or recuperate among other commoners — they will shield you from the law or anyone else searching for you (but won\'t risk their lives).',
  },
  {
    slug: 'guild-artisan',
    name: 'Guild Artisan',
    skills: ['Insight', 'Persuasion'],
    tools: ['One artisan\'s tools'],
    languages: 1,
    feature: 'Guild Membership',
    snippet: 'Tradesman with guild support and networks.',
    description: 'You are a member of an artisan\'s guild, skilled in a particular field. **Guild Membership**: you can rely on certain benefits that membership provides — fellow guild members provide lodging and food if necessary, and pay for your funeral if needed. You may also gain political influence through the guild.',
  },
  {
    slug: 'hermit',
    name: 'Hermit',
    skills: ['Medicine', 'Religion'],
    tools: ['Herbalism kit'],
    languages: 1,
    feature: 'Discovery',
    snippet: 'Lived in seclusion. Has one unique discovery.',
    description: 'You lived in seclusion for a formative part of your life. **Discovery**: the quiet seclusion of your extended hermitage gave you access to a unique and powerful discovery — a great truth about the cosmos, the overthrow of a ruler, a revelation about a powerful monster, or a secret about a prominent figure.',
  },
  {
    slug: 'noble',
    name: 'Noble',
    skills: ['History', 'Persuasion'],
    tools: ['One gaming set'],
    languages: 1,
    feature: 'Position of Privilege',
    snippet: 'High-born. Opens doors with your title.',
    description: 'You understand wealth, power, and privilege. **Position of Privilege**: thanks to your noble birth, people are inclined to think the best of you. You are welcome in high society, and people assume you have the right to be wherever you are.',
  },
  {
    slug: 'outlander',
    name: 'Outlander',
    skills: ['Athletics', 'Survival'],
    tools: ['One musical instrument'],
    languages: 1,
    feature: 'Wanderer',
    snippet: 'Wilderness-born. Never lost, always fed.',
    description: 'You grew up in the wilds, far from civilization. **Wanderer**: you have an excellent memory for maps and geography, and you can always recall the general layout of terrain, settlements, and other features around you. In addition, you can find food and fresh water for yourself and up to five other people each day, provided the land offers them.',
  },
  {
    slug: 'sage',
    name: 'Sage',
    skills: ['Arcana', 'History'],
    languages: 2,
    feature: 'Researcher',
    snippet: 'Scholar. Knows where to find any answer.',
    description: 'You spent years learning the lore of the multiverse. **Researcher**: when you attempt to learn or recall a piece of lore, if you do not know that information, you often know where and from whom you can obtain it.',
  },
  {
    slug: 'sailor',
    name: 'Sailor',
    skills: ['Athletics', 'Perception'],
    tools: ['Navigator\'s tools', 'Vehicles (water)'],
    feature: 'Ship\'s Passage',
    snippet: 'Former crew. Free passage on sailing vessels.',
    description: 'You sailed on a seagoing vessel for years. **Ship\'s Passage**: when you need to, you can secure free passage on a sailing ship for yourself and your adventuring companions. You and your companions may have to work during the voyage as part of the crew.',
  },
  {
    slug: 'soldier',
    name: 'Soldier',
    skills: ['Athletics', 'Intimidation'],
    tools: ['One gaming set', 'Vehicles (land)'],
    feature: 'Military Rank',
    snippet: 'Veteran. Rank still carries weight.',
    description: 'War has been your life for as long as you care to remember. **Military Rank**: you have a military rank from your career as a soldier. Soldiers loyal to your former organization still recognize your authority and influence, and they defer to you if they are of a lower rank.',
  },
  {
    slug: 'urchin',
    name: 'Urchin',
    skills: ['Sleight of Hand', 'Stealth'],
    tools: ['Disguise kit', 'Thieves\' tools'],
    feature: 'City Secrets',
    snippet: 'Street kid. Travel half-speed in cities.',
    description: 'You grew up on the streets alone, orphaned and poor. **City Secrets**: you know the secret patterns and flow of cities and can find passages through the urban sprawl that others would miss. When not in combat, you (and companions you lead) can travel between any two locations in the city twice as fast as your speed would normally allow.',
  },
];
