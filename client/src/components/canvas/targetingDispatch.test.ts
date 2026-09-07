import { describe, expect, it, vi } from 'vitest';
import { registerTargetingResolver } from './targetingDispatch';

const click = (target: EventTarget) => target.dispatchEvent(new Event('target-token-selected'));

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('registerTargetingResolver', () => {
  it('attaches one listener and hands ownership to a remaining panel on cleanup', async () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const canvas = vi.fn();
    const hero = vi.fn();
    const unregisterCanvas = registerTargetingResolver(target, canvas);
    const unregisterHero = registerTargetingResolver(target, hero);

    expect(add).toHaveBeenCalledTimes(1);
    click(target);
    await settle();
    expect(canvas).toHaveBeenCalledTimes(1);
    expect(hero).not.toHaveBeenCalled();

    unregisterCanvas();
    click(target);
    await settle();
    expect(hero).toHaveBeenCalledTimes(1);
    unregisterHero();
    expect(remove).toHaveBeenCalledTimes(1);
    click(target);
    expect(hero).toHaveBeenCalledTimes(1);
  });

  it('keeps the flight locked across a complete effect teardown and remount', async () => {
    const target = new EventTarget();
    let finish!: () => void;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const unregisterFirst = registerTargetingResolver(target, first);
    click(target);
    unregisterFirst();

    const second = vi.fn();
    const unregisterSecond = registerTargetingResolver(target, second);
    click(target);
    expect(second).not.toHaveBeenCalled();

    finish();
    await settle();
    click(target);
    expect(second).toHaveBeenCalledTimes(1);
    unregisterSecond();
  });

  it('allows another selection after a no-op validation return', async () => {
    const target = new EventTarget();
    const resolve = vi.fn(async () => {});
    const unregister = registerTargetingResolver(target, resolve);
    click(target);
    await settle();
    click(target);
    expect(resolve).toHaveBeenCalledTimes(2);
    unregister();
  });

  it.each(['throw', 'reject'])('releases the lock after a resolver %s', async (failure) => {
    const target = new EventTarget();
    const error = new Error('Failed target lookup');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolve = vi.fn().mockImplementationOnce(() => {
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    const unregister = registerTargetingResolver(target, resolve);
    try {
      click(target);
      await settle();
      expect(report).toHaveBeenCalledWith('[Targeting] Failed to resolve target', error);
      click(target);
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
      report.mockRestore();
    }
  });
});
