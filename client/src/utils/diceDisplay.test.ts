import { describe, expect, it } from 'vitest';
import {
  PERCENTILE_HELP_TEXT,
  formatDiceExpression,
  formatDieBadge,
  formatDieFace,
  hasPercentileDie,
} from './diceDisplay';

describe('dice display helpers', () => {
  it('formats the d100 zero face as 00', () => {
    expect(formatDieFace({ type: 100, value: 0 })).toBe('00');
    expect(formatDieFace({ type: 100, value: 100 })).toBe('00');
  });

  it('distinguishes percentile 10 from percentile 100', () => {
    const ten = [
      { type: 100, value: 10 },
      { type: 10, value: 0 },
    ];
    const hundred = [
      { type: 100, value: 100 },
      { type: 10, value: 0 },
    ];

    expect(formatDiceExpression(ten)).toBe('d% 10 + d10 0');
    expect(formatDiceExpression(hundred)).toBe('d% 00 + d10 0');
  });

  it('labels d10 as the ones die only inside a percentile roll', () => {
    const normalD10 = [{ type: 10, value: 0 }];
    const percentile = [
      { type: 100, value: 30 },
      { type: 10, value: 0 },
    ];

    expect(formatDieBadge(normalD10[0], normalD10)).toBe('0');
    expect(formatDieBadge(percentile[1], percentile)).toBe('d10 0');
  });

  it('has a concise user-facing help string', () => {
    expect(hasPercentileDie([{ type: 100, value: 90 }])).toBe(true);
    expect(PERCENTILE_HELP_TEXT).toContain('00 + 0 = 100');
  });
});
