import { useState } from 'react';
import { Square, Volume2, Shuffle, ArrowDown, Play } from 'lucide-react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitMusicChange } from '../../socket/emitters';
import { TRACKS, getTrackFileName } from '../audio/tracks';

/* ──────────────────────────────────────────────────────────
   Music Player — DM-only track picker.
   Selecting a track emits a socket event so ALL clients
   (including DM) receive the track change via MusicEngine.
   ────────────────────────────────────────────────────────── */

export function MusicPlayer() {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedTheme, setExpandedTheme] = useState<string | null>(null);
  const [shuffleOn, setShuffleOn] = useState(true);
  const currentTrack = useSessionStore((s) => s.currentTrack);
  const currentFileIndex = useSessionStore((s) => s.currentTrackFileIndex);

  const handleSelectTrack = (trackId: string) => {
    if (currentTrack === trackId) {
      // Already playing this theme — toggle expanded view
      setExpandedTheme((prev) => (prev === trackId ? null : trackId));
    } else {
      // Start playing the theme (auto-shuffle picks first file)
      emitMusicChange(trackId);
      setExpandedTheme(null);
    }
  };

  const handleSelectFile = (trackId: string, fileIndex: number) => {
    emitMusicChange(trackId, fileIndex);
  };

  const handleStop = () => {
    emitMusicChange(null);
    setExpandedTheme(null);
  };

  const handleToggleShuffle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !shuffleOn;
    setShuffleOn(next);
    window.dispatchEvent(new CustomEvent('music-shuffle-changed', { detail: next }));
  };

  const activeTrack = TRACKS.find((t) => t.id === currentTrack);

  return (
    <div style={styles.container}>
      {/* Header -- click to collapse */}
      <div style={styles.header} onClick={() => setCollapsed((c) => !c)}>
        <span style={styles.headerLabel}>
          <Volume2 size={12} style={{ marginRight: 6, opacity: 0.7 }} />
          MUSIC
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Shuffle / sequential toggle */}
          {!collapsed && (
            <button
              onClick={handleToggleShuffle}
              style={{
                ...styles.controlBtn,
                width: 22,
                height: 22,
                color: shuffleOn ? theme.gold.primary : theme.text.muted,
              }}
              title={shuffleOn ? 'Shuffle (click for sequential)' : 'Sequential (click for shuffle)'}
            >
              {shuffleOn ? <Shuffle size={12} /> : <ArrowDown size={12} />}
            </button>
          )}
          <span style={styles.collapseIcon}>{collapsed ? '\u25B8' : '\u25BE'}</span>
        </div>
      </div>

      {!collapsed && (
        <div style={styles.body}>
          {/* Track buttons */}
          <div style={styles.trackGrid}>
            {TRACKS.map((track) => {
              const isActive = currentTrack === track.id;
              return (
                <button
                  key={track.id}
                  onClick={() => handleSelectTrack(track.id)}
                  style={{
                    ...styles.trackBtn,
                    ...(isActive ? styles.trackBtnActive : {}),
                  }}
                  title={track.name}
                >
                  <span style={{ fontSize: 14 }}>{track.emoji}</span>
                  <span style={styles.trackName}>{track.name}</span>
                </button>
              );
            })}
          </div>

          {/* Expanded file list for the active theme */}
          {expandedTheme && (() => {
            const track = TRACKS.find((t) => t.id === expandedTheme);
            if (!track) return null;
            return (
              <div style={styles.fileList}>
                {track.files.map((file, idx) => {
                  const isPlaying = currentTrack === track.id && currentFileIndex === idx;
                  return (
                    <button
                      key={idx}
                      onClick={() => handleSelectFile(track.id, idx)}
                      style={{
                        ...styles.fileBtn,
                        ...(isPlaying ? styles.fileBtnActive : {}),
                      }}
                    >
                      <Play size={10} style={{ flexShrink: 0, opacity: isPlaying ? 1 : 0.5 }} />
                      <span style={styles.fileName}>{getTrackFileName(file)}</span>
                      {isPlaying && <span style={styles.playingDot} />}
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* Now playing */}
          {activeTrack && (
            <div style={styles.nowPlaying}>
              Now playing: {activeTrack.emoji} {activeTrack.name}
              {currentFileIndex != null && activeTrack.files[currentFileIndex] && (
                <span style={{ opacity: 0.7, fontWeight: 400 }}>
                  {' '}&mdash; {getTrackFileName(activeTrack.files[currentFileIndex])}
                </span>
              )}
            </div>
          )}

          {/* Controls row */}
          <div style={styles.controls}>
            <button
              style={styles.controlBtn}
              onClick={handleStop}
              title="Stop"
              disabled={!currentTrack}
            >
              <Square size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -- Styles ------------------------------------------------- */

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.card,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  headerLabel: {
    ...theme.type.h3,
    color: theme.gold.dim,
    display: 'flex',
    alignItems: 'center',
  },
  collapseIcon: {
    fontSize: 10,
    color: theme.text.muted,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '0 12px 12px',
  },
  trackGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 4,
  },
  trackBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    transition: `all ${theme.motion.fast}`,
  },
  trackBtnActive: {
    borderColor: theme.gold.primary,
    background: theme.gold.bg,
    color: theme.gold.primary,
    boxShadow: theme.goldGlow.soft,
  },
  trackName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '4px 0',
    borderTop: `1px solid ${theme.border.default}`,
    borderBottom: `1px solid ${theme.border.default}`,
  },
  fileBtn: {
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
    transition: `all ${theme.motion.fast}`,
    textAlign: 'left' as const,
  },
  fileBtnActive: {
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontWeight: 600,
  },
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  playingDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: theme.gold.primary,
    flexShrink: 0,
    boxShadow: theme.goldGlow.soft,
  },
  nowPlaying: {
    fontSize: 11,
    color: theme.gold.primary,
    fontWeight: 600,
    textAlign: 'center',
    padding: '2px 0',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  controlBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    flexShrink: 0,
    transition: `all ${theme.motion.fast}`,
  },
};
