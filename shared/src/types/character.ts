export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export type AbilityName = keyof AbilityScores;

export type SkillProficiency = 'none' | 'proficient' | 'expertise';

export interface Skills {
  acrobatics: SkillProficiency;
  animalHandling: SkillProficiency;
  arcana: SkillProficiency;
  athletics: SkillProficiency;
  deception: SkillProficiency;
  history: SkillProficiency;
  insight: SkillProficiency;
  intimidation: SkillProficiency;
  investigation: SkillProficiency;
  medicine: SkillProficiency;
  nature: SkillProficiency;
  perception: SkillProficiency;
  performance: SkillProficiency;
  persuasion: SkillProficiency;
  religion: SkillProficiency;
  sleightOfHand: SkillProficiency;
  stealth: SkillProficiency;
  survival: SkillProficiency;
}

export const SKILL_ABILITY_MAP: Record<keyof Skills, AbilityName> = {
  acrobatics: 'dex',
  animalHandling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleightOfHand: 'dex',
  stealth: 'dex',
  survival: 'wis',
};

export interface CharacterBackground {
  name: string;
  description: string;
  feature: string;
}

export interface CharacterCharacteristics {
  alignment: string;
  gender: string;
  eyes: string;
  hair: string;
  skin: string;
  height: string;
  weight: string;
  age: string;
  faith: string;
  size: string;
}

export interface CharacterPersonality {
  traits: string;
  ideals: string;
  bonds: string;
  flaws: string;
}

export interface CharacterNotes {
  organizations: string;
  allies: string;
  enemies: string;
  backstory: string;
  other: string;
}

export interface CharacterProficiencies {
  armor: string[];
  weapons: string[];
  tools: string[];
  languages: string[];
}

/**
 * 5e sight-range senses. All measured in feet; 0 (or undefined for
 * the new ones) means the creature doesn't have that sense.
 *
 * - `darkvision`  — sees in dim light as if bright, darkness as if
 *                   dim. Typical 60 ft, Superior Darkvision 120 ft.
 * - `blindsight`  — perceives surroundings without relying on sight
 *                   within range. Bats, swarms, Warlock Devil's Sight.
 * - `truesight`   — as blindsight plus see through invisibility,
 *                   illusions, into the Ethereal. Archdevils etc.
 * - `tremorsense` — detects + localizes creatures in contact with
 *                   the same surface (ground, water). Earth elementals.
 *
 * FogLayer uses the max of `darkvision / blindsight / truesight` as
 * the vision radius in `dark` ambient. Tremorsense is tracked but
 * not yet consumed by the renderer (requires line-of-surface logic).
 */
export interface CharacterSenses {
  passivePerception: number;
  passiveInvestigation: number;
  passiveInsight: number;
  darkvision: number;
  blindsight?: number;
  truesight?: number;
  tremorsense?: number;
}

export interface CharacterDefenses {
  resistances: string[];
  immunities: string[];
  vulnerabilities: string[];
}

export interface CharacterCurrency {
  cp: number;
  sp: number;
  ep: number;
  gp: number;
  pp: number;
}

export interface Feature {
  name: string;
  description: string;
  source: string;
  sourceType: 'class' | 'race' | 'feat' | 'background';
  usesTotal?: number;
  usesRemaining?: number;
  resetOn?: 'short' | 'long' | 'dawn' | null;
}

export interface SpellSlot {
  max: number;
  used: number;
}

export interface Spell {
  name: string;
  level: number;
  school: string;
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  description: string;
  damage?: string;
  damageType?: string;
  savingThrow?: AbilityName;
  aoeType?: 'cone' | 'sphere' | 'line' | 'cube' | 'cylinder';
  aoeSize?: number;
  isConcentration: boolean;
  isRitual: boolean;
  higherLevels?: string;
  attackType?: string;
  /**
   * DM-only flag that lets this specific spell ignore slot requirements.
   * Useful for "story moments" — e.g. the DM grants a temporary spell
   * awakening of Fireball to a low-level character. When true, this spell
   * is castable without consuming a slot, even if no slot of the right
   * level is available. Per-spell toggle in the SpellsTab UI.
   */
  dmOverride?: boolean;
  /**
   * Marks this spell as PREPARED for today. Only relevant for prepare-
   * classes (cleric, druid, wizard, paladin, artificer); the UI only
   * shows the toggle on those characters. Undefined or false means the
   * spell is known but not currently prepared — unprepared spells
   * still render in the list but get a dimmed visual state and the
   * player is shown a warning on cast attempts. Cantrips and ritual-
   * only spells ignore this flag (always available).
   */
  prepared?: boolean;
}

export interface InventoryItem {
  name: string;
  quantity: number;
  weight: number;
  description: string;
  equipped: boolean;
  type: 'weapon' | 'armor' | 'potion' | 'scroll' | 'gear' | 'treasure' | 'currency';
  cost?: number;
  attunement?: boolean;
  attuned?: boolean;
  properties?: string[];
  damageType?: string;
  damage?: string;
  rarity?: string;
  slug?: string;           // Link to compendium item
  imageUrl?: string;       // Item image path
  range?: string;          // Weapon range (e.g. '20/60')
  acBonus?: number;        // Armor/shield AC bonus
}

export interface DeathSaves {
  successes: number;
  failures: number;
}

/**
 * Hit Dice for short-rest healing. Stored as a list grouped by die size
 * to support multiclass characters (e.g. a Bard 3 / Fighter 2 has 3d8 + 2d10).
 * For most single-class characters this will have a single entry.
 */
export interface HitDicePool {
  dieSize: number;       // 6, 8, 10, 12
  total: number;         // total dice from levels in this die-size class
  used: number;          // dice spent since last long rest
}

export interface Character {
  id: string;
  userId: string;
  name: string;
  race: string;
  class: string;
  level: number;
  hitPoints: number;
  maxHitPoints: number;
  tempHitPoints: number;
  hitDice: HitDicePool[];
  armorClass: number;
  speed: number;
  proficiencyBonus: number;
  abilityScores: AbilityScores;
  savingThrows: AbilityName[];
  skills: Skills;
  spellSlots: Record<number, SpellSlot>;
  spells: Spell[];
  features: Feature[];
  inventory: InventoryItem[];
  deathSaves: DeathSaves;
  background: CharacterBackground;
  characteristics: CharacterCharacteristics;
  personality: CharacterPersonality;
  notes: CharacterNotes;
  proficiencies: CharacterProficiencies;
  senses: CharacterSenses;
  defenses: CharacterDefenses;
  conditions: string[];
  currency: CharacterCurrency;
  extras: string[];
  spellcastingAbility: string;
  spellAttackBonus: number;
  spellSaveDC: number;
  concentratingOn: string | null;
  initiative: number;
  compendiumSlug: string | null;
  /**
   * 5e exhaustion level 0–6. L1 disadvantage on checks, L2 speed half,
   * L3 disadvantage on attacks + saves, L4 HP max halved, L5 speed 0,
   * L6 death. Reduced by 1 on a long rest or Greater Restoration.
   */
  exhaustionLevel: number;
  portraitUrl: string | null;
  dndbeyondId: string | null;
  source: 'manual' | 'dndbeyond_api' | 'dndbeyond_import';
  createdAt: string;
  updatedAt: string;
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonusForLevel(level: number): number {
  return Math.ceil(level / 4) + 1;
}
