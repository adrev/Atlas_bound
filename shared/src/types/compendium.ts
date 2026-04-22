export type CompendiumCategory = 'monsters' | 'spells' | 'items' | 'conditions' | 'classes' | 'races' | 'feats' | 'backgrounds';

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';

export interface CompendiumSearchResult {
  slug: string;
  name: string;
  category: CompendiumCategory;
  snippet: string;
  rarity?: ItemRarity;
  cr?: string;
  level?: number;
}

export interface CompendiumMonster {
  slug: string;
  name: string;
  size: string;
  type: string;
  alignment: string;
  armorClass: number;
  hitPoints: number;
  hitDice: string;
  speed: Record<string, number>;
  abilityScores: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  challengeRating: string;
  crNumeric: number;
  actions: { name: string; desc: string; attack_bonus?: number; damage_dice?: string }[];
  specialAbilities: { name: string; desc: string }[];
  legendaryActions: { name: string; desc: string }[];
  description: string;
  senses: string;
  languages: string;
  damageResistances: string;
  damageImmunities: string;
  conditionImmunities: string;
  source: string;
  tokenImageSource?: 'open5e' | 'uploaded' | 'ai-generated' | 'generated';
}

export interface CompendiumSpell {
  slug: string;
  name: string;
  level: number;
  school: string;
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  description: string;
  higherLevels: string;
  concentration: boolean;
  ritual: boolean;
  classes: string[];
  source: string;
}

export interface CompendiumItem {
  slug: string;
  name: string;
  type: string;
  rarity: string;
  requiresAttunement: boolean;
  description: string;
  source: string;
}

export interface CustomItem {
  id: string;
  sessionId: string;
  name: string;
  type: string;
  rarity: ItemRarity;
  description: string;
  imageUrl: string | null;
  weight: number;
  valueGp: number;
  requiresAttunement: boolean;
  statEffects: Record<string, number>;
  properties: string[];
  damage: string;
  damageType: string;
  history: string;
  createdAt: string;
}

export interface LootEntry {
  id: string;
  characterId: string;
  itemSlug: string | null;
  customItemId: string | null;
  itemName: string;
  itemRarity: string;
  quantity: number;
}
