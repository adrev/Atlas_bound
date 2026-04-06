import { rollDice, rollWithAdvantage } from '@dnd-vtt/shared';
import type { DiceRollData, RollResult } from '@dnd-vtt/shared';

export function roll(notation: string, reason?: string): DiceRollData {
  const result: RollResult = rollDice(notation);
  return {
    notation: result.notation,
    dice: result.dice,
    modifier: result.modifier,
    total: result.total,
    advantage: 'normal',
    reason,
  };
}

export function rollAdvantage(
  modifier: number,
  mode: 'advantage' | 'disadvantage',
  reason?: string,
): DiceRollData {
  const result = rollWithAdvantage(modifier, mode);
  return {
    notation: result.notation,
    dice: result.dice,
    modifier: result.modifier,
    total: result.total,
    advantage: mode,
    reason,
  };
}

export function rollInitiative(bonus: number): { roll: number; total: number } {
  const dieValue = Math.floor(Math.random() * 20) + 1;
  return {
    roll: dieValue,
    total: dieValue + bonus,
  };
}

export function rollDeathSave(): { roll: number; isSuccess: boolean; isCritSuccess: boolean; isCritFail: boolean } {
  const dieValue = Math.floor(Math.random() * 20) + 1;
  return {
    roll: dieValue,
    isSuccess: dieValue >= 10,
    isCritSuccess: dieValue === 20,
    isCritFail: dieValue === 1,
  };
}
