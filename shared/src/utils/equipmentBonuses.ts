/**
 * Calculate effective AC and combat bonuses from equipped inventory items.
 * Follows D&D 5e rules for armor, shields, and magic item bonuses.
 */

interface EquippedItem {
  name: string;
  type: string;
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
  acType?: string; // 'flat' | 'dex' | 'dex-max-2'
}

interface AbilityScores {
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
}

interface EquipmentBonuses {
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

export function calculateEquipmentBonuses(
  inventory: EquippedItem[],
  abilityScores: AbilityScores,
  baseAC?: number, // Character's stored AC (from DDB import or manual)
): EquipmentBonuses {
  const dexMod = Math.floor((abilityScores.dex - 10) / 2);
  const equipped = inventory.filter(i => i.equipped);

  // Find equipped armor and shield
  const armor = equipped.find(i =>
    i.type === 'armor' && !i.name.toLowerCase().includes('shield')
  );
  const shield = equipped.find(i =>
    i.type === 'armor' && i.name.toLowerCase().includes('shield')
    || i.type === 'shield'
  );

  let ac = 10 + dexMod; // Default: unarmored
  let acBreakdown = `10 + ${dexMod} DEX`;
  let stealthDisadvantage = false;
  let speedPenalty = 0;

  if (armor) {
    const armorAC = armor.acBonus || armor.ac || 0;
    const acType = armor.acType || '';
    const desc = (armor.description || '').toLowerCase();

    // Parse magic armor bonus from description
    let magicArmorBonus = 0;
    const magicMatch = (armor.description || '').match(/\+(\d)\s*bonus to (?:AC|armor class)/i);
    if (magicMatch) magicArmorBonus = parseInt(magicMatch[1], 10);

    if (armorAC > 0) {
      // We have structured AC data
      if (acType === 'dex' || desc.includes('light armor') || armor.type?.toLowerCase().includes('light')) {
        // Light armor: base + full DEX
        ac = armorAC + dexMod + magicArmorBonus;
        acBreakdown = `${armorAC} + ${dexMod} DEX${magicArmorBonus ? ` + ${magicArmorBonus} magic` : ''}`;
      } else if (acType === 'dex-max-2' || desc.includes('medium armor') || armor.type?.toLowerCase().includes('medium')) {
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
    if (desc.includes('stealth') && desc.includes('disadvantage')) {
      stealthDisadvantage = true;
    }
  }

  // Shield bonus
  if (shield) {
    const shieldBonus = shield.acBonus || 2; // Default D&D shield is +2
    let magicShieldBonus = 0;
    const shieldMagicMatch = (shield.description || '').match(/\+(\d)\s*bonus to (?:AC|armor class)/i);
    if (shieldMagicMatch) magicShieldBonus = parseInt(shieldMagicMatch[1], 10);

    ac += shieldBonus + magicShieldBonus;
    acBreakdown += ` + ${shieldBonus + magicShieldBonus} shield`;
  }

  // Global attack/damage bonuses from equipped magic items (rings, amulets, etc.)
  let attackBonus = 0;
  let damageBonus = 0;

  for (const item of equipped) {
    if (item.type === 'armor') continue; // Armor bonuses handled above
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
