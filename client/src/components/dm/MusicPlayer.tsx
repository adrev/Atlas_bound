import { useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitMusicChange } from '../../socket/emitters';
import { TRACKS } from '../audio/tracks';

/* ──────────────────────────────────────────────────────────
   Music Player — DM-only track picker.
   Selecting a track emits a socket event so ALL clients
   (including DM) receive the track change via MusicEngine.
   ────────────────────────────────────────────────────────── */

export function MusicPlayer() {
  const [collapsed, setCollapsed] = useState(false);
  const currentTrack = useSessionStore((s) => s.currentTrack);

  const handleSelectTrack = (trackId: string) => {
    emitMusicChange(trackId);
  };

  const handleStop = () => {
    emitMusicChange(null);
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
        <span style={styles.collapseIcon}>{collapsed ? '\u25B8' : '\u25BE'}</span>
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

          {/* Now playing */}
          {activeTrack && (
            <div style={styles.nowPlaying}>
              Now playing: {activeTrack.emoji} {activeTrack.name}
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
