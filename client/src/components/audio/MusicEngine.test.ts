import { act, createContext, createElement, StrictMode, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority } from 'react-reconciler/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicEngine } from './MusicEngine';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAudioStore } from '../../stores/useAudioStore';

vi.mock('./tracks', () => ({
  TRACKS: [
    { id: 'A', files: ['A0', 'A1', 'A2'] },
    { id: 'B', files: ['B0', 'B1', 'B2'] },
  ],
}));

// Same no-op host renderer as the mounted targeting tests: real React effects,
// subscriptions and cleanup, with only browser audio and timers controlled.
const noop = () => {};
const hostContext = {};
let updatePriority = DefaultEventPriority;
const renderer = Reconciler({
  supportsMutation: true,
  isPrimaryRenderer: false,
  getRootHostContext: () => hostContext,
  getChildHostContext: () => hostContext,
  getPublicInstance: (instance: unknown) => instance,
  createInstance: () => ({}),
  createTextInstance: () => ({}),
  appendInitialChild: noop,
  appendChild: noop,
  appendChildToContainer: noop,
  insertBefore: noop,
  insertInContainerBefore: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  clearContainer: noop,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  commitUpdate: noop,
  commitTextUpdate: noop,
  detachDeletedInstance: noop,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  setCurrentUpdatePriority: (priority: number) => {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () => updatePriority || DefaultEventPriority,
  shouldAttemptEagerTransition: () => false,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),
  resetFormInstance: noop,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
} as any);

let blocked: boolean;
let audios: MockAudio[];
class MockAudio extends EventTarget {
  private source = '';
  sourceAssignments: string[] = [];
  volume = 1;
  paused = true;
  currentTime = 0;
  duration = 120;
  loop = false;
  constructor() {
    super();
    audios.push(this);
  }
  get src() {
    return this.source;
  }
  set src(url: string) {
    this.source = url;
    this.sourceAssignments.push(url);
    this.currentTime = 0;
    this.paused = true;
  }
  play = vi.fn(() => {
    if (blocked) return Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

let root: ReturnType<typeof renderer.createContainer>;
let errors: unknown[];
let events: EventTarget;
let gestures: EventTarget;

async function render(node: ReactNode) {
  await act(async () => {
    renderer.updateContainer(node, root, null, noop);
  });
  expect(errors).toEqual([]);
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function action(detail: string) {
  await act(async () => {
    events.dispatchEvent(new CustomEvent('music-action', { detail }));
  });
}
async function mute(value: boolean) {
  await act(async () => {
    useAudioStore.setState({ musicMuted: value });
  });
}
async function changeTrack(track: string | null) {
  await act(async () => {
    useSessionStore.setState({ currentTrack: track, currentTrackFileIndex: null });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  events = new EventTarget();
  gestures = new EventTarget();
  vi.stubGlobal('window', events);
  vi.stubGlobal('document', gestures);
  vi.stubGlobal('Audio', MockAudio);
  audios = [];
  blocked = false;
  useSessionStore.setState({ currentTrack: 'A', currentTrackFileIndex: null });
  useAudioStore.setState({
    masterMuted: false,
    musicMuted: false,
    masterVolume: 75,
    musicVolume: 80,
    shuffleMode: false,
  });
  errors = [];
  const onError = (error: unknown) => {
    errors.push(error);
  };
  root = renderer.createContainer(
    {},
    ConcurrentRoot,
    null,
    false,
    null,
    '',
    onError,
    onError,
    onError,
    noop
  );
});

afterEach(async () => {
  await render(null);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mounted MusicEngine lifecycle', () => {
  it.each(['next', 'prev'])('%s cancels the older pending theme transition', async (direction) => {
    await render(createElement(MusicEngine));
    await tick(600);
    await changeTrack('B');
    await tick(100);
    await action(direction);
    const selectedUrl = `B${useSessionStore.getState().currentTrackFileIndex}`;
    const audio = audios[0];
    expect(audio.src).toBe(selectedUrl);
    const calls = audio.play.mock.calls.length;
    await tick(1000);
    expect(audio.src).toBe(selectedUrl);
    expect(audio.play).toHaveBeenCalledTimes(calls);
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBeCloseTo(0.6);
  });

  it.each(['resume', 'unmute'])(
    '%s restores gesture retry without changing the playback position',
    async (kind) => {
      blocked = true;
      await render(createElement(MusicEngine));
      const audio = audios[0];
      audio.currentTime = 37;
      if (kind === 'resume') {
        await action('pause');
        await action('resume');
      } else {
        await mute(true);
        await mute(false);
      }
      const before = audio.play.mock.calls.length;
      await act(async () => {
        useAudioStore.setState({ musicVolume: 40 });
      });
      blocked = false;
      await act(async () => {
        gestures.dispatchEvent(new Event('click'));
      });
      await tick(600);
      expect(audio.play).toHaveBeenCalledTimes(before + 1);
      expect(audio.paused).toBe(false);
      expect(audio.currentTime).toBe(37);
      expect(audio.sourceAssignments).toEqual(['A0']);
      expect(audio.volume).toBeCloseTo(0.3);
    }
  );

  it.each(['pause', 'mute'])(
    '%s during a pending transition prevents a later restart',
    async (kind) => {
      await render(createElement(MusicEngine));
      await tick(600);
      await changeTrack('B');
      await tick(100);
      const audio = audios[0];
      const before = audio.play.mock.calls.length;
      if (kind === 'pause') await action('pause');
      else await mute(true);
      await tick(1000);
      gestures.dispatchEvent(new Event('click'));
      expect(audio.paused).toBe(true);
      expect(audio.play).toHaveBeenCalledTimes(before);
      expect(audio.src).toBe('A0');
      if (kind === 'pause') await action('resume');
      else await mute(false);
      await tick(600);
      expect(audio.src).toBe('B0');
      expect(audio.paused).toBe(false);
    }
  );

  it('unmuting does not override an explicit pause', async () => {
    await render(createElement(MusicEngine));
    await tick(600);
    const audio = audios[0];
    audio.currentTime = 42;
    await action('pause');
    await mute(true);
    await mute(false);
    await tick(600);
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(42);
    expect(audio.play).toHaveBeenCalledTimes(1);
    await action('resume');
    await tick(600);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(42);
  });

  it('updates the volume during fade-in without restarting the file', async () => {
    await render(createElement(MusicEngine));
    await tick(100);
    await act(async () => {
      useAudioStore.setState({ masterVolume: 50, musicVolume: 40 });
    });
    await tick(600);
    expect(audios[0].volume).toBeCloseTo(0.2);
    expect(audios[0].play).toHaveBeenCalledTimes(1);
    expect(audios[0].sourceAssignments).toEqual(['A0']);
  });

  it.each(['stop', 'unmount'])(
    '%s cancels a pending fade and leaves no restart or retry',
    async (kind) => {
      await render(createElement(MusicEngine));
      await tick(600);
      await changeTrack('B');
      await tick(100);
      const audio = audios[0];
      const before = audio.play.mock.calls.length;
      if (kind === 'stop') await changeTrack(null);
      else await render(null);
      await tick(1000);
      gestures.dispatchEvent(new Event('click'));
      expect(audio.play).toHaveBeenCalledTimes(before);
      expect(audio.paused).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['resolve', 'reject'])(
    'does not revive a cancelled play promise that later %ss',
    async (settlement) => {
      await render(createElement(MusicEngine));
      await tick(600);
      await action('pause');
      const audio = audios[0];
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      audio.play.mockImplementationOnce(
        () =>
          new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          })
      );
      await action('resume');
      await render(null);
      await act(async () => {
        if (settlement === 'resolve') resolve();
        else reject(new Error('Blocked'));
      });
      gestures.dispatchEvent(new Event('click'));
      await tick(1000);
      expect(audio.paused).toBe(true);
      expect(audio.play).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('starts cleanly after StrictMode effect cleanup', async () => {
    await render(createElement(StrictMode, null, createElement(MusicEngine)));
    await tick(600);
    expect(audios).toHaveLength(1);
    expect(audios[0].src).toBe('A0');
    expect(audios[0].paused).toBe(false);
  });
});
