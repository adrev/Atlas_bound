/**
 * Calculate effective AC and combat bonuses from equipped inventory items.
 * Follows D&D 5e rules for armor, shields, and magic item bonuses.
 */

export interface EquippedItem {
  name: string;
  type: string;
  category?: string;
  equipped: boolean;
  damage?: string;
  damageType?: string;
  properties?: string[];
  rarity?: string;
  description?: string;
  acBonus?: number;
  slug?: string;
  // From rawJson enrichment
  ac?: number;
  acType?: string; // 'flat' | 'dex' | 'dex-max-2' or 'light' | 'medium' | 'heavy'
  magicBonus?: number;
  strengthRequirement?: number;
  strRequirement?: number;
}

export interface EquipmentAbilityScores {
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
}

export interface EquipmentBonuses {
  /** Total AC from equipped armor + shield + magic bonuses */
  effectiveAC: number;
  /** AC breakdown for tooltip */
  acBreakdown: string;
  /** Any magic bonus to all attack rolls (from equipped items) */
  attackBonus: number;
  /** Any magic bonus to all damage rolls */
  damageBonus: number;
  /** Whether the character has stealth disadvantage from armor */
  stealthDisadvantage: boolean;
  /** Speed penalty from heavy armor without STR requirement */
  speedPenalty: number;
}

type ArmorKind = 'light' | 'medium' | 'heavy';

interface ArmorRule {
  name: string;
  baseAC: number;
  kind: ArmorKind;
  stealthDisadvantage: boolean;
  strengthRequirement?: number;
}

const ARMOR_RULES: ArmorRule[] = [
  { name: 'studded leather', baseAC: 12, kind: 'light', stealthDisadvantage: false },
  { name: 'padded', baseAC: 11, kind: 'light', stealthDisadvantage: true },
  { name: 'leather', baseAC: 11, kind: 'light', stealthDisadvantage: false },
  { name: 'half plate', baseAC: 15, kind: 'medium', stealthDisadvantage: true },
  { name: 'chain shirt', baseAC: 13, kind: 'medium', stealthDisadvantage: false },
  { name: 'scale mail', baseAC: 14, kind: 'medium', stealthDisadvantage: true },
  { name: 'breastplate', baseAC: 14, kind: 'medium', stealthDisadvantage: false },
  { name: 'hide', baseAC: 12, kind: 'medium', stealthDisadvantage: false },
  { name: 'chain mail', baseAC: 16, kind: 'heavy', stealthDisadvantage: true, strengthRequirement: 13 },
  { name: 'ring mail', baseAC: 14, kind: 'heavy', stealthDisadvantage: true },
  { name: 'splint', baseAC: 17, kind: 'heavy', stealthDisadvantage: true, strengthRequirement: 15 },
  { name: 'plate', baseAC: 18, kind: 'heavy', stealthDisadvantage: true, strengthRequirement: 15 },
];

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function itemKind(item: EquippedItem): string {
  const type = lower(item.type);
  if (type === 'armor' || type === 'shield' || type === 'weapon') return type;
  return lower(item.category) || type;
}

function isShield(item: EquippedItem): boolean {
  const kind = itemKind(item);
  return kind === 'shield' || (kind === 'armor' && lower(item.name).includes('shield'));
}

function isArmor(item: EquippedItem): boolean {
  return itemKind(item) === 'armor' && !isShield(item);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (Number.isFinite(value) && value !== undefined && value > 0) return value;
  }
  return undefined;
}

function armorRuleFor(item: EquippedItem): ArmorRule | undefined {
  const name = lower(item.name);
  return ARMOR_RULES.find((rule) => name.includes(rule.name));
}

function armorKindFor(item: EquippedItem, rule?: ArmorRule): ArmorKind | null {
  const acType = lower(item.acType);
  if (acType === 'dex' || acType === 'light') return 'light';
  if (acType === 'dex-max-2' || acType === 'medium') return 'medium';
  if (acType === 'flat' || acType === 'heavy') return 'heavy';

  const desc = lower(item.description);
  if (desc.includes('light armor')) return 'light';
  if (desc.includes('medium armor')) return 'medium';
  if (desc.includes('heavy armor')) return 'heavy';
  return rule?.kind ?? null;
}

function parseMagicBonus(
  item: EquippedItem,
  mundaneBase?: number,
  structuredAC?: number,
): number {
  if (Number.isFinite(item.magicBonus) && item.magicBonus !== undefined && item.magicBonus > 0) {
    return item.magicBonus;
  }
  // Some imports store the final AC on magic armor/shields already
  // (e.g. +1 plate as AC 19). Do not parse the text bonus again.
  if (mundaneBase !== undefined && structuredAC !== undefined && structuredAC > mundaneBase) {
    return 0;
  }
  const text = `${item.name} ${item.description ?? ''}`;
  const explicit = text.match(/\+(\d)\s*bonus to (?:AC|armor class)/i);
  if (explicit) return parseInt(explicit[1], 10);
  const prefix = text.match(/(?:^|\s)\+(\d)\b/);
  return prefix ? parseInt(prefix[1], 10) : 0;
}

function hasStealthDisadvantage(item: EquippedItem, rule?: ArmorRule): boolean {
  if (rule?.stealthDisadvantage) return true;
  if (item.properties?.some((p) => lower(p).includes('stealth disadvantage'))) return true;
  const desc = lower(item.description);
  return desc.includes('stealth') && desc.includes('disadvantage');
}

function strengthRequirementFor(item: EquippedItem, rule?: ArmorRule): number {
  const explicit = firstNumber(item.strengthRequirement, item.strRequirement);
  if (explicit !== undefined) return explicit;
  const match = lower(item.description).match(/str(?:ength)?(?:\s+score)?\s*(?:of\s*)?(\d{2})/);
  if (match) return parseInt(match[1], 10);
  return rule?.strengthRequirement ?? 0;
}

export function calculateEquipmentBonuses(
  inventory: EquippedItem[],
  abilityScores: EquipmentAbilityScores,
  baseAC?: number, // Character's stored AC (from DDB import or manual)
): EquipmentBonuses {
  const dexMod = Math.floor((abilityScores.dex - 10) / 2);
  const equipped = inventory.filter(i => i.equipped);

  // Find equipped armor and shield
  const armor = equipped.find(isArmor);
  const shield = equipped.find(isShield);

  let ac = 10 + dexMod; // Default: unarmored
  let acBreakdown = `10 + ${dexMod} DEX`;
  let stealthDisadvantage = false;
  let speedPenalty = 0;

  if (armor) {
    const rule = armorRuleFor(armor);
    const structuredArmorAC = firstNumber(armor.acBonus, armor.ac);
    const armorAC = structuredArmorAC ?? rule?.baseAC ?? 0;
    const kind = armorKindFor(armor, rule);
    const magicArmorBonus = parseMagicBonus(armor, rule?.baseAC, structuredArmorAC);

    if (armorAC > 0) {
      // We have structured AC data
      if (kind === 'light') {
        // Light armor: base + full DEX
        ac = armorAC + dexMod + magicArmorBonus;
        acBreakdown = `${armorAC} + ${dexMod} DEX${magicArmorBonus ? ` + ${magicArmorBonus} magic` : ''}`;
      } else if (kind === 'medium') {
        // Medium armor: base + DEX (max 2)
        const cappedDex = Math.min(dexMod, 2);
        ac = armorAC + cappedDex + magicArmorBonus;
        acBreakdown = `${armorAC} + ${cappedDex} DEX (max 2)${magicArmorBonus ? ` + ${magicArmorBonus} magic` : ''}`;
      } else {
        // Heavy armor: flat AC
        ac = armorAC + magicArmorBonus;
        acBreakdown = `${armorAC}${magicArmorBonus ? ` + ${magicArmorBonus} magic` : ''}`;
      }
    } else {
      // No structured data — try to parse from description or use stored AC
      // Fall back to character's base AC if available
      if (baseAC && baseAC > 10) {
        ac = baseAC;
        acBreakdown = `${baseAC} (${armor.name})`;
      }
    }

    // Stealth disadvantage check
    stealthDisadvantage = hasStealthDisadvantage(armor, rule);

    if (kind === 'heavy') {
      const strengthRequirement = strengthRequirementFor(armor, rule);
      if (strengthRequirement > 0 && abilityScores.str < strengthRequirement) {
        speedPenalty = -10;
      }
    }
  }

  // Shield bonus
  if (shield) {
    const structuredShieldBonus = firstNumber(shield.acBonus, shield.ac);
    const shieldBonus = structuredShieldBonus ?? 2; // Default D&D shield is +2
    const magicShieldBonus = parseMagicBonus(shield, 2, structuredShieldBonus);

    ac += shieldBonus + magicShieldBonus;
    acBreakdown += ` + ${shieldBonus + magicShieldBonus} shield`;
  }

  // Natural-armor / class-feature fallback. Races like Tortle
  // ("Natural Armor 17", ignores DEX, can't wear body armor) and
  // class features like Unarmored Defense (Barbarian, Monk),
  // Draconic Resilience (Draconic Sorcerer), Barkskin, and Mage
  // Armor give a higher baseline than 10+DEX, but aren't modeled
  // as "armor" rows in inventory. The character's stored
  // `armorClass` field (from DDB import or manual entry) already
  // bakes them in — trust it as a floor whenever it exceeds what
  // we computed from the equipment path. This includes any shield
  // bonus DDB might have folded in, so we take max here instead of
  // stacking shield a second time. Matches the user-facing rule:
  // "if DDB says 19 and we computed 14, the character is 19."
  if (baseAC && baseAC > ac) {
    ac = baseAC;
    acBreakdown = `${baseAC} (natural / class feature)`;
  }

  // Global attack/damage bonuses from equipped magic items (rings, amulets, etc.)
  let attackBonus = 0;
  let damageBonus = 0;

  for (const item of equipped) {
    if (isArmor(item) || isShield(item)) continue; // Armor bonuses handled above
    const desc = (item.description || '').toLowerCase();

    // +X to attack and damage (weapon bonuses handled separately in TokenActionPanel)
    if (item.type !== 'weapon') {
      const atkMatch = desc.match(/\+(\d)\s*bonus to (?:attack|spell attack)/i);
      if (atkMatch) attackBonus += parseInt(atkMatch[1], 10);

      const dmgMatch = desc.match(/\+(\d)\s*bonus to (?:damage|spell damage)/i);
      if (dmgMatch) damageBonus += parseInt(dmgMatch[1], 10);
    }
  }

  return {
    effectiveAC: ac,
    acBreakdown,
    attackBonus,
    damageBonus,
    stealthDisadvantage,
    speedPenalty,
  };
}
