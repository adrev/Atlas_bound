import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  captureFeaturePointPools,
  characterFeatures,
  hydrateFeaturePointPools,
  loadFeatureRuntime,
  runWithFeatureRuntime,
  saveFeatureRuntime,
  sessionFeatures,
  type FeatureQuery,
} from '../utils/featureRuntime.js';

function database() {
  const sessions = new Map<string, unknown>();
  const characters = new Map<string, unknown>();
  const query = vi.fn<FeatureQuery>(async (sql, values = []) => {
    const store = sql.includes('session_feature_runtime') ? sessions : characters;
    const id = String(values[0]);
    if (sql.startsWith('INSERT')) {
      if (!store.has(id)) store.set(id, { version: 1, namespaces: {} });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT')) {
      return { rows: [{ state: structuredClone(store.get(id)) }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE')) {
      if (!isDeepStrictEqual(store.get(id), JSON.parse(String(values[2])))) {
        return { rows: [], rowCount: 0 };
      }
      store.set(id, JSON.parse(String(values[1])));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, sessions, characters };
}

describe('durable feature runtime', () => {
  it('loads and locks each character once in sorted order', async () => {
    const db = database();
    await loadFeatureRuntime(db.query, 'session', ['z', 'a', 'z']);
    expect(
      db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT')).map(([, values]) => values)
    ).toEqual([['session'], ['a'], ['z']]);
    expect(
      db.query.mock.calls
        .filter(([sql]) => sql.startsWith('SELECT'))
        .every(([sql]) => sql.endsWith('FOR UPDATE'))
    ).toBe(true);
  });

  it('round-trips every namespace including exhausted pools and empty Portent dice', async () => {
    const db = database();
    const first = await loadFeatureRuntime(db.query, 's1', ['c1']);
    await runWithFeatureRuntime(first, async () => {
      Object.assign(characterFeatures('c1'), {
        xp: 12050,
        wildShape: { beastName: 'Wolf', beastHp: 1, beastMax: 11, beastAc: null, beastSpeed: 40 },
        arcaneWard: { current: 0, max: 15 },
        portentDice: [],
        luckPoints: 0,
        enduranceUsed: true,
        indomitableUsed: 3,
        pointPools: { ki: { max: 4, remaining: 0 } },
      });
      Object.assign(sessionFeatures('s1'), {
        underwater: false,
        mountLinks: { rider: { mountTokenId: 'horse', controlled: false } },
        echoPositions: { c1: { x: 0, y: -2 } },
        unleashUsed: { c1: 'combat_3' },
        colossusUsed: { c1: 'combat_3_1' },
        grimHarvestUsed: { c1: 'combat_3_1' },
        divineFuryUsed: { c1: 'combat_3_1' },
      });
      await saveFeatureRuntime(db.query, first);
    });
    const second = await loadFeatureRuntime(db.query, 's1', ['c1']);
    expect(second.characters.get('c1')?.value).toEqual(first.characters.get('c1')?.value);
    expect(second.session.value).toEqual(first.session.value);
    expect(second.characters.get('c1')?.value).not.toBe(first.characters.get('c1')?.value);
    db.query.mockClear();
    await saveFeatureRuntime(db.query, second);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('keeps character totals authoritative across sessions but session state separate', async () => {
    const db = database();
    const a = await loadFeatureRuntime(db.query, 'a', ['c']);
    runWithFeatureRuntime(a, () => {
      characterFeatures('c').xp = 20;
      characterFeatures('c').luckPoints = 1;
      sessionFeatures('a').underwater = true;
    });
    await saveFeatureRuntime(db.query, a);
    const b = await loadFeatureRuntime(db.query, 'b', ['c']);
    runWithFeatureRuntime(b, () => {
      expect(characterFeatures('c').xp).toBe(20);
      expect(characterFeatures('c').luckPoints).toBe(1);
      expect(sessionFeatures('b').underwater).toBeUndefined();
      characterFeatures('c').xp! += 5;
      characterFeatures('c').luckPoints = 0;
    });
    await saveFeatureRuntime(db.query, b);
    const rejoined = await loadFeatureRuntime(db.query, 'a', ['c']);
    runWithFeatureRuntime(rejoined, () => {
      expect(characterFeatures('c').xp).toBe(25);
      expect(characterFeatures('c').luckPoints).toBe(0);
      expect(sessionFeatures('a').underwater).toBe(true);
    });
  });

  it('does not cache unsaved mutations or resurrect deleted values', async () => {
    const db = database();
    const first = await loadFeatureRuntime(db.query, 's', ['c']);
    runWithFeatureRuntime(first, () => {
      characterFeatures('c').portentDice = [4, 19];
    });
    await saveFeatureRuntime(db.query, first);
    runWithFeatureRuntime(first, () => {
      characterFeatures('c').portentDice!.splice(0, 1);
    });
    const afterRollback = await loadFeatureRuntime(db.query, 's', ['c']);
    runWithFeatureRuntime(afterRollback, () => {
      expect(characterFeatures('c').portentDice).toEqual([4, 19]);
      delete characterFeatures('c').portentDice;
    });
    await saveFeatureRuntime(db.query, afterRollback);
    const afterDelete = await loadFeatureRuntime(db.query, 's', ['c']);
    runWithFeatureRuntime(afterDelete, () => {
      expect(characterFeatures('c').portentDice).toBeUndefined();
    });
  });

  it('rejects access without a scope and isolates overlapping async scopes', async () => {
    expect(() => characterFeatures('c')).toThrow(/transaction scope/);
    expect(() => sessionFeatures('s')).toThrow(/transaction scope/);
    const db = database();
    const a = await loadFeatureRuntime(db.query, 'a', ['one']);
    const b = await loadFeatureRuntime(db.query, 'b', ['two']);
    await Promise.all([
      runWithFeatureRuntime(a, async () => {
        characterFeatures('one').xp = 12;
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(characterFeatures('one').xp).toBe(12);
        expect(() => characterFeatures('two')).toThrow(/not loaded/);
        expect(() => sessionFeatures('b')).toThrow(/scope mismatch/);
      }),
      runWithFeatureRuntime(b, async () => {
        await Promise.resolve();
        characterFeatures('two').xp = 99;
        expect(() => characterFeatures('one')).toThrow(/not loaded/);
      }),
    ]);
    expect(() => characterFeatures('one')).toThrow(/transaction scope/);
  });

  it.each([
    { version: 2, namespaces: {} },
    { version: 1, namespaces: { luckPoints: -1 } },
    { version: 1, namespaces: { xp: '500' } },
    { version: 1, namespaces: { unknownFeature: 3 } },
    null,
  ])('fails closed on malformed/unsupported durable character data: %j', async (state) => {
    const db = database();
    db.characters.set('c', state);
    await expect(loadFeatureRuntime(db.query, 's', ['c'])).rejects.toThrow();
    expect(db.characters.get('c')).toEqual(state);
  });

  it('validates the full write set and propagates failed/stale writes', async () => {
    const db = database();
    const runtime = await loadFeatureRuntime(db.query, 's', ['c']);
    runWithFeatureRuntime(runtime, () => {
      sessionFeatures('s').underwater = true;
      characterFeatures('c').xp = Number.NaN;
    });
    db.query.mockClear();
    await expect(saveFeatureRuntime(db.query, runtime)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
    runWithFeatureRuntime(runtime, () => {
      characterFeatures('c').xp = 2;
    });
    const failed = vi.fn<FeatureQuery>().mockRejectedValue(new Error('database unavailable'));
    await expect(saveFeatureRuntime(failed, runtime)).rejects.toThrow('database unavailable');
    const stale = vi.fn<FeatureQuery>().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(saveFeatureRuntime(stale, runtime)).rejects.toThrow('Stale session');
  });

  it('rejects a stale character writer rather than overwriting another session', async () => {
    const db = database();
    const first = await loadFeatureRuntime(db.query, 'a', ['c']);
    const stale = await loadFeatureRuntime(db.query, 'b', ['c']);
    runWithFeatureRuntime(first, () => {
      characterFeatures('c').xp = 1;
    });
    await saveFeatureRuntime(db.query, first);
    runWithFeatureRuntime(stale, () => {
      characterFeatures('c').xp = 2;
    });
    await expect(saveFeatureRuntime(db.query, stale)).rejects.toThrow('Stale character');
    expect(db.characters.get('c')).toEqual({ version: 1, namespaces: { xp: 1 } });
  });

  it('transfers point pools with detached values and preserves removal/exhaustion', async () => {
    const db = database();
    const first = await loadFeatureRuntime(db.query, 's', ['c']);
    runWithFeatureRuntime(first, () => {
      characterFeatures('c').pointPools = { ki: { max: 3, remaining: 1 } };
    });
    const pools = hydrateFeaturePointPools(first);
    pools.get('c')!.get('ki')!.remaining = 0;
    runWithFeatureRuntime(first, () => {
      expect(characterFeatures('c').pointPools!.ki.remaining).toBe(1);
    });
    captureFeaturePointPools(first, pools);
    await saveFeatureRuntime(db.query, first);
    const otherSession = await loadFeatureRuntime(db.query, 'other', ['c']);
    expect(hydrateFeaturePointPools(otherSession).get('c')!.get('ki')!.remaining).toBe(0);
    expect(() => captureFeaturePointPools(otherSession, new Map([['missing', new Map()]]))).toThrow(
      /not loaded/
    );
    captureFeaturePointPools(otherSession, new Map());
    await saveFeatureRuntime(db.query, otherSession);
    const final = await loadFeatureRuntime(db.query, 's', ['c']);
    expect(hydrateFeaturePointPools(final).has('c')).toBe(false);
  });

  it('persists superiority die size as well as the spent count', async () => {
    const db = database();
    const first = await loadFeatureRuntime(db.query, 's', ['c']);
    const pools = hydrateFeaturePointPools(first);
    pools.set('c', new Map([['superiority', { max: 5, remaining: 0, die: 10 }]]));
    captureFeaturePointPools(first, pools);
    await saveFeatureRuntime(db.query, first);
    const restored = await loadFeatureRuntime(db.query, 'other-session', ['c']);
    expect(hydrateFeaturePointPools(restored).get('c')!.get('superiority')).toEqual({
      max: 5,
      remaining: 0,
      die: 10,
    });
  });

  it('hydrates the same serialized state in a fresh Node process without refilling', () => {
    const state = {
      version: 1,
      namespaces: {
        xp: 0,
        luckPoints: 0,
        portentDice: [],
        arcaneWard: { current: 0, max: 14 },
        wildShape: { beastName: 'Bear', beastHp: 1, beastMax: 30, beastAc: 12, beastSpeed: null },
        enduranceUsed: true,
        indomitableUsed: 2,
        pointPools: {
          sorcery: { max: 3, remaining: 0 },
          superiority: { max: 5, remaining: 0, die: 10 },
        },
      },
    };
    const moduleUrl = new URL('../utils/featureRuntime.ts', import.meta.url).href;
    const script = `
      import { loadFeatureRuntime, runWithFeatureRuntime, characterFeatures } from ${JSON.stringify(moduleUrl)};
      const state = JSON.parse(process.argv[1]);
      const query = async (sql) => ({ rows: sql.startsWith('SELECT')
        ? [{ state: sql.includes('character_feature_runtime') ? state : {version:1,namespaces:{}} }] : [] });
      const runtime = await loadFeatureRuntime(query, 's', ['c']);
      runWithFeatureRuntime(runtime, () => process.stdout.write(JSON.stringify(characterFeatures('c'))));
    `;
    const fresh = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(state)],
      { encoding: 'utf8' }
    );
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout)).toEqual(state.namespaces);
  });
});
