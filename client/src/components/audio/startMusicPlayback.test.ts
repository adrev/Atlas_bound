import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMusicPlayback } from './startMusicPlayback';

function fixture() {
  const gestures = new EventTarget();
  const play = vi.fn().mockResolvedValue(undefined);
  const audio = { play, volume: 0, paused: false } as unknown as HTMLAudioElement;
  let volume = 0.6;
  let allowed = true;
  const cancel = startMusicPlayback(audio, () => volume, () => allowed, gestures);
  return { gestures, play, audio, cancel, setVolume: (v: number) => { volume = v; }, block: () => { allowed = false; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('music playback recovery', () => {
  it('fades to the chosen volume after blocked autoplay succeeds on a gesture', async () => {
    vi.useFakeTimers();
    const gestures = new EventTarget();
    const play = vi.fn().mockRejectedValueOnce(new Error('NotAllowedError')).mockResolvedValue(undefined);
    const audio = { play, volume: 0, paused: false } as unknown as HTMLAudioElement;
    const cancel = startMusicPlayback(audio, () => 0.6, () => true, gestures);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.volume).toBe(0);
    gestures.dispatchEvent(new Event('click'));
    await vi.advanceTimersByTimeAsync(550);
    expect(play).toHaveBeenCalledTimes(2);
    expect(audio.volume).toBeCloseTo(0.6);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resurrect a stopped track on the next click', async () => {
    vi.useFakeTimers();
    const gestures = new EventTarget();
    const play = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const audio = { play, volume: 0, paused: true } as unknown as HTMLAudioElement;
    const cancel = startMusicPlayback(audio, () => 1, () => true, gestures);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    gestures.dispatchEvent(new Event('click'));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('uses the latest volume during a fade and stops touching audio after cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(200);
    f.setVolume(0.2);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.audio.volume).toBeCloseTo(0.2);
    f.cancel();
    f.audio.volume = 0.9;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.audio.volume).toBe(0.9);
  });

  it('does not let an old fade defeat mute or a newer track', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(100);
    f.block();
    f.audio.volume = 0;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.audio.volume).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.cancel();
  });
});
