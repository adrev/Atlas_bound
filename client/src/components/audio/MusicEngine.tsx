import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAudioStore } from '../../stores/useAudioStore';
import { TRACKS } from './tracks';

/**
 * Headless audio engine mounted in AppShell for ALL users.
 * Subscribes to `currentTrack` from the session store (set via
 * the DM's socket broadcast) and manages Web Audio playback.
 * Each user controls their own volume/mute locally via useAudioStore.
 *
 * Renders nothing -- purely manages audio.
 */
export function MusicEngine() {
  const currentTrack = useSessionStore((s) => s.currentTrack);
  const effectiveVolume = useAudioStore((s) => s.getEffectiveVolume('music'));
  const masterMuted = useAudioStore((s) => s.masterMuted);
  const musicMuted = useAudioStore((s) => s.musicMuted);
  const isMuted = masterMuted || musicMuted;

  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTrackRef = useRef<string | null>(null);

  // Ensure AudioContext exists (created lazily on first track)
  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = effectiveVolume;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterGainRef.current = master;
    }
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }
    return { ctx: ctxRef.current, master: masterGainRef.current! };
  }, [effectiveVolume]);

  // Stop current track with optional fade
  const stopCurrent = useCallback((fadeMs = 0): Promise<void> => {
    return new Promise((resolve) => {
      if (!cleanupRef.current) { resolve(); return; }
      if (fadeMs > 0 && masterGainRef.current && ctxRef.current) {
        masterGainRef.current.gain.setTargetAtTime(0, ctxRef.current.currentTime, fadeMs / 3000);
        fadeTimerRef.current = setTimeout(() => {
          cleanupRef.current?.();
          cleanupRef.current = null;
          if (masterGainRef.current) {
            masterGainRef.current.gain.value = useAudioStore.getState().getEffectiveVolume('music');
          }
          resolve();
        }, fadeMs);
      } else {
        cleanupRef.current();
        cleanupRef.current = null;
        resolve();
      }
    });
  }, []);

  // React to track changes from the session store
  useEffect(() => {
    if (currentTrack === prevTrackRef.current) return;
    const wasPlaying = prevTrackRef.current !== null;
    prevTrackRef.current = currentTrack;

    if (currentTrack === null) {
      // Stop
      stopCurrent(300);
      return;
    }

    const track = TRACKS.find((t) => t.id === currentTrack);
    if (!track) return;

    // Crossfade into new track
    (async () => {
      const { ctx, master } = ensureCtx();
      await stopCurrent(wasPlaying ? 500 : 0);
      master.gain.setTargetAtTime(
        useAudioStore.getState().getEffectiveVolume('music'),
        ctx.currentTime,
        0.05,
      );
      const cleanup = track.build(ctx, master);
      cleanupRef.current = cleanup;
    })();
  }, [currentTrack, ensureCtx, stopCurrent]);

  // Update gain when volume changes
  useEffect(() => {
    if (masterGainRef.current && ctxRef.current) {
      masterGainRef.current.gain.setTargetAtTime(effectiveVolume, ctxRef.current.currentTime, 0.05);
    }
  }, [effectiveVolume]);

  // Suspend/resume when mute toggles while a track is active
  useEffect(() => {
    if (!ctxRef.current || !currentTrack) return;
    if (isMuted && ctxRef.current.state === 'running') {
      ctxRef.current.suspend();
    } else if (!isMuted && ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }
  }, [isMuted, currentTrack]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      ctxRef.current?.close();
    };
  }, []);

  return null;
}
