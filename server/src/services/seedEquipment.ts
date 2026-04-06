/**
 * Seeds basic PHB mundane equipment (weapons, armor, adventuring gear) into
 * the compendium_items table. Open5e only provides magic items, so we need to
 * manually seed the standard equipment table.
 *
 * Safe to re-run: uses INSERT OR IGNORE so existing rows are not overwritten.
 */
import db from '../db/connection.js';

interface EquipmentEntry {
  slug: string;
  name: string;
  type: string;        // 'Simple Melee Weapon', 'Martial Ranged Weapon', 'Light Armor', etc.
  rarity: string;      // 'common' for all mundane gear
  description: string; // Human-readable description with damage, properties, etc.
  rawJson: Record<string, unknown>; // Structured data (damage, weight, cost, properties)
}

// --- Simple Melee Weapons ---
const SIMPLE_MELEE: EquipmentEntry[] = [
  { slug: 'club', name: 'Club', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d4 bludgeoning. Light. 2 lb. 1 sp.',
    rawJson: { damage: '1d4', damageType: 'bludgeoning', weight: 2, costGp: 0.1, properties: ['Light'] }},
  { slug: 'dagger', name: 'Dagger', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d4 piercing. Finesse, Light, Thrown (range 20/60). 1 lb. 2 gp.',
    rawJson: { damage: '1d4', damageType: 'piercing', weight: 1, costGp: 2, properties: ['Finesse', 'Light', 'Thrown'], range: '20/60' }},
  { slug: 'greatclub', name: 'Greatclub', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d8 bludgeoning. Two-Handed. 10 lb. 2 sp.',
    rawJson: { damage: '1d8', damageType: 'bludgeoning', weight: 10, costGp: 0.2, properties: ['Two-Handed'] }},
  { slug: 'handaxe', name: 'Handaxe', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d6 slashing. Light, Thrown (range 20/60). 2 lb. 5 gp.',
    rawJson: { damage: '1d6', damageType: 'slashing', weight: 2, costGp: 5, properties: ['Light', 'Thrown'], range: '20/60' }},
  { slug: 'javelin', name: 'Javelin', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d6 piercing. Thrown (range 30/120). 2 lb. 5 sp.',
    rawJson: { damage: '1d6', damageType: 'piercing', weight: 2, costGp: 0.5, properties: ['Thrown'], range: '30/120' }},
  { slug: 'light-hammer', name: 'Light Hammer', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d4 bludgeoning. Light, Thrown (range 20/60). 2 lb. 2 gp.',
    rawJson: { damage: '1d4', damageType: 'bludgeoning', weight: 2, costGp: 2, properties: ['Light', 'Thrown'], range: '20/60' }},
  { slug: 'mace', name: 'Mace', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d6 bludgeoning. 4 lb. 5 gp.',
    rawJson: { damage: '1d6', damageType: 'bludgeoning', weight: 4, costGp: 5, properties: [] }},
  { slug: 'quarterstaff', name: 'Quarterstaff', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d6 bludgeoning. Versatile (1d8). 4 lb. 2 sp.',
    rawJson: { damage: '1d6', damageType: 'bludgeoning', weight: 4, costGp: 0.2, properties: ['Versatile'], versatileDamage: '1d8' }},
  { slug: 'sickle', name: 'Sickle', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d4 slashing. Light. 2 lb. 1 gp.',
    rawJson: { damage: '1d4', damageType: 'slashing', weight: 2, costGp: 1, properties: ['Light'] }},
  { slug: 'spear', name: 'Spear', type: 'Simple Melee Weapon', rarity: 'common',
    description: '1d6 piercing. Thrown (range 20/60), Versatile (1d8). 3 lb. 1 gp.',
    rawJson: { damage: '1d6', damageType: 'piercing', weight: 3, costGp: 1, properties: ['Thrown', 'Versatile'], range: '20/60', versatileDamage: '1d8' }},
];

// --- Simple Ranged Weapons ---
const SIMPLE_RANGED: EquipmentEntry[] = [
  { slug: 'crossbow-light', name: 'Crossbow, Light', type: 'Simple Ranged Weapon', rarity: 'common',
    description: '1d8 piercing. Ammunition (range 80/320), Loading, Two-Handed. 5 lb. 25 gp.',
    rawJson: { damage: '1d8', damageType: 'piercing', weight: 5, costGp: 25, properties: ['Ammunition', 'Loading', 'Two-Handed'], range: '80/320' }},
  { slug: 'dart', name: 'Dart', type: 'Simple Ranged Weapon', rarity: 'common',
    description: '1d4 piercing. Finesse, Thrown (range 20/60). 1/4 lb. 5 cp.',
    rawJson: { damage: '1d4', damageType: 'piercing', weight: 0.25, costGp: 0.05, properties: ['Finesse', 'Thrown'], range: '20/60' }},
  { slug: 'shortbow', name: 'Shortbow', type: 'Simple Ranged Weapon', rarity: 'common',
    description: '1d6 piercing. Ammunition (range 80/320), Two-Handed. 2 lb. 25 gp.',
    rawJson: { damage: '1d6', damageType: 'piercing', weight: 2, costGp: 25, properties: ['Ammunition', 'Two-Handed'], range: '80/320' }},
  { slug: 'sling', name: 'Sling', type: 'Simple Ranged Weapon', rarity: 'common',
    description: '1d4 bludgeoning. Ammunition (range 30/120). 0 lb. 1 sp.',
    rawJson: { damage: '1d4', damageType: 'bludgeoning', weight: 0, costGp: 0.1, properties: ['Ammunition'], range: '30/120' }},
];

// --- Martial Melee Weapons ---
const MARTIAL_MELEE: EquipmentEntry[] = [
  { slug: 'battleaxe', name: 'Battleaxe', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 slashing. Versatile (1d10). 4 lb. 10 gp.',
    rawJson: { damage: '1d8', damageType: 'slashing', weight: 4, costGp: 10, properties: ['Versatile'], versatileDamage: '1d10' }},
  { slug: 'flail', name: 'Flail', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 bludgeoning. 2 lb. 10 gp.',
    rawJson: { damage: '1d8', damageType: 'bludgeoning', weight: 2, costGp: 10, properties: [] }},
  { slug: 'glaive', name: 'Glaive', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d10 slashing. Heavy, Reach, Two-Handed. 6 lb. 20 gp.',
    rawJson: { damage: '1d10', damageType: 'slashing', weight: 6, costGp: 20, properties: ['Heavy', 'Reach', 'Two-Handed'] }},
  { slug: 'greataxe', name: 'Greataxe', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d12 slashing. Heavy, Two-Handed. 7 lb. 30 gp.',
    rawJson: { damage: '1d12', damageType: 'slashing', weight: 7, costGp: 30, properties: ['Heavy', 'Two-Handed'] }},
  { slug: 'greatsword', name: 'Greatsword', type: 'Martial Melee Weapon', rarity: 'common',
    description: '2d6 slashing. Heavy, Two-Handed. 6 lb. 50 gp.',
    rawJson: { damage: '2d6', damageType: 'slashing', weight: 6, costGp: 50, properties: ['Heavy', 'Two-Handed'] }},
  { slug: 'halberd', name: 'Halberd', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d10 slashing. Heavy, Reach, Two-Handed. 6 lb. 20 gp.',
    rawJson: { damage: '1d10', damageType: 'slashing', weight: 6, costGp: 20, properties: ['Heavy', 'Reach', 'Two-Handed'] }},
  { slug: 'lance', name: 'Lance', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d12 piercing. Reach, Special. 6 lb. 10 gp. You have disadvantage when you use a lance to attack a target within 5 feet of you. Also, a lance requires two hands to wield when you aren\'t mounted.',
    rawJson: { damage: '1d12', damageType: 'piercing', weight: 6, costGp: 10, properties: ['Reach', 'Special'] }},
  { slug: 'longsword', name: 'Longsword', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 slashing. Versatile (1d10). 3 lb. 15 gp.',
    rawJson: { damage: '1d8', damageType: 'slashing', weight: 3, costGp: 15, properties: ['Versatile'], versatileDamage: '1d10' }},
  { slug: 'maul', name: 'Maul', type: 'Martial Melee Weapon', rarity: 'common',
    description: '2d6 bludgeoning. Heavy, Two-Handed. 10 lb. 10 gp.',
    rawJson: { damage: '2d6', damageType: 'bludgeoning', weight: 10, costGp: 10, properties: ['Heavy', 'Two-Handed'] }},
  { slug: 'morningstar', name: 'Morningstar', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 piercing. 4 lb. 15 gp.',
    rawJson: { damage: '1d8', damageType: 'piercing', weight: 4, costGp: 15, properties: [] }},
  { slug: 'pike', name: 'Pike', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d10 piercing. Heavy, Reach, Two-Handed. 18 lb. 5 gp.',
    rawJson: { damage: '1d10', damageType: 'piercing', weight: 18, costGp: 5, properties: ['Heavy', 'Reach', 'Two-Handed'] }},
  { slug: 'rapier', name: 'Rapier', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 piercing. Finesse. 2 lb. 25 gp.',
    rawJson: { damage: '1d8', damageType: 'piercing', weight: 2, costGp: 25, properties: ['Finesse'] }},
  { slug: 'scimitar', name: 'Scimitar', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d6 slashing. Finesse, Light. 3 lb. 25 gp.',
    rawJson: { damage: '1d6', damageType: 'slashing', weight: 3, costGp: 25, properties: ['Finesse', 'Light'] }},
  { slug: 'shortsword', name: 'Shortsword', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d6 piercing. Finesse, Light. 2 lb. 10 gp.',
    rawJson: { damage: '1d6', damageType: 'piercing', weight: 2, costGp: 10, properties: ['Finesse', 'Light'] }},
  { slug: 'trident', name: 'Trident', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d6 piercing. Thrown (range 20/60), Versatile (1d8). 4 lb. 5 gp.',
    rawJson: { damage: '1d6', damageType: 'piercing', weight: 4, costGp: 5, properties: ['Thrown', 'Versatile'], range: '20/60', versatileDamage: '1d8' }},
  { slug: 'war-pick', name: 'War Pick', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 piercing. 2 lb. 5 gp.',
    rawJson: { damage: '1d8', damageType: 'piercing', weight: 2, costGp: 5, properties: [] }},
  { slug: 'warhammer', name: 'Warhammer', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d8 bludgeoning. Versatile (1d10). 2 lb. 15 gp.',
    rawJson: { damage: '1d8', damageType: 'bludgeoning', weight: 2, costGp: 15, properties: ['Versatile'], versatileDamage: '1d10' }},
  { slug: 'whip', name: 'Whip', type: 'Martial Melee Weapon', rarity: 'common',
    description: '1d4 slashing. Finesse, Reach. 3 lb. 2 gp.',
    rawJson: { damage: '1d4', damageType: 'slashing', weight: 3, costGp: 2, properties: ['Finesse', 'Reach'] }},
];

// --- Martial Ranged Weapons ---
const MARTIAL_RANGED: EquipmentEntry[] = [
  { slug: 'blowgun', name: 'Blowgun', type: 'Martial Ranged Weapon', rarity: 'common',
    description: '1 piercing. Ammunition (range 25/100), Loading. 1 lb. 10 gp.',
    rawJson: { damage: '1', damageType: 'piercing', weight: 1, costGp: 10, properties: ['Ammunition', 'Loading'], range: '25/100' }},
  { slug: 'crossbow-hand', name: 'Crossbow, Hand', type: 'Martial Ranged Weapon', rarity: 'common',
    description: '1d6 piercing. Ammunition (range 30/120), Light, Loading. 3 lb. 75 gp.',
    rawJson: { damage: '1d6', damageType: 'piercing', weight: 3, costGp: 75, properties: ['Ammunition', 'Light', 'Loading'], range: '30/120' }},
  { slug: 'crossbow-heavy', name: 'Crossbow, Heavy', type: 'Martial Ranged Weapon', rarity: 'common',
    description: '1d10 piercing. Ammunition (range 100/400), Heavy, Loading, Two-Handed. 18 lb. 50 gp.',
    rawJson: { damage: '1d10', damageType: 'piercing', weight: 18, costGp: 50, properties: ['Ammunition', 'Heavy', 'Loading', 'Two-Handed'], range: '100/400' }},
  { slug: 'longbow', name: 'Longbow', type: 'Martial Ranged Weapon', rarity: 'common',
    description: '1d8 piercing. Ammunition (range 150/600), Heavy, Two-Handed. 2 lb. 50 gp.',
    rawJson: { damage: '1d8', damageType: 'piercing', weight: 2, costGp: 50, properties: ['Ammunition', 'Heavy', 'Two-Handed'], range: '150/600' }},
  { slug: 'net', name: 'Net', type: 'Martial Ranged Weapon', rarity: 'common',
    description: 'Special. Thrown (range 5/15). 3 lb. 1 gp. A Large or smaller creature hit by a net is restrained until freed.',
    rawJson: { damage: '0', damageType: 'none', weight: 3, costGp: 1, properties: ['Special', 'Thrown'], range: '5/15' }},
];

// --- Armor ---
const ARMOR: EquipmentEntry[] = [
  // Light Armor
  { slug: 'padded-armor', name: 'Padded Armor', type: 'Light Armor', rarity: 'common',
    description: 'AC 11 + Dex modifier. Disadvantage on Stealth. 8 lb. 5 gp.',
    rawJson: { ac: 11, acType: 'dex', stealthDisadvantage: true, weight: 8, costGp: 5 }},
  { slug: 'leather-armor', name: 'Leather Armor', type: 'Light Armor', rarity: 'common',
    description: 'AC 11 + Dex modifier. 10 lb. 10 gp.',
    rawJson: { ac: 11, acType: 'dex', stealthDisadvantage: false, weight: 10, costGp: 10 }},
  { slug: 'studded-leather-armor', name: 'Studded Leather Armor', type: 'Light Armor', rarity: 'common',
    description: 'AC 12 + Dex modifier. 13 lb. 45 gp.',
    rawJson: { ac: 12, acType: 'dex', stealthDisadvantage: false, weight: 13, costGp: 45 }},
  // Medium Armor
  { slug: 'hide-armor', name: 'Hide Armor', type: 'Medium Armor', rarity: 'common',
    description: 'AC 12 + Dex modifier (max 2). 12 lb. 10 gp.',
    rawJson: { ac: 12, acType: 'dex-max-2', stealthDisadvantage: false, weight: 12, costGp: 10 }},
  { slug: 'chain-shirt', name: 'Chain Shirt', type: 'Medium Armor', rarity: 'common',
    description: 'AC 13 + Dex modifier (max 2). 20 lb. 50 gp.',
    rawJson: { ac: 13, acType: 'dex-max-2', stealthDisadvantage: false, weight: 20, costGp: 50 }},
  { slug: 'scale-mail', name: 'Scale Mail', type: 'Medium Armor', rarity: 'common',
    description: 'AC 14 + Dex modifier (max 2). Disadvantage on Stealth. 45 lb. 50 gp.',
    rawJson: { ac: 14, acType: 'dex-max-2', stealthDisadvantage: true, weight: 45, costGp: 50 }},
  { slug: 'breastplate', name: 'Breastplate', type: 'Medium Armor', rarity: 'common',
    description: 'AC 14 + Dex modifier (max 2). 20 lb. 400 gp.',
    rawJson: { ac: 14, acType: 'dex-max-2', stealthDisadvantage: false, weight: 20, costGp: 400 }},
  { slug: 'half-plate', name: 'Half Plate', type: 'Medium Armor', rarity: 'common',
    description: 'AC 15 + Dex modifier (max 2). Disadvantage on Stealth. 40 lb. 750 gp.',
    rawJson: { ac: 15, acType: 'dex-max-2', stealthDisadvantage: true, weight: 40, costGp: 750 }},
  // Heavy Armor
  { slug: 'ring-mail', name: 'Ring Mail', type: 'Heavy Armor', rarity: 'common',
    description: 'AC 14. Disadvantage on Stealth. 40 lb. 30 gp.',
    rawJson: { ac: 14, acType: 'flat', stealthDisadvantage: true, weight: 40, costGp: 30 }},
  { slug: 'chain-mail', name: 'Chain Mail', type: 'Heavy Armor', rarity: 'common',
    description: 'AC 16. Disadvantage on Stealth. Str 13 required. 55 lb. 75 gp.',
    rawJson: { ac: 16, acType: 'flat', stealthDisadvantage: true, strRequired: 13, weight: 55, costGp: 75 }},
  { slug: 'splint-armor', name: 'Splint Armor', type: 'Heavy Armor', rarity: 'common',
    description: 'AC 17. Disadvantage on Stealth. Str 15 required. 60 lb. 200 gp.',
    rawJson: { ac: 17, acType: 'flat', stealthDisadvantage: true, strRequired: 15, weight: 60, costGp: 200 }},
  { slug: 'plate-armor', name: 'Plate Armor', type: 'Heavy Armor', rarity: 'common',
    description: 'AC 18. Disadvantage on Stealth. Str 15 required. 65 lb. 1500 gp.',
    rawJson: { ac: 18, acType: 'flat', stealthDisadvantage: true, strRequired: 15, weight: 65, costGp: 1500 }},
  // Shield
  { slug: 'shield', name: 'Shield', type: 'Shield', rarity: 'common',
    description: '+2 AC. 6 lb. 10 gp. A shield is made from wood or metal and is carried in one hand.',
    rawJson: { acBonus: 2, weight: 6, costGp: 10 }},
];

// --- Adventuring Gear ---
const ADVENTURING_GEAR: EquipmentEntry[] = [
  { slug: 'backpack', name: 'Backpack', type: 'Adventuring Gear', rarity: 'common',
    description: '1 cubic foot / 30 pounds of gear. 5 lb. 2 gp.',
    rawJson: { weight: 5, costGp: 2 }},
  { slug: 'bedroll', name: 'Bedroll', type: 'Adventuring Gear', rarity: 'common',
    description: '7 lb. 1 gp.', rawJson: { weight: 7, costGp: 1 }},
  { slug: 'rope-hempen-50-feet', name: 'Rope, Hempen (50 feet)', type: 'Adventuring Gear', rarity: 'common',
    description: '10 lb. 1 gp. 2 hit points and can be burst with a DC 17 Strength check.',
    rawJson: { weight: 10, costGp: 1 }},
  { slug: 'rope-silk-50-feet', name: 'Rope, Silk (50 feet)', type: 'Adventuring Gear', rarity: 'common',
    description: '5 lb. 10 gp. 2 hit points and can be burst with a DC 17 Strength check.',
    rawJson: { weight: 5, costGp: 10 }},
  { slug: 'torch', name: 'Torch', type: 'Adventuring Gear', rarity: 'common',
    description: 'A torch burns for 1 hour, providing bright light in a 20-foot radius and dim light for an additional 20 feet. 1 lb. 1 cp.',
    rawJson: { weight: 1, costGp: 0.01, light: { bright: 20, dim: 40 } }},
  { slug: 'lantern-hooded', name: 'Lantern, Hooded', type: 'Adventuring Gear', rarity: 'common',
    description: 'Casts bright light in a 30-foot radius and dim light for an additional 30 feet. Once lit, it burns for 6 hours on a flask of oil. 2 lb. 5 gp.',
    rawJson: { weight: 2, costGp: 5, light: { bright: 30, dim: 60 } }},
  { slug: 'rations-1-day', name: 'Rations (1 day)', type: 'Adventuring Gear', rarity: 'common',
    description: 'Dry food suitable for extended travel. 2 lb. 5 sp.',
    rawJson: { weight: 2, costGp: 0.5 }},
  { slug: 'waterskin', name: 'Waterskin', type: 'Adventuring Gear', rarity: 'common',
    description: 'Holds 4 pints of liquid. 5 lb. (full). 2 sp.',
    rawJson: { weight: 5, costGp: 0.2 }},
  { slug: 'tinderbox', name: 'Tinderbox', type: 'Adventuring Gear', rarity: 'common',
    description: 'Using an action, you can light a small fire. 1 lb. 5 sp.',
    rawJson: { weight: 1, costGp: 0.5 }},
  { slug: 'thieves-tools', name: "Thieves' Tools", type: 'Adventuring Gear', rarity: 'common',
    description: 'A set of picks and tools for disarming traps and opening locks. 1 lb. 25 gp.',
    rawJson: { weight: 1, costGp: 25 }},
  { slug: 'healers-kit', name: "Healer's Kit", type: 'Adventuring Gear', rarity: 'common',
    description: '10 uses. As an action, stabilize a creature at 0 HP. 3 lb. 5 gp.',
    rawJson: { weight: 3, costGp: 5, uses: 10 }},
  { slug: 'potion-of-healing', name: 'Potion of Healing', type: 'Potion', rarity: 'common',
    description: 'You regain 2d4 + 2 hit points when you drink this potion. 1/2 lb. 50 gp.',
    rawJson: { weight: 0.5, costGp: 50, healing: '2d4+2' }},
  { slug: 'holy-water-flask', name: 'Holy Water (flask)', type: 'Adventuring Gear', rarity: 'common',
    description: 'As an action, splash against a creature within 5 feet or throw up to 20 feet. Fiends and undead take 2d6 radiant damage. 1 lb. 25 gp.',
    rawJson: { weight: 1, costGp: 25, damage: '2d6', damageType: 'radiant' }},
  { slug: 'grappling-hook', name: 'Grappling Hook', type: 'Adventuring Gear', rarity: 'common',
    description: '4 lb. 2 gp.', rawJson: { weight: 4, costGp: 2 }},
  { slug: 'crowbar', name: 'Crowbar', type: 'Adventuring Gear', rarity: 'common',
    description: 'Advantage on Strength checks where leverage can be applied. 5 lb. 2 gp.',
    rawJson: { weight: 5, costGp: 2 }},
  { slug: 'manacles', name: 'Manacles', type: 'Adventuring Gear', rarity: 'common',
    description: 'DC 20 Strength or Dexterity check to escape. DC 15 to pick the lock. 6 lb. 2 gp.',
    rawJson: { weight: 6, costGp: 2 }},
  { slug: 'caltrops-bag-of-20', name: 'Caltrops (bag of 20)', type: 'Adventuring Gear', rarity: 'common',
    description: 'Cover a 5-foot square area. DC 15 Dex save or stop moving and take 1 piercing damage. 2 lb. 1 gp.',
    rawJson: { weight: 2, costGp: 1 }},
  { slug: 'ball-bearings-bag-of-1000', name: 'Ball Bearings (bag of 1,000)', type: 'Adventuring Gear', rarity: 'common',
    description: 'Cover a 10-foot square area. DC 10 Dex save or fall prone. 2 lb. 1 gp.',
    rawJson: { weight: 2, costGp: 1 }},
  { slug: 'component-pouch', name: 'Component Pouch', type: 'Adventuring Gear', rarity: 'common',
    description: 'A small waterproof belt pouch with compartments for spell components. 2 lb. 25 gp.',
    rawJson: { weight: 2, costGp: 25 }},
  { slug: 'arcane-focus-wand', name: 'Arcane Focus (Wand)', type: 'Adventuring Gear', rarity: 'common',
    description: 'An arcane focus for casting spells. 1 lb. 10 gp.',
    rawJson: { weight: 1, costGp: 10 }},
  { slug: 'arcane-focus-staff', name: 'Arcane Focus (Staff)', type: 'Adventuring Gear', rarity: 'common',
    description: 'An arcane focus for casting spells. 4 lb. 5 gp.',
    rawJson: { weight: 4, costGp: 5 }},
  { slug: 'holy-symbol', name: 'Holy Symbol', type: 'Adventuring Gear', rarity: 'common',
    description: 'A divine focus for casting spells. 1 lb. 5 gp.',
    rawJson: { weight: 1, costGp: 5 }},
  { slug: 'arrows-20', name: 'Arrows (20)', type: 'Ammunition', rarity: 'common',
    description: '1 lb. 1 gp.', rawJson: { weight: 1, costGp: 1, quantity: 20 }},
  { slug: 'bolts-20', name: 'Bolts (20)', type: 'Ammunition', rarity: 'common',
    description: '1.5 lb. 1 gp.', rawJson: { weight: 1.5, costGp: 1, quantity: 20 }},
];

// --- Currency ---
const CURRENCY: EquipmentEntry[] = [
  { slug: 'copper-piece', name: 'Copper Piece (cp)', type: 'Currency', rarity: 'common',
    description: 'A standard copper coin. 1 cp. The most basic unit of currency.',
    rawJson: { currency: 'cp', valueInCp: 1, weight: 0.02 }},
  { slug: 'silver-piece', name: 'Silver Piece (sp)', type: 'Currency', rarity: 'common',
    description: 'A standard silver coin. 1 sp = 10 cp. Common currency for everyday trade.',
    rawJson: { currency: 'sp', valueInCp: 10, weight: 0.02 }},
  { slug: 'electrum-piece', name: 'Electrum Piece (ep)', type: 'Currency', rarity: 'common',
    description: 'An electrum coin (gold-silver alloy). 1 ep = 5 sp = 50 cp. Uncommon in most realms.',
    rawJson: { currency: 'ep', valueInCp: 50, weight: 0.02 }},
  { slug: 'gold-piece', name: 'Gold Piece (gp)', type: 'Currency', rarity: 'common',
    description: 'A standard gold coin. 1 gp = 10 sp = 100 cp. The baseline currency for adventurers.',
    rawJson: { currency: 'gp', valueInCp: 100, weight: 0.02 }},
  { slug: 'platinum-piece', name: 'Platinum Piece (pp)', type: 'Currency', rarity: 'common',
    description: 'A platinum coin. 1 pp = 10 gp = 1000 cp. Used for high-value transactions.',
    rawJson: { currency: 'pp', valueInCp: 1000, weight: 0.02 }},
];

// --- Gems & Trade Goods (common loot items) ---
const TREASURE: EquipmentEntry[] = [
  { slug: 'gem-10gp', name: 'Gem (10 gp)', type: 'Treasure', rarity: 'common',
    description: 'A semiprecious gemstone worth 10 gp. Examples: azurite, banded agate, blue quartz, eye agate, hematite, lapis lazuli, malachite, moss agate, obsidian, rhodochrosite, tiger eye, turquoise.',
    rawJson: { valueGp: 10, weight: 0 }},
  { slug: 'gem-50gp', name: 'Gem (50 gp)', type: 'Treasure', rarity: 'common',
    description: 'A semiprecious gemstone worth 50 gp. Examples: bloodstone, carnelian, chalcedony, chrysoprase, citrine, jasper, moonstone, onyx, quartz, sardonyx, star rose quartz, zircon.',
    rawJson: { valueGp: 50, weight: 0 }},
  { slug: 'gem-100gp', name: 'Gem (100 gp)', type: 'Treasure', rarity: 'uncommon',
    description: 'A precious gemstone worth 100 gp. Examples: amber, amethyst, chrysoberyl, coral, garnet, jade, jet, pearl, spinel, tourmaline.',
    rawJson: { valueGp: 100, weight: 0 }},
  { slug: 'gem-500gp', name: 'Gem (500 gp)', type: 'Treasure', rarity: 'rare',
    description: 'A rare gemstone worth 500 gp. Examples: alexandrite, aquamarine, black pearl, blue spinel, peridot, topaz.',
    rawJson: { valueGp: 500, weight: 0 }},
  { slug: 'gem-1000gp', name: 'Gem (1000 gp)', type: 'Treasure', rarity: 'very rare',
    description: 'A very rare gemstone worth 1000 gp. Examples: black opal, blue sapphire, emerald, fire opal, opal, star ruby, star sapphire, yellow sapphire.',
    rawJson: { valueGp: 1000, weight: 0 }},
  { slug: 'gem-5000gp', name: 'Gem (5000 gp)', type: 'Treasure', rarity: 'legendary',
    description: 'An exceptional gemstone worth 5000 gp. Examples: black sapphire, diamond, jacinth, ruby.',
    rawJson: { valueGp: 5000, weight: 0 }},
  { slug: 'art-object-25gp', name: 'Art Object (25 gp)', type: 'Treasure', rarity: 'common',
    description: 'A decorative art object worth 25 gp. Examples: silver ewer, carved bone statuette, small gold bracelet, cloth-of-gold vestments.',
    rawJson: { valueGp: 25, weight: 1 }},
  { slug: 'art-object-250gp', name: 'Art Object (250 gp)', type: 'Treasure', rarity: 'uncommon',
    description: 'A fine art object worth 250 gp. Examples: gold ring set with bloodstones, carved ivory statuette, gold and silver bracelet, silk robe with gold embroidery.',
    rawJson: { valueGp: 250, weight: 1 }},
  { slug: 'art-object-750gp', name: 'Art Object (750 gp)', type: 'Treasure', rarity: 'rare',
    description: 'A valuable art object worth 750 gp. Examples: silver chalice with moonstones, silver-plated steel longsword with jet set in hilt, gold music box.',
    rawJson: { valueGp: 750, weight: 2 }},
  { slug: 'art-object-2500gp', name: 'Art Object (2500 gp)', type: 'Treasure', rarity: 'very rare',
    description: 'A precious art object worth 2500 gp. Examples: fine gold chain with fire opal, old masterpiece painting, embroidered silk and velvet mantle with moonstones.',
    rawJson: { valueGp: 2500, weight: 2 }},
];

const ALL_EQUIPMENT: EquipmentEntry[] = [
  ...SIMPLE_MELEE,
  ...SIMPLE_RANGED,
  ...MARTIAL_MELEE,
  ...MARTIAL_RANGED,
  ...ARMOR,
  ...ADVENTURING_GEAR,
  ...CURRENCY,
  ...TREASURE,
];

export function seedEquipment(): void {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO compendium_items (slug, name, type, rarity, requires_attunement, description, source, raw_json)
    VALUES (?, ?, ?, ?, 0, ?, 'PHB Equipment', ?)
  `);

  const transaction = db.transaction(() => {
    for (const item of ALL_EQUIPMENT) {
      insertStmt.run(
        item.slug,
        item.name,
        item.type,
        item.rarity,
        item.description,
        JSON.stringify(item.rawJson),
      );
    }
  });

  transaction();
  console.log(`Seeded ${ALL_EQUIPMENT.length} PHB equipment items`);
}

export function isEquipmentSeeded(): boolean {
  const count = db.prepare(
    "SELECT COUNT(*) as cnt FROM compendium_items WHERE source = 'PHB Equipment'"
  ).get() as { cnt: number };
  return count.cnt >= ALL_EQUIPMENT.length;
}
