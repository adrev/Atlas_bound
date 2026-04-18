// ========== Mock data ==========
const HERO = {
  name: 'Liraya Voss',
  race: 'Tiefling',
  class: 'Bard',
  level: 2,
  ac: 13,
  spd: 30,
  init: 2,
  hp: 14, hpMax: 14,
  avatar: 'https://images.unsplash.com/photo-1535979014199-ce98cb8ea5a7?q=80&w=200&h=200&auto=format&fit=crop&crop=faces',
  stats: { STR: -1, DEX: 2, CON: 1, INT: 1, WIS: 1, CHA: 3 },
  rawStats: { STR: 8, DEX: 14, CON: 12, INT: 12, WIS: 12, CHA: 17 },
  prof: 2,
  saves: { STR: -1, DEX: 4, CON: 1, INT: 1, WIS: 1, CHA: 5 },
  savesProf: { DEX: true, CHA: true },
  skills: [
    ['Acrobatics', 'DEX', 2, false],
    ['Animal Handling', 'WIS', 1, false],
    ['Arcana', 'INT', 3, true],
    ['Athletics', 'STR', -1, false],
    ['Deception', 'CHA', 3, false],
    ['History', 'INT', 1, false],
    ['Insight', 'WIS', 3, true],
    ['Intimidation', 'CHA', 3, false],
    ['Investigation', 'INT', 1, false],
    ['Medicine', 'WIS', 1, false],
    ['Nature', 'INT', 1, false],
    ['Perception', 'WIS', 5, true, true],
    ['Performance', 'CHA', 3, false],
    ['Persuasion', 'CHA', 7, true, true],
    ['Religion', 'INT', 3, true],
    ['Sleight of Hand', 'DEX', 2, false],
    ['Stealth', 'DEX', 2, false],
    ['Survival', 'WIS', 1, false],
  ],
  passive: { perception: 15, investigation: 11, insight: 13 },
  senses: 'Darkvision 60 ft.',
  resist: ['Poison'],
  attacks: [
    { name: 'Dagger', melee: '+4 (5ft)', offHand: true, thrown: '+4 (20ft)', dmg: '1d4', tags: ['Finesse', 'Light', 'Thrown', 'Nick'] },
    { name: 'Dagger', melee: '+4 (5ft)', offHand: true, thrown: '+4 (20ft)', dmg: '1d4', tags: ['Finesse', 'Light', 'Thrown', 'Nick'] },
  ],
  cantrips: [
    { name: 'Message', school: 'Transmutation' },
    { name: 'Vicious Mockery', school: 'Enchantment', dmg: '1d6', info: 'DC 13 WIS' },
    { name: 'Thaumaturgy', school: 'Transmutation' },
    { name: 'Poison Spray', school: 'Necromancy', dmg: '1d12' },
    { name: 'Guidance', school: 'Divination' },
    { name: 'Light', school: 'Evocation' },
  ],
  spells: [
    { name: 'Tasha\'s Hideous Laughter', lvl: 1, slot: '3/3' },
    { name: 'Identify', lvl: 1, slot: '3/3' },
    { name: 'Thunderwave', lvl: 1, slot: '3/3', dmg: '2d8' },
    { name: 'Healing Word', lvl: 1, slot: '3/3', dmg: '1d4' },
    { name: 'Command', lvl: 1, slot: '3/3' },
    { name: 'Cure Wounds', lvl: 1, slot: '3/3', dmg: '1d8' },
  ],
  inventory: [
    { id: 'leather', name: 'Leather', type: 'armor', equipped: true, qty: 1, letter: 'L', color: '#7a5a3a' },
    { id: 'dagger1', name: 'Dagger', type: 'weapon 1d4', equipped: true, qty: 1, letter: 'D', color: '#6a6a7a' },
    { id: 'dagger2', name: 'Dagger', type: 'weapon 1d4', equipped: true, qty: 1, letter: 'D', color: '#6a6a7a' },
    { id: 'parch', name: 'Parchment', type: 'gear', qty: 10, letter: 'P', color: '#b39a6a' },
    { id: 'backpack', name: 'Backpack', type: 'gear', qty: 1, letter: 'B', color: '#8b6a3a' },
    { id: 'calli', name: "Calligrapher's Supplies", type: 'gear', qty: 1, letter: 'C', color: '#6a4a2a' },
    { id: 'robe', name: 'Robe', type: 'gear', qty: 1, letter: 'R', color: '#9d2a23' },
    { id: 'book', name: 'Book', type: 'gear', qty: 1, letter: 'B', color: '#3a5a7a' },
    { id: 'drum', name: 'Drum', type: 'gear', qty: 1, letter: 'D', color: '#7a4a2a' },
    { id: 'holy', name: 'Holy Symbol', type: 'gear', qty: 1, letter: 'H', color: '#c79632' },
    { id: 'oil', name: 'Oil', type: 'gear', qty: 8, letter: 'O', color: '#4a3a2a' },
    { id: 'rations', name: 'Rations', type: 'gear', qty: 9, letter: 'R', color: '#8a6a3a' },
  ],
  traits: [
    { name: 'Darkvision', source: 'Tiefling', desc: 'You have Darkvision with a range of 60 feet.' },
    { name: 'Otherworldly Presence', source: 'Tiefling' },
    { name: 'Creature Type', source: 'Tiefling' },
    { name: 'Size', source: 'Tiefling' },
    { name: 'Speed', source: 'Tiefling' },
    { name: 'Fiendish Legacy', source: 'Tiefling' },
    { name: 'Fiendish Legacy Spells', source: 'Tiefling' },
    { name: 'Ability Score Increases', source: 'Tiefling' },
    { name: 'Languages', source: 'Tiefling' },
    { name: 'Bardic Inspiration', source: 'Bard' },
  ],
  background: {
    name: 'Acolyte',
    desc: 'You devoted yourself to service in a temple, either nestled in a town or secluded in a sacred grove. There you performed rites in honor of a god or pantheon. You served under a priest and studied religion. Thanks to your priest\'s instruction and your own devotion, you also learned how to channel a modicum of divine power in service to your place of worship and the people who prayed there.',
    alignment: 'Chaotic Good',
    size: 'Medium',
  },
};

const INITIATIVE = [
  { init: 15, name: 'Vulture', hp: 10, hpMax: 10, avatar: 'https://images.unsplash.com/photo-1600267175161-cfaa711b4a81?q=80&w=80&auto=format&fit=crop', enemy: true },
  { init: 14, name: 'Liraya Voss', hp: 14, hpMax: 14, avatar: HERO.avatar },
  { init: 8, name: 'Zoog', hp: 10, hpMax: 10, avatar: 'https://images.unsplash.com/photo-1516054575922-f0b8eeadec1a?q=80&w=80&auto=format&fit=crop' },
  { init: 5, name: 'Awakened Shrub', hp: 10, hpMax: 10, avatar: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?q=80&w=80&auto=format&fit=crop' },
];

const ROLLS = [
  { type: 'DAMAGE', total: 2, formula: '1d12', rolls: [2], by: '.adrev' },
  { type: 'DAMAGE', total: 3, formula: '1d12', rolls: [3], by: '.adrev' },
  { type: 'DAMAGE', total: 9, formula: '2d6+3', note: 'QA test', rolls: [5, 1], bonus: 3, by: '.adrev', calc: '6 + 3 = 9' },
  { type: 'DAMAGE', total: 7, formula: '1d100', rolls: [7], by: '.adrev' },
];

const SPELLS_WIKI = [
  { name: 'Acid Splash', lvl: 'Cantrip', school: 'Conjuration', color: '#4dbf4d' },
  { name: 'Ale-dritch Blast', lvl: 'Cantrip', school: 'Evocation', color: '#4d7dbf' },
  { name: 'Altered Strike', lvl: 'Cantrip', school: 'Transmutation', color: '#d97a3a' },
  { name: 'Animated Scroll', lvl: 'Cantrip', school: 'Transmutation', color: '#7a5abf' },
  { name: 'Arcane Muscles', lvl: 'Cantrip', school: 'Transmutation', color: '#a0509b' },
  { name: 'Benediction', lvl: 'Cantrip', school: 'Divination', color: '#c7a032' },
  { name: 'Biting Arrow', lvl: 'Cantrip', school: 'Evocation', color: '#bf4d4d' },
  { name: "Black Goat's Blessing", lvl: 'Cantrip', school: 'Necromancy', color: '#d97a3a' },
  { name: 'Bless the Dead', lvl: 'Cantrip', school: 'Necromancy', color: '#5a7a4a' },
  { name: 'Blood Tide', lvl: 'Cantrip', school: 'Necromancy', color: '#9d2a23' },
  { name: 'Brimstone Infusion', lvl: 'Cantrip', school: 'Evocation', color: '#d94a2a' },
  { name: 'Calculate', lvl: 'Cantrip', school: 'Divination', color: '#7a5abf' },
  { name: 'Caustic Touch', lvl: 'Cantrip', school: 'Conjuration', color: '#6abf4d' },
];

const CREATURES = [
  { name: 'Awakened Shrub', type: 'PLANT', cr: '0', lvl: '1-2', hp: 10, ac: 9, avatar: 'https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?q=80&w=80&auto=format&fit=crop' },
  { name: 'Baboon', type: 'BEAST', cr: '0', lvl: '1-2', hp: 3, ac: 12, avatar: 'https://images.unsplash.com/photo-1576200903227-c2ccde46ec40?q=80&w=80&auto=format&fit=crop' },
  { name: 'Badger', type: 'BEAST', cr: '0', lvl: '1-2', hp: 3, ac: 10, avatar: 'https://images.unsplash.com/photo-1502317854707-eafb8c53ab95?q=80&w=80&auto=format&fit=crop' },
  { name: 'Bat', type: 'BEAST', cr: '0', lvl: '1-2', hp: 1, ac: 12, avatar: 'https://images.unsplash.com/photo-1612119681884-8ba0f0ad0088?q=80&w=80&auto=format&fit=crop' },
  { name: 'Cat', type: 'BEAST', cr: '0', lvl: '1-2', hp: 2, ac: 12, avatar: 'https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8?q=80&w=80&auto=format&fit=crop' },
  { name: 'Vulture', type: 'BEAST', cr: '0', lvl: '1-2', hp: 5, ac: 10, avatar: 'https://images.unsplash.com/photo-1600267175161-cfaa711b4a81?q=80&w=80&auto=format&fit=crop' },
  { name: 'Zoog', type: 'ABERRATION', cr: '1/2', lvl: '1-2', hp: 10, ac: 12, avatar: 'https://images.unsplash.com/photo-1516054575922-f0b8eeadec1a?q=80&w=80&auto=format&fit=crop' },
];

const MAPS = [
  { name: 'Forked Forest Path', grid: '30x22', category: 'Combat', desc: 'Wooded Y-junction where a stream crosses under a small footbridge.', img: 'https://images.unsplash.com/photo-1448375240586-882707db888b?q=80&w=600&auto=format&fit=crop' },
  { name: 'River Crossing', grid: '28x20', category: 'Combat', desc: 'Wide river with a wooden bridge, rocky fords, and tree cover on both banks.', img: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=600&auto=format&fit=crop' },
  { name: 'Snowy Mountain Pass', grid: '32x24', category: 'Combat', desc: 'Winter trail winding between cliffs, scattered with a broken cart and boulders.', img: 'https://images.unsplash.com/photo-1491555103944-7c647fd857e6?q=80&w=600&auto=format&fit=crop' },
  { name: 'Abandoned Tavern', grid: '26x18', category: 'Social', desc: 'Dusty common room with toppled chairs, a long bar, and a hearth still warm.', img: 'https://images.unsplash.com/photo-1600489000022-c2086d79f9d4?q=80&w=600&auto=format&fit=crop' },
  { name: 'Crypt Entrance', grid: '30x22', category: 'Dungeon', desc: 'Stone arch with skeletal guardians, torchlight flickering on mossy walls.', img: 'https://images.unsplash.com/photo-1515442261605-cd5b4b54755e?q=80&w=600&auto=format&fit=crop' },
  { name: 'Ruined Watchtower', grid: '24x20', category: 'Rest', desc: 'Crumbling tower atop a hill, half-collapsed walls, rusted banners.', img: 'https://images.unsplash.com/photo-1518709594023-6eab9bab7b23?q=80&w=600&auto=format&fit=crop' },
];

const MUSIC_THEMES = [
  { name: 'Tavern', icon: 'cup' },
  { name: 'Combat', icon: 'swords', active: true },
  { name: 'Exploration', icon: 'tree' },
  { name: 'Mystery', icon: 'orb' },
  { name: 'Boss Fight', icon: 'skull' },
  { name: 'Peaceful', icon: 'flower' },
  { name: 'Dungeon', icon: 'candle' },
  { name: 'Storm', icon: 'cloud-storm' },
];

const PLAYLIST = ['Combat I', 'Combat I (Alt)', 'Combat II', 'Combat II (Alt)', 'Combat III', 'Combat III (Alt)', 'Combat IV'];

const LOG_EVENTS = [
  { kind: 'rest-short', text: 'Liraya Voss finishes a Short Rest' },
  { kind: 'rest-long', text: 'Liraya Voss takes a Long Rest', sub: 'Already fully rested' },
];

Object.assign(window, {
  HERO, INITIATIVE, ROLLS, SPELLS_WIKI, CREATURES, MAPS, MUSIC_THEMES, PLAYLIST, LOG_EVENTS
});
