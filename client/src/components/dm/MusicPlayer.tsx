import { useState, useEffect, useCallback } from 'react';
import { Shuffle, ArrowDown } from 'lucide-react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAudioStore } from '../../stores/useAudioStore';
import { emitMusicChange, emitMusicAction } from '../../socket/emitters';
import { TRACKS, getTrackFileName } from '../audio/tracks';
import { musicPlaybackRef } from '../audio/musicPlaybackRef';
import { VolumeSlider } from '../audio/VolumeSlider';

/* ──────────────────────────────────────────────────────────
   Music Player — DM-only track picker & transport.
   Redesigned with theme grid, now-playing transport,
   progress bar, and full playlist.
   ────────────────────────────────────────────────────────── */

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MusicPlayer() {
  const currentTrack = useSessionStore((s) => s.currentTrack);
  const currentFileIndex = useSessionStore((s) => s.currentTrackFileIndex);
  const {
    musicVolume, musicMuted, masterMuted,
    setMusicVolume, toggleMusicMute,
    shuffleMode, toggleShuffle,
  } = useAudioStore();

  // Poll the playback ref for progress UI
  const [playback, setPlayback] = useState({ currentTime: 0, duration: 0, paused: false });
  useEffect(() => {
    const id = setInterval(() => {
      setPlayback({
        currentTime: musicPlaybackRef.currentTime,
        duration: musicPlaybackRef.duration,
        paused: musicPlaybackRef.paused,
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  const activeTrack = TRACKS.find((t) => t.id === currentTrack);
  const isPlaying = !!activeTrack && !playback.paused;

  const handleSelectTheme = useCallback((trackId: string) => {
    if (currentTrack === trackId) return; // already active
    emitMusicChange(trackId);
  }, [currentTrack]);

  const handleSelectFile = useCallback((trackId: string, fileIndex: number) => {
    emitMusicChange(trackId, fileIndex);
  }, []);

  const handleStop = useCallback(() => {
    emitMusicChange(null);
  }, []);

  const handlePlayPause = useCallback(() => {
    if (!activeTrack) return;
    if (playback.paused) {
      emitMusicAction('resume');
    } else {
      emitMusicAction('pause');
    }
  }, [activeTrack, playback.paused]);

  const handleNext = useCallback(() => emitMusicAction('next'), []);
  const handlePrev = useCallback(() => emitMusicAction('prev'), []);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    window.dispatchEvent(new CustomEvent('music-seek', { detail: time }));
  }, []);

  const progressPct = playback.duration > 0
    ? (playback.currentTime / playback.duration) * 100
    : 0;

  return (
    <div style={styles.container}>
      {/* ── THEMES ── */}
      <div style={styles.sectionLabel}>THEMES</div>
      <div style={styles.themeGrid}>
        {TRACKS.map((track) => {
          const isActive = currentTrack === track.id;
          return (
            <button
              key={track.id}
              onClick={() => handleSelectTheme(track.id)}
              style={{
                ...styles.themeBtn,
                ...(isActive ? styles.themeBtnActive : {}),
              }}
              title={track.name}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{track.emoji}</span>
              <span style={styles.themeName}>{track.name}</span>
            </button>
          );
        })}
      </div>

      {/* ── NOW PLAYING ── */}
      {activeTrack && (
        <>
          <div style={styles.sectionLabel}>NOW PLAYING</div>
          <div style={styles.nowPlayingCard}>
            {/* Track info row */}
            <div style={styles.nowPlayingInfo}>
              <span style={{ fontSize: 14 }}>{activeTrack.emoji}</span>
              <span style={styles.nowPlayingName}>
                {currentFileIndex != null && activeTrack.files[currentFileIndex]
                  ? getTrackFileName(activeTrack.files[currentFileIndex])
                  : activeTrack.name}
              </span>
              <span style={styles.nowPlayingTime}>
                {formatTime(playback.currentTime)} / {formatTime(playback.duration)}
              </span>
            </div>

            {/* Progress bar */}
            <div style={styles.progressContainer}>
              <input
                type="range"
                min={0}
                max={playback.duration || 1}
                step={0.1}
                value={playback.currentTime}
                onChange={handleSeek}
                style={{
                  ...styles.progressBar,
                  background: `linear-gradient(to right, ${theme.gold.primary} ${progressPct}%, ${theme.bg.deep} ${progressPct}%)`,
                }}
              />
            </div>

            {/* Transport + volume row */}
            <div style={styles.transportRow}>
              <div style={styles.transportBtns}>
                <button onClick={handlePrev} style={styles.transportBtn} title="Previous">
                  &#x23EE;
                </button>
                <button onClick={handlePlayPause} style={styles.transportBtn} title={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? '\u23F8' : '\u25B6'}
                </button>
                <button onClick={handleNext} style={styles.transportBtn} title="Next">
                  &#x23ED;
                </button>
                <button onClick={handleStop} style={styles.transportBtn} title="Stop">
                  &#x23F9;
                </button>
                <button
                  onClick={toggleShuffle}
                  style={{
                    ...styles.transportBtn,
                    color: shuffleMode ? theme.gold.primary : theme.text.muted,
                    borderColor: shuffleMode ? theme.gold.border : theme.border.default,
                  }}
                  title={shuffleMode ? 'Shuffle on' : 'Sequential'}
                >
                  {shuffleMode ? <Shuffle size={12} /> : <ArrowDown size={12} />}
                </button>
              </div>

              {/* Inline volume */}
              <div style={styles.inlineVolume}>
                <VolumeSlider
                  label=""
                  value={musicVolume}
                  muted={musicMuted || masterMuted}
                  onToggleMute={toggleMusicMute}
                  onChange={setMusicVolume}
                  disabled={masterMuted}
                  compact
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── PLAYLIST ── */}
      {activeTrack && (
        <>
          <div style={styles.sectionLabel}>PLAYLIST</div>
          <div style={styles.playlist}>
            {activeTrack.files.map((file, idx) => {
              const isCurrent = currentFileIndex === idx;
              return (
                <button
                  key={idx}
                  onClick={() => handleSelectFile(activeTrack.id, idx)}
                  style={{
                    ...styles.playlistItem,
                    ...(isCurrent ? styles.playlistItemActive : {}),
                  }}
                >
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: isCurrent ? theme.gold.primary : 'transparent',
                    border: isCurrent ? 'none' : `1px solid ${theme.text.muted}`,
                    flexShrink: 0,
                    boxShadow: isCurrent ? theme.goldGlow.soft : 'none',
                  }} />
                  <span style={styles.playlistName}>
                    {getTrackFileName(file)}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* -- Styles ------------------------------------------------- */

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1,
    color: theme.gold.dim,
    textTransform: 'uppercase' as const,
  },
  themeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 6,
  },
  themeBtn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: '8px 4px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  themeBtnActive: {
    borderColor: theme.gold.primary,
    background: theme.gold.bg,
    color: theme.gold.primary,
    boxShadow: theme.goldGlow.soft,
  },
  themeName: {
    fontSize: 9,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '100%',
  },
  nowPlayingCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '8px 10px',
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.card,
  },
  nowPlayingInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  nowPlayingName: {
    flex: 1,
    fontSize: 12,
    fontWeight: 600,
    color: theme.gold.primary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  nowPlayingTime: {
    fontSize: 10,
    fontWeight: 500,
    color: theme.text.muted,
    flexShrink: 0,
  },
  progressContainer: {
    width: '100%',
  },
  progressBar: {
    width: '100%',
    height: 4,
    cursor: 'pointer',
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
    borderRadius: 2,
    outline: 'none',
    border: 'none',
  },
  transportRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  transportBtns: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
  },
  transportBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
    transition: `all ${theme.motion.fast}`,
  },
  inlineVolume: {
    flex: 1,
    minWidth: 0,
  },
  playlist: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 1,
  },
  playlistItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderRadius: theme.radius.sm,
    border: 'none',
    background: 'transparent',
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 500,
    textAlign: 'left' as const,
    transition: `all ${theme.motion.fast}`,
  },
  playlistItemActive: {
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontWeight: 700,
  },
  playlistName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  },
};
