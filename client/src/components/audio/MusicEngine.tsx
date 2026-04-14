import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAudioStore } from '../../stores/useAudioStore';
import { TRACKS } from './tracks';

/**
 * Headless audio engine mounted in AppShell for ALL users.
 * Plays real MP3 tracks from GCS, shuffling within each theme.
 * Each user controls their own volume/mute locally.
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
  /** Whether the engine should shuffle (true) or play sequentially (false). */
  const shuffleRef = useRef(true);

  /** Allow external components to set shuffle mode. */
  useEffect(() => {
    const handler = (e: Event) => {
      shuffleRef.current = (e as CustomEvent<boolean>).detail;
    };
    window.addEventListener('music-shuffle-changed', handler);
    return () => window.removeEventListener('music-shuffle-changed', handler);
  }, []);

  // Pick the next file for a theme (shuffle or sequential)
  const getNextFile = useCallback((trackId: string, files: string[]) => {
    if (shuffleRef.current) {
      // Shuffle: pick a random file different from current when possible
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
      // Sequential
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
      audio.loop = false; // We handle advancement to next track
      audio.crossOrigin = 'anonymous';
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  // Fade out current audio
  const fadeOut = useCallback((durationMs: number): Promise<void> => {
    return new Promise((resolve) => {
      const audio = audioRef.current;
      if (!audio || audio.paused) { resolve(); return; }

      if (durationMs <= 0) {
        audio.pause();
        resolve();
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
          resolve();
        }
      }, stepMs) as unknown as ReturnType<typeof setTimeout>;
    });
  }, []);

  // Play a file with fade in
  const playFile = useCallback((url: string, volume: number) => {
    const audio = ensureAudio();
    audio.src = url;
    audio.volume = 0;
    audio.play().then(() => {
      // Fade in
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
      // Autoplay blocked — user hasn't interacted yet, retry on click
      const handler = () => {
        audio.play().catch(() => {});
        document.removeEventListener('click', handler);
      };
      document.addEventListener('click', handler, { once: true });
    });
  }, [ensureAudio]);

  // When a track ends, play the next file in the theme
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      const trackId = prevTrackRef.current;
      if (!trackId) return;
      const track = TRACKS.find((t) => t.id === trackId);
      if (!track) return;
      const nextUrl = getNextFile(track.id, track.files);
      const vol = useAudioStore.getState().getEffectiveVolume('music');
      playFile(nextUrl, vol);
    };

    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [getNextFile, playFile]);

  // React to track changes (theme change OR specific file index change)
  useEffect(() => {
    const themeChanged = currentTrack !== prevTrackRef.current;
    const fileChanged = currentTrackFileIndex !== prevFileIndexRef.current;
    if (!themeChanged && !fileChanged) return;

    const wasPlaying = prevTrackRef.current !== null;
    prevTrackRef.current = currentTrack;
    prevFileIndexRef.current = currentTrackFileIndex;

    if (currentTrack === null) {
      fadeOut(300);
      return;
    }

    const track = TRACKS.find((t) => t.id === currentTrack);
    if (!track || track.files.length === 0) return;

    (async () => {
      await fadeOut(wasPlaying ? 500 : 0);
      let url: string;
      if (currentTrackFileIndex != null && currentTrackFileIndex < track.files.length) {
        // Specific file requested by DM
        url = track.files[currentTrackFileIndex];
        trackIndexRef.current[track.id] = currentTrackFileIndex;
      } else {
        url = getNextFile(track.id, track.files);
      }
      playFile(url, effectiveVolume);
    })();
  }, [currentTrack, currentTrackFileIndex, effectiveVolume, fadeOut, getNextFile, playFile]);

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
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  return null;
}
