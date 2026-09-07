import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAudioStore } from '../../stores/useAudioStore';
import { TRACKS } from './tracks';
import { musicPlaybackRef } from './musicPlaybackRef';
import { startMusicPlayback } from './startMusicPlayback';

/**
 * Headless audio engine mounted in AppShell for ALL users.
 * Plays real MP3 tracks from GCS, shuffling within each theme.
 * Each user controls their own volume/mute locally.
 *
 * Exposes playback progress via the global `musicPlaybackRef` so
 * the MusicPlayer UI can poll it without prop-drilling.
 */
export function MusicEngine() {
  const currentTrack = useSessionStore((s) => s.currentTrack);
  const currentTrackFileIndex = useSessionStore((s) => s.currentTrackFileIndex);
  const effectiveVolume = useAudioStore((s) => s.getEffectiveVolume('music'));
  const masterMuted = useAudioStore((s) => s.masterMuted);
  const musicMuted = useAudioStore((s) => s.musicMuted);
  const isMuted = masterMuted || musicMuted;
  const wasMutedRef = useRef(isMuted);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevTrackRef = useRef<string | null>(null);
  const prevFileIndexRef = useRef<number | null>(null);
  const trackIndexRef = useRef<Record<string, number>>({});
  const fadeCleanupRef = useRef<(() => void) | null>(null);
  const explicitlyPausedRef = useRef(false);
  const pendingFileRef = useRef<string | null>(null);
  /** Monotonic counter to detect stale fade callbacks (race condition fix). */
  const playIdRef = useRef(0);
  /** Interval id for the playback-ref updater. */
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackCleanupRef = useRef<(() => void) | null>(null);
  const cancelPlayback = useCallback(() => {
    playbackCleanupRef.current?.();
    playbackCleanupRef.current = null;
  }, []);
  const cancelTransition = useCallback(() => {
    playIdRef.current++;
    fadeCleanupRef.current?.();
    fadeCleanupRef.current = null;
    cancelPlayback();
  }, [cancelPlayback]);
  /**
   * Ref-backed handlers for the audio element. Attached ONCE to the element
   * the moment it's created inside `ensureAudio`, but always delegate to the
   * latest closure via these refs. This fixes the bug where the prior
   * useEffect-based attachment ran before `ensureAudio` had created the
   * element, so `ended`/`error` listeners never attached.
   */
  const handleEndedRef = useRef<() => void>(() => {});
  const handleErrorRef = useRef<() => void>(() => {});

  // Pick the next file for a theme (shuffle or sequential)
  const getNextFile = useCallback((trackId: string, files: string[]) => {
    const shuffle = useAudioStore.getState().shuffleMode;
    if (shuffle) {
      if (files.length <= 1) {
        trackIndexRef.current[trackId] = 0;
      } else {
        let next: number;
        do {
          next = Math.floor(Math.random() * files.length);
        } while (next === trackIndexRef.current[trackId] && files.length > 1);
        trackIndexRef.current[trackId] = next;
      }
    } else {
      if (trackIndexRef.current[trackId] === undefined) {
        trackIndexRef.current[trackId] = 0;
      } else {
        trackIndexRef.current[trackId] = (trackIndexRef.current[trackId] + 1) % files.length;
      }
    }
    return files[trackIndexRef.current[trackId]];
  }, []);

  // Stable handlers that delegate to the current ref value. These are
  // captured once when the audio element is created so addEventListener/
  // removeEventListener see identical function references.
  const stableHandleEnded = useCallback(() => {
    handleEndedRef.current?.();
  }, []);
  const stableHandleError = useCallback(() => {
    handleErrorRef.current?.();
  }, []);

  // Create or reuse the audio element
  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.loop = false;
      // crossOrigin not needed — GCS bucket has CORS configured for kbrt.ai
      audio.addEventListener('ended', stableHandleEnded);
      audio.addEventListener('error', stableHandleError);
      audioRef.current = audio;
    }
    return audioRef.current;
  }, [stableHandleEnded, stableHandleError]);

  // Start the progress-ref updater (250ms interval)
  const startProgressUpdater = useCallback(() => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = setInterval(() => {
      const audio = audioRef.current;
      if (audio) {
        musicPlaybackRef.currentTime = audio.currentTime;
        musicPlaybackRef.duration = audio.duration || 0;
        musicPlaybackRef.paused = audio.paused;
        musicPlaybackRef.currentFileUrl = audio.src;
      }
    }, 250);
  }, []);

  const stopProgressUpdater = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  // Fade out current audio
  const fadeOut = useCallback((durationMs: number, myPlayId: number): Promise<boolean> => {
    fadeCleanupRef.current?.();
    return new Promise((resolve) => {
      const audio = audioRef.current;
      if (!audio || audio.paused) { resolve(playIdRef.current === myPlayId); return; }

      if (durationMs <= 0) {
        audio.pause();
        resolve(playIdRef.current === myPlayId);
        return;
      }

      const startVol = audio.volume;
      const steps = 20;
      const stepMs = durationMs / steps;
      const decrement = startVol / steps;
      let step = 0;

      // Cancellation must settle the awaiting transition, not just its timer.
      const finish = (completed: boolean) => {
        clearInterval(timer);
        if (fadeCleanupRef.current === cancel) fadeCleanupRef.current = null;
        resolve(completed);
      };
      const cancel = () => finish(false);
      const timer = setInterval(() => {
        if (playIdRef.current !== myPlayId) { cancel(); return; }
        step++;
        audio.volume = Math.max(0, startVol - decrement * step);
        if (step >= steps) {
          audio.pause();
          finish(true);
        }
      }, stepMs);
      fadeCleanupRef.current = cancel;
    });
  }, []);

  // Starting and resuming share retries, without reassigning src on resume.
  const startPlayback = useCallback((audio: HTMLAudioElement) => {
    cancelPlayback();
    audio.volume = 0;
    musicPlaybackRef.paused = true;
    startProgressUpdater();
    const playId = playIdRef.current;
    playbackCleanupRef.current = startMusicPlayback(
      audio,
      () => useAudioStore.getState().getEffectiveVolume('music'),
      () => {
        const settings = useAudioStore.getState();
        return playIdRef.current === playId && audioRef.current === audio &&
          prevTrackRef.current !== null && !explicitlyPausedRef.current &&
          !settings.masterMuted && !settings.musicMuted;
      },
    );
  }, [cancelPlayback, startProgressUpdater]);

  const playFile = useCallback((url: string) => {
    cancelTransition();
    pendingFileRef.current = null;
    const audio = ensureAudio();
    audio.src = url;
    musicPlaybackRef.currentFileUrl = url;
    startPlayback(audio);
  }, [cancelTransition, ensureAudio, startPlayback]);

  const resumePlayback = useCallback(() => {
    const settings = useAudioStore.getState();
    if (explicitlyPausedRef.current || settings.masterMuted || settings.musicMuted || !prevTrackRef.current) return;
    if (pendingFileRef.current) {
      playFile(pendingFileRef.current);
      return;
    }
    const audio = audioRef.current;
    if (audio?.paused && audio.src) {
      cancelTransition();
      startPlayback(audio);
    }
  }, [cancelTransition, playFile, startPlayback]);

  // Advance to the next file in the current theme
  const advanceToNext = useCallback(() => {
    const trackId = prevTrackRef.current;
    if (!trackId) return;
    const track = TRACKS.find((t) => t.id === trackId);
    if (!track) return;
    const nextUrl = getNextFile(track.id, track.files);
    // Update the session store with new file index so UI stays in sync
    const idx = trackIndexRef.current[track.id];
    prevFileIndexRef.current = idx;
    useSessionStore.getState().setCurrentTrackFileIndex(idx);
    playFile(nextUrl);
  }, [getNextFile, playFile]);

  // Go to previous file (or restart if >3s in)
  const goToPrev = useCallback(() => {
    const audio = audioRef.current;
    const trackId = prevTrackRef.current;
    if (!trackId) return;
    const track = TRACKS.find((t) => t.id === trackId);
    if (!track) return;

    if (audio && audio.currentTime > 3 && !pendingFileRef.current) {
      cancelTransition();
      audio.currentTime = 0;
      audio.volume = useAudioStore.getState().getEffectiveVolume('music');
      resumePlayback();
      return;
    }

    const currentIdx = trackIndexRef.current[trackId] ?? 0;
    const prevIdx = (currentIdx - 1 + track.files.length) % track.files.length;
    trackIndexRef.current[trackId] = prevIdx;
    prevFileIndexRef.current = prevIdx;
    useSessionStore.getState().setCurrentTrackFileIndex(prevIdx);
    playFile(track.files[prevIdx]);
  }, [cancelTransition, playFile, resumePlayback]);

  // Handle music-action events (pause/resume/next/prev)
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      const audio = audioRef.current;
      switch (action) {
        case 'pause':
          explicitlyPausedRef.current = true;
          cancelTransition();
          audio?.pause();
          musicPlaybackRef.paused = true;
          break;
        case 'resume':
          explicitlyPausedRef.current = false;
          resumePlayback();
          break;
        case 'next':
          advanceToNext();
          break;
        case 'prev':
          goToPrev();
          break;
      }
    };
    window.addEventListener('music-action', handler);
    return () => window.removeEventListener('music-action', handler);
  }, [advanceToNext, goToPrev, cancelTransition, resumePlayback]);

  // Keep the ended/error handler refs up-to-date so the stable listeners
  // attached inside `ensureAudio` always run the latest logic.
  useEffect(() => {
    handleEndedRef.current = () => {
      advanceToNext();
    };
    handleErrorRef.current = () => {
      const trackId = prevTrackRef.current;
      if (!trackId) return;
      const track = TRACKS.find((t) => t.id === trackId);
      if (!track) return;
      console.error('[MusicEngine] Audio error, skipping to next file');
      advanceToNext();
    };
  }, [advanceToNext]);

  // React to track changes (theme change OR specific file index change)
  useEffect(() => {
    const themeChanged = currentTrack !== prevTrackRef.current;
    const fileChanged = currentTrackFileIndex !== prevFileIndexRef.current;
    if (!themeChanged && !fileChanged) return;
    cancelTransition();

    const wasPlaying = prevTrackRef.current !== null;
    prevTrackRef.current = currentTrack;
    prevFileIndexRef.current = currentTrackFileIndex;

    if (currentTrack === null) {
      pendingFileRef.current = null;
      explicitlyPausedRef.current = false;
      const myId = playIdRef.current;
      fadeOut(300, myId);
      musicPlaybackRef.currentTime = 0;
      musicPlaybackRef.duration = 0;
      musicPlaybackRef.paused = true;
      musicPlaybackRef.currentFileUrl = '';
      stopProgressUpdater();
      return;
    }

    const track = TRACKS.find((t) => t.id === currentTrack);
    if (!track || track.files.length === 0) return;

    const myPlayId = playIdRef.current;
    let url: string;
    if (currentTrackFileIndex != null && currentTrackFileIndex < track.files.length) {
      url = track.files[currentTrackFileIndex];
      trackIndexRef.current[track.id] = currentTrackFileIndex;
    } else {
      url = getNextFile(track.id, track.files);
    }
    // Keep the selected destination if a pause/mute interrupts its fade. Only
    // an explicit resume/unmute may continue it; normal resumes keep position.
    pendingFileRef.current = url;
    const settings = useAudioStore.getState();
    if (explicitlyPausedRef.current || settings.masterMuted || settings.musicMuted) {
      audioRef.current?.pause();
      return;
    }

    (async () => {
      const stillCurrent = await fadeOut(wasPlaying ? 500 : 0, myPlayId);
      if (!stillCurrent || playIdRef.current !== myPlayId) return;

      playFile(url);
    })();
  }, [currentTrack, currentTrackFileIndex, fadeOut, getNextFile, playFile, stopProgressUpdater, cancelTransition]);

  // Update volume when settings change
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    audio.volume = Math.min(1, Math.max(0, effectiveVolume));
  }, [effectiveVolume]);

  // Handle mute/unmute
  useEffect(() => {
    const wasMuted = wasMutedRef.current;
    wasMutedRef.current = isMuted;
    if (isMuted) {
      cancelTransition();
      audioRef.current?.pause();
      musicPlaybackRef.paused = true;
    } else if (wasMuted) {
      resumePlayback();
    }
  }, [isMuted, cancelTransition, resumePlayback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      prevTrackRef.current = null;
      pendingFileRef.current = null;
      trackIndexRef.current = {};
      cancelTransition();
      stopProgressUpdater();
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeEventListener('ended', stableHandleEnded);
        audio.removeEventListener('error', stableHandleError);
      }
      audioRef.current = null;
    };
  }, [stopProgressUpdater, stableHandleEnded, stableHandleError, cancelTransition]);

  // Allow external seek via a window event (used by progress bar click)
  useEffect(() => {
    const handler = (e: Event) => {
      const audio = audioRef.current;
      if (!audio) return;
      const time = (e as CustomEvent<number>).detail;
      audio.currentTime = time;
    };
    window.addEventListener('music-seek', handler);
    return () => window.removeEventListener('music-seek', handler);
  }, []);

  return null;
}
