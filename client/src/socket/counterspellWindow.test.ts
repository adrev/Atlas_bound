/**
 * Counterspell resolver window (audit #6).
 *
 * The caster broadcasts a cast and awaits a counter. A counter reaches
 * the caster as a `spell-counterspelled` window event (the socket
 * listener dispatches it on receipt of the server relay). The resolver
 * must resolve true only for a matching castId, and time out after the
 * FULL shared window — the old bug was a 1400ms wait while the
 * counterer's prompt gave them 8s, so real counters never landed.
 *
 * The suite runs in Node (no jsdom), so `window` is shimmed with an
 * EventTarget — enough for add/remove/dispatchEvent, which is all the
 * resolver touches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { emitSpellCastAttempt } = vi.hoisted(() => ({ emitSpellCastAttempt: vi.fn() }));
vi.mock('./emitters', () => ({ emitSpellCastAttempt }));

import { broadcastCastAndAwaitCounterspell, COUNTERSPELL_WINDOW_MS } from './counterspellWindow';

const castArgs = {
  casterTokenId: 't1',
  casterName: 'Wizard',
  spellName: 'Fireball',
  spellLevel: 3,
};

function fireCounter(castId?: string) {
  (globalThis as { window: EventTarget }).window.dispatchEvent(
    new CustomEvent('spell-counterspelled', { detail: { castId } })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  emitSpellCastAttempt.mockReset();
  (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: EventTarget }).window;
});

describe('broadcastCastAndAwaitCounterspell', () => {
  it('broadcasts the cast attempt with a castId', async () => {
    const p = broadcastCastAndAwaitCounterspell(castArgs);
    expect(emitSpellCastAttempt).toHaveBeenCalledTimes(1);
    const arg = emitSpellCastAttempt.mock.calls[0][0];
    expect(arg.castId).toBeTruthy();
    expect(arg.spellName).toBe('Fireball');
    fireCounter(arg.castId); // resolve to avoid a dangling promise
    await p;
  });

  it('resolves TRUE when a counter with the matching castId arrives inside the window', async () => {
    const p = broadcastCastAndAwaitCounterspell(castArgs);
    const castId = emitSpellCastAttempt.mock.calls[0][0].castId;
    // Counterer reacts at a human pace — 3s — which the old 1400ms missed.
    vi.advanceTimersByTime(3000);
    fireCounter(castId);
    await expect(p).resolves.toBe(true);
  });

  it('resolves FALSE after the full window with no counter', async () => {
    const p = broadcastCastAndAwaitCounterspell(castArgs);
    vi.advanceTimersByTime(COUNTERSPELL_WINDOW_MS + 10);
    await expect(p).resolves.toBe(false);
  });

  it('ignores a counter for a DIFFERENT cast in flight', async () => {
    const p = broadcastCastAndAwaitCounterspell(castArgs);
    fireCounter('some-other-castId'); // not ours
    vi.advanceTimersByTime(COUNTERSPELL_WINDOW_MS + 10);
    await expect(p).resolves.toBe(false); // timed out, not countered
  });

  it('short-circuits cantrips without waiting', async () => {
    await expect(broadcastCastAndAwaitCounterspell({ ...castArgs, spellLevel: 0 })).resolves.toBe(
      false
    );
    expect(emitSpellCastAttempt).not.toHaveBeenCalled();
  });

  it('the shared window is long enough for a human reaction (>= 5s)', () => {
    expect(COUNTERSPELL_WINDOW_MS).toBeGreaterThanOrEqual(5000);
  });
});
