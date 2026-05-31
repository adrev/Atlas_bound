export interface DamageResult {
  /** Final amount applied to HP. */
  amount: number;
  /** Multiplier vs the input amount: 0 immune, 0.5 resistant, 1 normal, 2 vulnerable. */
  multiplier: number;
  /** Human-readable label for chat output. */
  source: string;
}

export interface DefenseLists {
  resistances: string[];
  immunities: string[];
  vulnerabilities: string[];
}

/**
 * Weapon material markers that matter for resistance-bypass rules.
 * Werewolves and lycanthropes resist non-magical non-silvered weapon damage;
 * golems and many constructs resist non-magical non-adamantine weapon damage.
 */
export type WeaponMaterial = 'silvered' | 'adamantine' | 'cold-iron' | null;

/**
 * True when a resistance or immunity string should be skipped because the
 * attack satisfies an exemption qualifier inside the string itself.
 */
function resistanceExempted(
  entry: string,
  isMagical: boolean,
  material: WeaponMaterial,
): boolean {
  const e = entry.toLowerCase();
  if (/\bnon[\s-]?magical\b/.test(e)) {
    if (isMagical) return true;
    if (material === 'silvered' && /aren'?t\s+silvered|except\s+silvered/.test(e)) return true;
    if (material === 'adamantine' && /aren'?t\s+adamantine|except\s+adamantine/.test(e)) return true;
    if (material === 'cold-iron' && /aren'?t\s+cold[\s-]?iron|except\s+cold[\s-]?iron/.test(e)) return true;
  }
  return false;
}

function normalizeDefenseList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
}

/**
 * Apply resistance, immunity, and vulnerability to a damage amount.
 *
 * Looks at character defenses and active conditions such as petrified,
 * stoneskin, raging, and bear-raging. Spell damage should pass
 * `isMagical=true`; weapon damage can pass material metadata.
 */
export function applyDamageWithResist(
  baseAmount: number,
  damageType: string,
  defenses: Partial<DefenseLists> | undefined,
  conditions: string[],
  isMagical: boolean = true,
  material: WeaponMaterial = null,
): DamageResult {
  const dt = (damageType || '').toLowerCase();
  const set = new Set(conditions.map((c) => c.toLowerCase()));
  const sourceParts: string[] = [];
  let hasResistance = false;
  let hasVulnerability = false;
  const defenseRecord = defenses as Record<string, unknown> | undefined;

  const lists: DefenseLists = {
    resistances: normalizeDefenseList(defenseRecord?.resistances),
    immunities: normalizeDefenseList(defenseRecord?.immunities),
    vulnerabilities: normalizeDefenseList(defenseRecord?.vulnerabilities),
  };

  if (dt && lists.immunities.some((d) => d.includes(dt) && !resistanceExempted(d, isMagical, material))) {
    return {
      amount: 0,
      multiplier: 0,
      source: `immune to ${dt}`,
    };
  }
  if (dt && lists.resistances.some((d) => d.includes(dt) && !resistanceExempted(d, isMagical, material))) {
    hasResistance = true;
    sourceParts.push(`resist ${dt}`);
  }
  if (dt && lists.vulnerabilities.some((d) => d.includes(dt))) {
    hasVulnerability = true;
    sourceParts.push(`vulnerable to ${dt}`);
  }

  if (set.has('petrified')) {
    hasResistance = true;
    sourceParts.push('Petrified (resist all)');
  }

  if (set.has('stoneskin') && !isMagical) {
    if (dt === 'bludgeoning' || dt === 'piercing' || dt === 'slashing') {
      hasResistance = true;
      sourceParts.push(`Stoneskin (resist ${dt})`);
    }
  }

  if (set.has('raging')) {
    if (dt === 'bludgeoning' || dt === 'piercing' || dt === 'slashing') {
      hasResistance = true;
      sourceParts.push(`Rage (resist ${dt})`);
    }
  }

  if (set.has('bear-raging') && set.has('raging')) {
    if (dt !== 'psychic' && dt !== '') {
      hasResistance = true;
      sourceParts.push(`Bear Totem (resist ${dt})`);
    }
  }

  const multiplier = (hasResistance ? 0.5 : 1) * (hasVulnerability ? 2 : 1);

  return {
    amount: Math.floor(baseAmount * multiplier),
    multiplier,
    source: sourceParts.length > 0 ? sourceParts.join(', ') : '',
  };
}
