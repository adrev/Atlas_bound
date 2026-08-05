import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dismissHandout,
  getHandoutQueue,
  pushHandout,
  resetHandoutQueueForTests,
  subscribeToHandoutQueue,
} from './handoutQueue';

const FIRST = { title: 'First', content: 'One', fromDM: true };
const SECOND = { title: 'Second', content: 'Two', fromDM: true };

beforeEach(() => {
  resetHandoutQueueForTests();
});

describe('handout queue', () => {
  it('preserves FIFO order and notifies subscribers for each change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToHandoutQueue(listener);

    pushHandout(FIRST);
    pushHandout(SECOND);
    expect(getHandoutQueue()).toEqual([FIRST, SECOND]);
    expect(listener).toHaveBeenCalledTimes(2);

    dismissHandout();
    expect(getHandoutQueue()).toEqual([SECOND]);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    dismissHandout();
    expect(getHandoutQueue()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not notify when dismissing an empty queue', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToHandoutQueue(listener);

    dismissHandout();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });
});
