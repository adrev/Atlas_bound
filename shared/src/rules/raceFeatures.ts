/**
 * Race + subrace traits that affect combat math. Data-only (no
 * handlers here) — consumers look up by race string and apply
 * resistances to defenses, save advantages to roll modifiers, etc.
 *
 * Matching is case-insensitive substring — "Hill Dwarf", "Mountain
 * Dwarf", and "Duergar" all match the `dwarf` key. Subrace-specific
 * wrinkles (Mountain Dwarf +10 speed with heavy armor, Wood Elf +5
 * speed) are layered on via explicit subrace entries below.
 */

export type SaveAdvantageFlag = 'advantage' | 'disadvantage';

/**
 * Declarative innate racial spell entry. Matches the PHB wording:
 * Tieflings get Thaumaturgy at L1 (at-will), Hellish Rebuke at L3
 * (1/long rest), Darkness at L5 (1/long rest). Drow gets Faerie Fire
 * at L3 + Darkness at L5. Forest Gnome gets Minor Illusion cantrip.
 * Aasimar subraces get Light cantrip + scourge/protector channel at L3.
 *
 * `uses`:
 *   'at-will'      — cantrip, no charge tracking
 *   'per-long'     — 1 charge that resets on long rest (default for
 *                    non-cantrip racials)
 *   'per-short'    — 1 charge that resets on short rest
 *
 * `availableFromCharLevel` gates the spell so a L1 Tiefling doesn't
 * show Hellish Rebuke in their racial list until they hit L3.
 */
export interface InnateRacialSpell {
  name: string;
  uses: 'at-will' | 'per-short' | 'per-long';
  availableFromCharLevel?: number;
  /** Free-form note, e.g. "ability score CHA" for the cast DC. */
  castingAbility?: 'int' | 'wis' | 'cha';
  notes?: string;
}

export interface RaceTraits {
  /** Base speed override in feet. Undefined = default 30. */
  speed?: number;
  /** Damage resistances (e.g. 'fire' for tiefling, 'poison' for dwarf). */
  resistances?: string[];
  /**
   * Advantage / disadvantage on specific conditions of incoming
   * effects — keys are lowercase save labels.
   *
   *   savesVs['frightened'] = 'advantage' → halfling Brave
   *   savesVs['poison']     = 'advantage' → dwarf resilience
   *   savesVs['magic']      = 'advantage' → gnome Cunning (INT/WIS/CHA
   *                                         vs magic)
   */
  savesVs?: Record<string, SaveAdvantageFlag>;
  /** Innate darkvision range in feet (0 = none). */
  darkvisionFt?: number;
  /**
   * Per-day / per-rest innate spells granted by the race. Consumed by
   * the `!racial` chat command which tracks per-long-rest usage via
   * `room.pointPools`. PHB-derived data — subrace-specific spells
   * (drow, tiefling variants) live on the matching subrace key.
   */
  innateSpells?: InnateRacialSpell[];
  /** Freeform notes (tooltip + wiki). */
  notes?: string[];
}

export const RACE_TRAITS: Record<string, RaceTraits> = {
  // ── PHB core races ─────────────────────────────────────────────
  dwarf: {
    speed: 25,
    resistances: ['poison'],
    savesVs: { poison: 'advantage' },
    darkvisionFt: 60,
    notes: ['25 ft speed', 'Advantage on saves vs poison', 'Resistance to poison damage', 'Darkvision 60 ft'],
  },
  elf: {
    resistances: [],
    savesVs: { charmed: 'advantage' },
    darkvisionFt: 60,
    notes: ['Advantage on saves vs charmed', 'Immune to magical sleep', 'Darkvision 60 ft'],
  },
  halfling: {
    speed: 25,
    savesVs: { frightened: 'advantage' },
    notes: ['25 ft speed', 'Advantage on saves vs frightened (Brave)', 'Lucky: reroll 1s on attacks/checks/saves'],
  },
  human: {
    notes: ['+1 to all ability scores (variant: one feat + two +1s)'],
  },
  dragonborn: {
    notes: ['Breath Weapon (varies by ancestry)', 'Damage resistance (varies by ancestry)'],
  },
  gnome: {
    speed: 25,
    savesVs: { magic: 'advantage' },
    darkvisionFt: 60,
    notes: ['25 ft speed', 'Cunning: advantage on INT/WIS/CHA saves vs magic', 'Darkvision 60 ft'],
  },
  'half-elf': {
    savesVs: { charmed: 'advantage' },
    darkvisionFt: 60,
    notes: ['Advantage on saves vs charmed', 'Immune to magical sleep', 'Darkvision 60 ft'],
  },
  'half-orc': {
    darkvisionFt: 60,
    notes: ['Relentless Endurance: drop to 1 HP instead of 0 (1/long rest)', 'Savage Attacks: extra damage die on melee crits', 'Darkvision 60 ft'],
  },
  tiefling: {
    resistances: ['fire'],
    darkvisionFt: 60,
    innateSpells: [
      { name: 'Thaumaturgy', uses: 'at-will', castingAbility: 'cha' },
      { name: 'Hellish Rebuke', uses: 'per-long', availableFromCharLevel: 3, castingAbility: 'cha',
        notes: 'Cast as L2 reaction when taking damage; 2d10 fire DEX save half.' },
      { name: 'Darkness', uses: 'per-long', availableFromCharLevel: 5, castingAbility: 'cha',
        notes: '15-ft sphere of magical darkness, 10 min.' },
    ],
    notes: ['Resistance to fire damage', 'Thaumaturgy cantrip + Hellish Rebuke (L3) + Darkness (L5) as CHA-based Infernal Legacy', 'Darkvision 60 ft'],
  },

  // ── Common homebrew / expanded races we see in DDB imports ─────
  drow: {
    resistances: [],
    savesVs: { charmed: 'advantage' },
    darkvisionFt: 120,
    innateSpells: [
      { name: 'Dancing Lights', uses: 'at-will', castingAbility: 'cha' },
      { name: 'Faerie Fire', uses: 'per-long', availableFromCharLevel: 3, castingAbility: 'cha',
        notes: '20-ft cube, DEX save or outlined (adv on attacks vs them, can\'t be invisible).' },
      { name: 'Darkness', uses: 'per-long', availableFromCharLevel: 5, castingAbility: 'cha',
        notes: '15-ft sphere of magical darkness, 10 min.' },
    ],
    notes: ['Superior Darkvision 120 ft', 'Advantage on saves vs charmed + no magical sleep', 'Sunlight Sensitivity: disadvantage on attacks + sight checks in direct sunlight'],
  },
  tabaxi: {
    speed: 30,
    darkvisionFt: 60,
    notes: ['Climb speed 20 ft', 'Feline Agility: double speed once until next turn'],
  },
  goliath: {
    resistances: [],
    notes: ['Stone\'s Endurance: reduce damage once per short rest (1d12 + CON)', 'Mountain Born: acclimatized to high altitude + cold'],
  },
  aasimar: {
    resistances: ['necrotic', 'radiant'],
    darkvisionFt: 60,
    innateSpells: [
      { name: 'Light', uses: 'at-will', castingAbility: 'cha' },
    ],
    notes: ['Resistance to necrotic + radiant', 'Celestial Resistance', 'Light cantrip', 'Darkvision 60 ft'],
  },
  firbolg: {
    darkvisionFt: 60,
    innateSpells: [
      { name: 'Detect Magic', uses: 'per-short', castingAbility: 'wis',
        notes: '1/short rest, WIS-based.' },
      { name: 'Disguise Self', uses: 'per-short', castingAbility: 'wis',
        notes: '1/short rest, WIS-based.' },
    ],
    notes: ['Firbolg Magic: Detect Magic + Disguise Self once per short rest', 'Hidden Step: turn invisible as bonus action once per short rest'],
  },
  'forest gnome': {
    speed: 25,
    savesVs: { magic: 'advantage' },
    darkvisionFt: 60,
    innateSpells: [
      { name: 'Minor Illusion', uses: 'at-will', castingAbility: 'int' },
    ],
    notes: ['25 ft speed', 'Natural Illusionist (Minor Illusion cantrip)', 'Speak with Small Beasts: communicate simple ideas via sound / gesture'],
  },
  'high elf': {
    savesVs: { charmed: 'advantage' },
    darkvisionFt: 60,
    innateSpells: [
      // One Wizard cantrip of the player's choice — we expose a
      // placeholder so !racial lists the slot; the DM fills in.
      { name: 'Wizard Cantrip (of choice)', uses: 'at-will', castingAbility: 'int',
        notes: 'High Elf bonus: one wizard cantrip of your choice, INT-based.' },
    ],
    notes: ['Extra wizard cantrip of choice', 'Extra language', 'Advantage on saves vs charmed + no magical sleep', 'Darkvision 60 ft'],
  },
};

/**
 * Look up race traits for a character's `race` field. Returns
 * `undefined` if no match — callers should no-op (don't error).
 *
 * Case-insensitive substring match so "Hill Dwarf" hits `dwarf`,
 * "Wood Elf" hits `elf`, etc. Explicit subrace entries (e.g. `drow`)
 * take precedence over their base-race match.
 */
export function traitsForRace(race: string | null | undefined): RaceTraits | undefined {
  if (!race) return undefined;
  const lower = race.toLowerCase();
  // Exact explicit subrace first.
  if (RACE_TRAITS[lower]) return RACE_TRAITS[lower];
  // Substring match.
  for (const [key, traits] of Object.entries(RACE_TRAITS)) {
    if (lower.includes(key)) return traits;
  }
  return undefined;
}
