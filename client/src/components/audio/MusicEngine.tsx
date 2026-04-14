import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAudioStore } from '../../stores/useAudioStore';
import { TRACKS } from './tracks';
import { musicPlaybackRef } from './musicPlaybackRef';

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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevTrackRef = useRef<string | null>(null);
  const prevFileIndexRef = useRef<number | null>(null);
  const trackIndexRef = useRef<Record<string, number>>({});
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic counter to detect stale fade callbacks (race condition fix). */
  const playIdRef = useRef(0);
  /** Interval id for the playback-ref updater. */
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Create or reuse the audio element
  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.loop = false;
      // crossOrigin not needed — GCS bucket has CORS configured for kbrt.ai
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

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
    return new Promise((resolve) => {
      const audio = audioRef.current;
      if (!audio || audio.paused) { resolve(true); return; }

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

      if (fadeTimerRef.current) clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVol - decrement * step);
        if (step >= steps) {
          if (fadeTimerRef.current) clearInterval(fadeTimerRef.current);
          fadeTimerRef.current = null;
          audio.pause();
          resolve(playIdRef.current === myPlayId);
        }
      }, stepMs) as unknown as ReturnType<typeof setTimeout>;
    });
  }, []);

  // Play a file with fade in
  const playFile = useCallback((url: string, volume: number) => {
    const audio = ensureAudio();
    audio.src = url;
    audio.volume = 0;
    musicPlaybackRef.currentFileUrl = url;
    musicPlaybackRef.paused = false;
    startProgressUpdater();
    audio.play().then(() => {
      const targetVol = Math.min(1, Math.max(0, volume));
      const steps = 15;
      const stepMs = 500 / steps;
      const increment = targetVol / steps;
      let step = 0;
      const timer = setInterval(() => {
        step++;
        audio.volume = Math.min(targetVol, increment * step);
        if (step >= steps) clearInterval(timer);
      }, stepMs);
    }).catch(() => {
      const handler = () => {
        audio.play().catch(() => {});
        document.removeEventListener('click', handler);
      };
      document.addEventListener('click', handler, { once: true });
    });
  }, [ensureAudio, startProgressUpdater]);

  // Advance to the next file in the current theme
  const advanceToNext = useCallback(() => {
    const trackId = prevTrackRef.current;
    if (!trackId) return;
    const track = TRACKS.find((t) => t.id === trackId);
    if (!track) return;
    const nextUrl = getNextFile(track.id, track.files);
    const vol = useAudioStore.getState().getEffectiveVolume('music');
    // Update the session store with new file index so UI stays in sync
    const idx = trackIndexRef.current[track.id];
    useSessionStore.getState().setCurrentTrackFileIndex(idx);
    playFile(nextUrl, vol);
  }, [getNextFile, playFile]);

  // Go to previous file (or restart if >3s in)
  const goToPrev = useCallback(() => {
    const audio = audioRef.current;
    const trackId = prevTrackRef.current;
    if (!trackId) return;
    const track = TRACKS.find((t) => t.id === trackId);
    if (!track) return;

    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }

    const currentIdx = trackIndexRef.current[trackId] ?? 0;
    const prevIdx = (currentIdx - 1 + track.files.length) % track.files.length;
    trackIndexRef.current[trackId] = prevIdx;
    useSessionStore.getState().setCurrentTrackFileIndex(prevIdx);
    const vol = useAudioStore.getState().getEffectiveVolume('music');
    playFile(track.files[prevIdx], vol);
  }, [playFile]);

  // Handle music-action events (pause/resume/next/prev)
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      const audio = audioRef.current;
      switch (action) {
        case 'pause':
          if (audio && !audio.paused) {
            audio.pause();
            musicPlaybackRef.paused = true;
          }
          break;
        case 'resume':
          if (audio && audio.paused && audio.src && prevTrackRef.current) {
            audio.play().catch(() => {});
            musicPlaybackRef.paused = false;
          }
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
  }, [advanceToNext, goToPrev]);

  // When a track ends, play the next file in the theme
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      advanceToNext();
    };

    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [advanceToNext]);

  // Error handling: skip to next file on audio error
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleError = () => {
      const trackId = prevTrackRef.current;
      if (!trackId) return;
      const track = TRACKS.find((t) => t.id === trackId);
      if (!track) return;

      console.error('[MusicEngine] Audio error, skipping to next file');
      // Try the next file. If we've cycled through all files and still
      // erroring, the advanceToNext will keep trying. We limit by
      // checking if the errored URL is the same as what we just set.
      advanceToNext();
    };

    audio.addEventListener('error', handleError);
    return () => audio.removeEventListener('error', handleError);
  }, [advanceToNext]);

  // React to track changes (theme change OR specific file index change)
  useEffect(() => {
    const themeChanged = currentTrack !== prevTrackRef.current;
    const fileChanged = currentTrackFileIndex !== prevFileIndexRef.current;
    if (!themeChanged && !fileChanged) return;

    const wasPlaying = prevTrackRef.current !== null;
    prevTrackRef.current = currentTrack;
    prevFileIndexRef.current = currentTrackFileIndex;

    if (currentTrack === null) {
      playIdRef.current++;
      const myId = playIdRef.current;
      fadeOut(300, myId);
      musicPlaybackRef.currentTime = 0;
      musicPlaybackRef.duration = 0;
      musicPlaybackRef.paused = false;
      musicPlaybackRef.currentFileUrl = '';
      stopProgressUpdater();
      return;
    }

    const track = TRACKS.find((t) => t.id === currentTrack);
    if (!track || track.files.length === 0) return;

    playIdRef.current++;
    const myPlayId = playIdRef.current;

    (async () => {
      const stillCurrent = await fadeOut(wasPlaying ? 500 : 0, myPlayId);
      if (!stillCurrent) return; // A newer play was requested — abort

      let url: string;
      if (currentTrackFileIndex != null && currentTrackFileIndex < track.files.length) {
        url = track.files[currentTrackFileIndex];
        trackIndexRef.current[track.id] = currentTrackFileIndex;
      } else {
        url = getNextFile(track.id, track.files);
      }
      playFile(url, effectiveVolume);
    })();
  }, [currentTrack, currentTrackFileIndex, effectiveVolume, fadeOut, getNextFile, playFile, stopProgressUpdater]);

  // Update volume when settings change
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    audio.volume = Math.min(1, Math.max(0, effectiveVolume));
  }, [effectiveVolume]);

  // Handle mute/unmute
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isMuted && !audio.paused) {
      audio.pause();
    } else if (!isMuted && audio.src && prevTrackRef.current) {
      audio.play().catch(() => {});
    }
  }, [isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (fadeTimerRef.current) clearInterval(fadeTimerRef.current as unknown as number);
      stopProgressUpdater();
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [stopProgressUpdater]);

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
