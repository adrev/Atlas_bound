export interface ParsedDice {
  count: number;
  sides: number;
}

export interface ParsedRoll {
  dice: ParsedDice[];
  modifier: number;
}

export interface RollResult {
  dice: { type: number; value: number }[];
  modifier: number;
  total: number;
  notation: string;
}

/**
 * Parse dice notation like "2d6+3", "1d20-1", "4d8+2d6+5"
 */
export function parseDiceNotation(notation: string): ParsedRoll {
  const cleaned = notation.replace(/\s/g, '').toLowerCase();
  const dice: ParsedDice[] = [];
  let modifier = 0;

  const parts = cleaned.match(/[+-]?[^+-]+/g);
  if (!parts) throw new Error(`Invalid dice notation: ${notation}`);

  for (const part of parts) {
    const diceMatch = part.match(/^([+-]?)(\d+)d(\d+)$/);
    if (diceMatch) {
      const sign = diceMatch[1] === '-' ? -1 : 1;
      const count = parseInt(diceMatch[2]) * sign;
      const sides = parseInt(diceMatch[3]);
      if (sides < 1 || Math.abs(count) > 100) throw new Error(`Invalid dice: ${part}`);
      dice.push({ count, sides });
    } else {
      const num = parseInt(part);
      if (isNaN(num)) throw new Error(`Invalid part: ${part}`);
      modifier += num;
    }
  }

  if (dice.length === 0) throw new Error('No dice found in notation');
  return { dice, modifier };
}

/**
 * Roll dice and return the result
 */
export function rollDice(notation: string): RollResult {
  const parsed = parseDiceNotation(notation);
  const results: { type: number; value: number }[] = [];
  let total = parsed.modifier;

  for (const d of parsed.dice) {
    const count = Math.abs(d.count);
    const sign = d.count < 0 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const value = Math.floor(Math.random() * d.sides) + 1;
      results.push({ type: d.sides, value });
      total += value * sign;
    }
  }

  return {
    dice: results,
    modifier: parsed.modifier,
    total,
    notation,
  };
}

/**
 * Roll with advantage (roll 2d20, take highest) or disadvantage (take lowest)
 */
export function rollWithAdvantage(
  modifier: number,
  mode: 'advantage' | 'disadvantage'
): RollResult {
  const roll1 = Math.floor(Math.random() * 20) + 1;
  const roll2 = Math.floor(Math.random() * 20) + 1;
  const chosen = mode === 'advantage' ? Math.max(roll1, roll2) : Math.min(roll1, roll2);

  return {
    dice: [
      { type: 20, value: roll1 },
      { type: 20, value: roll2 },
    ],
    modifier,
    total: chosen + modifier,
    notation: `2d20${modifier >= 0 ? '+' : ''}${modifier} (${mode})`,
  };
}
