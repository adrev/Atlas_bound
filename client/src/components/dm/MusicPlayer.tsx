import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Pause, Square, Volume2 } from 'lucide-react';
import { theme } from '../../styles/theme';
import { useAudioStore } from '../../stores/useAudioStore';

/* ──────────────────────────────────────────────────────────
   Ambient soundscape generator using the Web Audio API.
   Each "track" is a procedural soundscape built from
   oscillators, filters, and gain nodes. No external audio
   files required.
   ────────────────────────────────────────────────────────── */

interface Track {
  id: string;
  name: string;
  emoji: string;
  /** Builder function: creates the audio graph, returns a cleanup fn */
  build: (ctx: AudioContext, dest: GainNode) => () => void;
}

// ── Helpers ─────────────────────────────────────────────

function lfo(ctx: AudioContext, freq: number, dest: AudioParam, amount: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.value = amount;
  osc.connect(gain).connect(dest);
  osc.start();
  return osc;
}

function pad(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  type: OscillatorType = 'sine',
  vol = 0.15,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = vol;
  osc.connect(gain).connect(dest);
  osc.start();
  return { osc, gain };
}

function noise(ctx: AudioContext, dest: AudioNode, vol = 0.04) {
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = vol;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 800;
  src.connect(filter).connect(gain).connect(dest);
  src.start();
  return { src, gain, filter };
}

// ── Track definitions ───────────────────────────────────

const TRACKS: Track[] = [
  {
    id: 'tavern',
    name: 'Tavern',
    emoji: '🍺',
    build(ctx, dest) {
      // Warm major chord with slow modulation
      const nodes = [
        pad(ctx, dest, 220, 'triangle', 0.12),  // A3
        pad(ctx, dest, 277, 'triangle', 0.08),  // C#4
        pad(ctx, dest, 330, 'sine', 0.07),      // E4
        pad(ctx, dest, 440, 'sine', 0.04),      // A4
      ];
      const l = lfo(ctx, 0.15, nodes[0].gain.gain, 0.03);
      const n = noise(ctx, dest, 0.02);
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        l.stop();
        n.src.stop();
      };
    },
  },
  {
    id: 'combat',
    name: 'Combat',
    emoji: '⚔️',
    build(ctx, dest) {
      // Driving low pulse + dissonant fifths
      const nodes = [
        pad(ctx, dest, 55, 'sawtooth', 0.12),   // Low drone
        pad(ctx, dest, 82.5, 'square', 0.05),   // Fifth
        pad(ctx, dest, 110, 'sawtooth', 0.06),   // Octave
      ];
      // Rhythmic pulse via LFO on the main gain
      const pulseGain = ctx.createGain();
      pulseGain.gain.value = 0.8;
      nodes[0].gain.connect(pulseGain).connect(dest);
      const l = lfo(ctx, 2.5, pulseGain.gain, 0.6);
      const n = noise(ctx, dest, 0.03);
      n.filter.frequency.value = 2000;
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        l.stop();
        n.src.stop();
      };
    },
  },
  {
    id: 'exploration',
    name: 'Exploration',
    emoji: '🧭',
    build(ctx, dest) {
      // Gentle arpeggiated feel with slow oscillation
      const freqs = [261.6, 329.6, 392, 523.3]; // C E G C5
      const nodes = freqs.map((f, i) => {
        const p = pad(ctx, dest, f, 'sine', 0.06);
        lfo(ctx, 0.1 + i * 0.07, p.gain.gain, 0.04);
        return p;
      });
      const n = noise(ctx, dest, 0.015);
      n.filter.frequency.value = 600;
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        n.src.stop();
      };
    },
  },
  {
    id: 'mystery',
    name: 'Mystery',
    emoji: '🔮',
    build(ctx, dest) {
      // Minor key pads with dissonant intervals
      const nodes = [
        pad(ctx, dest, 146.8, 'sine', 0.1),    // D3
        pad(ctx, dest, 174.6, 'triangle', 0.06), // F3
        pad(ctx, dest, 207.7, 'sine', 0.05),    // Ab3 (tritone flavor)
        pad(ctx, dest, 293.7, 'sine', 0.03),    // D4
      ];
      const l1 = lfo(ctx, 0.08, nodes[2].osc.frequency, 3);
      const l2 = lfo(ctx, 0.12, nodes[0].gain.gain, 0.04);
      const n = noise(ctx, dest, 0.02);
      n.filter.frequency.value = 400;
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        l1.stop();
        l2.stop();
        n.src.stop();
      };
    },
  },
  {
    id: 'bossfight',
    name: 'Boss Fight',
    emoji: '👹',
    build(ctx, dest) {
      // Heavy low drones + dissonant upper
      const nodes = [
        pad(ctx, dest, 41.2, 'sawtooth', 0.14),  // E1 — sub bass
        pad(ctx, dest, 82.4, 'square', 0.06),    // E2
        pad(ctx, dest, 123.5, 'sawtooth', 0.04), // B2
        pad(ctx, dest, 155.6, 'triangle', 0.05), // Eb3 — tension
      ];
      const pulseGain = ctx.createGain();
      pulseGain.gain.value = 1;
      nodes[0].gain.disconnect();
      nodes[0].gain.connect(pulseGain).connect(dest);
      const l = lfo(ctx, 3.5, pulseGain.gain, 0.7);
      const n = noise(ctx, dest, 0.04);
      n.filter.frequency.value = 3000;
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        l.stop();
        n.src.stop();
      };
    },
  },
  {
    id: 'peaceful',
    name: 'Peaceful',
    emoji: '🌿',
    build(ctx, dest) {
      // Gentle major 7th pads
      const nodes = [
        pad(ctx, dest, 196, 'sine', 0.08),    // G3
        pad(ctx, dest, 246.9, 'sine', 0.06),  // B3
        pad(ctx, dest, 293.7, 'triangle', 0.04), // D4
        pad(ctx, dest, 370, 'sine', 0.03),    // F#4
      ];
      nodes.forEach((n, i) => {
        lfo(ctx, 0.06 + i * 0.04, n.gain.gain, 0.02);
      });
      const n = noise(ctx, dest, 0.01);
      n.filter.frequency.value = 300;
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        n.src.stop();
      };
    },
  },
  {
    id: 'dungeon',
    name: 'Dungeon',
    emoji: '🏚️',
    build(ctx, dest) {
      // Deep drones with metallic resonance
      const nodes = [
        pad(ctx, dest, 55, 'sawtooth', 0.08),
        pad(ctx, dest, 58, 'sine', 0.06), // Slight beating
      ];
      // Metallic ring via high-Q bandpass on noise
      const n = noise(ctx, dest, 0.03);
      n.filter.type = 'bandpass';
      n.filter.frequency.value = 1200;
      (n.filter.Q as AudioParam).value = 15;
      const l = lfo(ctx, 0.05, n.filter.frequency, 400);
      return () => {
        nodes.forEach((n) => { n.osc.stop(); });
        n.src.stop();
        l.stop();
      };
    },
  },
  {
    id: 'storm',
    name: 'Storm',
    emoji: '⛈️',
    build(ctx, dest) {
      // Wind noise + low rumble
      const n = noise(ctx, dest, 0.08);
      n.filter.type = 'bandpass';
      n.filter.frequency.value = 500;
      (n.filter.Q as AudioParam).value = 1;
      const windLfo = lfo(ctx, 0.07, n.filter.frequency, 300);
      const volLfo = lfo(ctx, 0.12, n.gain.gain, 0.04);
      // Thunder rumble
      const rumble = pad(ctx, dest, 30, 'sine', 0.06);
      const rumbleLfo = lfo(ctx, 0.04, rumble.gain.gain, 0.05);
      return () => {
        n.src.stop();
        windLfo.stop();
        volLfo.stop();
        rumble.osc.stop();
        rumbleLfo.stop();
      };
    },
  },
];

/* ──────────────────────────────────────────────────────────
   Music Player component
   ────────────────────────────────────────────────────────── */

export function MusicPlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Read volume from audio store
  const effectiveVolume = useAudioStore((s) => s.getEffectiveVolume('music'));
  const masterMuted = useAudioStore((s) => s.masterMuted);
  const musicMuted = useAudioStore((s) => s.musicMuted);
  const isMuted = masterMuted || musicMuted;

  // Ensure AudioContext is created on first user gesture
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      ctxRef.current?.close();
    };
  }, []);

  // Update gain when effective volume changes
  useEffect(() => {
    if (masterGainRef.current && ctxRef.current) {
      masterGainRef.current.gain.setTargetAtTime(effectiveVolume, ctxRef.current.currentTime, 0.05);
    }
  }, [effectiveVolume]);

  // Suspend/resume audio context when muted/unmuted while playing
  useEffect(() => {
    if (!ctxRef.current || !currentTrackId) return;
    if (isMuted && ctxRef.current.state === 'running') {
      ctxRef.current.suspend();
      setPlaying(false);
    } else if (!isMuted && ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
      setPlaying(true);
    }
  }, [isMuted, currentTrackId]);

  const stopCurrent = useCallback((fadeMs = 0) => {
    return new Promise<void>((resolve) => {
      if (!cleanupRef.current) {
        resolve();
        return;
      }
      if (fadeMs > 0 && masterGainRef.current && ctxRef.current) {
        masterGainRef.current.gain.setTargetAtTime(0, ctxRef.current.currentTime, fadeMs / 3000);
        fadeTimerRef.current = setTimeout(() => {
          cleanupRef.current?.();
          cleanupRef.current = null;
          if (masterGainRef.current) {
            masterGainRef.current.gain.value = effectiveVolume;
          }
          resolve();
        }, fadeMs);
      } else {
        cleanupRef.current();
        cleanupRef.current = null;
        resolve();
      }
    });
  }, [effectiveVolume]);

  const playTrack = useCallback(async (track: Track) => {
    const { ctx, master } = ensureCtx();

    // Crossfade: fade out current track, then start new one
    await stopCurrent(playing ? 500 : 0);

    // Reset master volume after fade
    master.gain.setTargetAtTime(effectiveVolume, ctx.currentTime, 0.05);

    const cleanup = track.build(ctx, master);
    cleanupRef.current = cleanup;
    setCurrentTrackId(track.id);
    setPlaying(true);
  }, [ensureCtx, stopCurrent, playing, effectiveVolume]);

  const handleStop = useCallback(async () => {
    await stopCurrent(300);
    setPlaying(false);
    setCurrentTrackId(null);
  }, [stopCurrent]);

  const handlePauseResume = useCallback(() => {
    if (!ctxRef.current) return;
    if (ctxRef.current.state === 'running') {
      ctxRef.current.suspend();
      setPlaying(false);
    } else {
      ctxRef.current.resume();
      if (currentTrackId) setPlaying(true);
    }
  }, [currentTrackId]);

  const currentTrack = TRACKS.find((t) => t.id === currentTrackId);

  return (
    <div style={styles.container}>
      {/* Header — click to collapse */}
      <div style={styles.header} onClick={() => setCollapsed((c) => !c)}>
        <span style={styles.headerLabel}>
          <Volume2 size={12} style={{ marginRight: 6, opacity: 0.7 }} />
          MUSIC
        </span>
        <span style={styles.collapseIcon}>{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div style={styles.body}>
          {/* Track buttons */}
          <div style={styles.trackGrid}>
            {TRACKS.map((track) => {
              const isActive = currentTrackId === track.id;
              return (
                <button
                  key={track.id}
                  onClick={() => playTrack(track)}
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
          {currentTrack && (
            <div style={styles.nowPlaying}>
              Now playing: {currentTrack.emoji} {currentTrack.name}
            </div>
          )}

          {/* Controls row */}
          <div style={styles.controls}>
            <button
              style={styles.controlBtn}
              onClick={handlePauseResume}
              title={playing ? 'Pause' : 'Resume'}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              style={styles.controlBtn}
              onClick={handleStop}
              title="Stop"
              disabled={!currentTrackId}
            >
              <Square size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Styles ───────────────────────────────────────────── */

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
