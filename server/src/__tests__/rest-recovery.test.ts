import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { computeRest, computeSpendHitDie, persistRestUpdates } from '../services/RestService.js';

describe('2014 rest recovery', () => {
  it.each([[1, 1], [3, 1], [5, 2], [6, 3]])(
    'recovers %i total Hit Dice with a recovery budget of %i',
    (total, recovered) => {
      const result = computeRest({
        id: 'pc', hit_dice: [{ dieSize: 8, total, used: total }],
      }, 'long');
      expect(result.updates.hitDice).toEqual([{ dieSize: 8, total, used: total - recovered }]);
    },
  );

  it('does not use a long rest to recharge dawn-only or manual features', () => {
    const dawn = { name: 'Dawn Charge', usesTotal: 3, usesRemaining: 0, resetOn: 'dawn' };
    const manual = { name: 'Manual Charge', usesTotal: 1, usesRemaining: 0, resetOn: null };
    const unspecified = { name: 'Unknown Recharge', usesTotal: 1, usesRemaining: 0 };
    const short = { name: 'Ki', usesTotal: 5, usesRemaining: 1, resetOn: 'short' };
    const long = { name: 'Font of Magic', usesTotal: 5, usesRemaining: 1, resetOn: 'long' };
    expect(computeRest({ id: 'pc', features: [dawn, manual, unspecified, short, long] }, 'long').updates.features)
      .toEqual([dawn, manual, unspecified, { ...short, usesRemaining: 5 }, { ...long, usesRemaining: 5 }]);
  });

  it('spends a Hit Die but grants zero HP when the roll plus Constitution is negative', () => {
    const result = computeSpendHitDie({
      id: 'pc', hit_points: 3, max_hit_points: 10, ability_scores: { con: 6 },
      hit_dice: [{ dieSize: 6, total: 2, used: 0 }],
    }, 6, 1);
    expect(result.heal).toBe(0);
    expect(result.updates).toEqual({ hitPoints: 3, hitDice: [{ dieSize: 6, total: 2, used: 1 }] });
  });
});

describe('recovery persistence', () => {
  it('rejects a stale snapshot after another action has spent a feature charge', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;
    await expect(persistRestUpdates(client, 'pc', { features: [] }, 7)).rejects.toThrow('Character changed');
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE id = \$2 AND version = \$3 RETURNING version/),
      ['[]', 'pc', 7],
    );
  });

  it.each([null, undefined, 0, -1, 2.5, '7'])('refuses writes without a valid version: %s', async (version) => {
    const query = vi.fn();
    await expect(persistRestUpdates({ query } as unknown as PoolClient, 'pc', { hitPoints: 20 }, version))
      .rejects.toThrow('version is unavailable');
    expect(query).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, 6, 7])('requires confirmation of a newer stored version: %s', async (version) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version }] });
    await expect(persistRestUpdates({ query } as unknown as PoolClient, 'pc', { hitPoints: 20 }, 7))
      .rejects.toThrow('Could not confirm recovery');
  });
});
