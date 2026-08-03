export interface DisplayDie {
  type: number;
  value: number;
}

export const PERCENTILE_HELP_TEXT = 'Percentile: 00 + 0 = 100; 10 + 0 = 10.';

export function hasPercentileDie(dice: DisplayDie[]): boolean {
  return dice.some((d) => d.type === 100);
}

export function formatDieFace(die: DisplayDie): string {
  if (die.type !== 100) return String(die.value);
  if (die.value === 0 || die.value === 100) return '00';
  if (die.value > 0 && die.value < 100) return String(die.value).padStart(2, '0');
  return String(die.value);
}

export function formatDieBadge(die: DisplayDie, context: DisplayDie[]): string {
  if (die.type === 100) return `d% ${formatDieFace(die)}`;
  if (hasPercentileDie(context) && die.type === 10) return `d10 ${die.value}`;
  return formatDieFace(die);
}

export function formatDiceExpression(dice: DisplayDie[]): string {
  const percentile = hasPercentileDie(dice);
  return dice
    .map((d) => {
      if (d.type === 100) return `d% ${formatDieFace(d)}`;
      if (percentile && d.type === 10) return `d10 ${d.value}`;
      return formatDieFace(d);
    })
    .join(' + ');
}
