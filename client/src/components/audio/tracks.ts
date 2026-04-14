/* ──────────────────────────────────────────────────────────
   Ambient soundscape generator using the Web Audio API.
   Each "track" is a procedural soundscape built from
   oscillators, filters, and gain nodes. No external audio
   files required.
   ────────────────────────────────────────────────────────── */

export interface Track {
  id: string;
  name: string;
  emoji: string;
  /** Builder function: creates the audio graph, returns a cleanup fn */
  build: (ctx: AudioContext, dest: GainNode) => () => void;
}

// -- Helpers ------------------------------------------------

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

// -- Track definitions --------------------------------------

export const TRACKS: Track[] = [
  {
    id: 'tavern',
    name: 'Tavern',
    emoji: '\uD83C\uDF7A',
    build(ctx, dest) {
      const nodes = [
        pad(ctx, dest, 220, 'triangle', 0.12),
        pad(ctx, dest, 277, 'triangle', 0.08),
        pad(ctx, dest, 330, 'sine', 0.07),
        pad(ctx, dest, 440, 'sine', 0.04),
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
    emoji: '\u2694\uFE0F',
    build(ctx, dest) {
      const nodes = [
        pad(ctx, dest, 55, 'sawtooth', 0.12),
        pad(ctx, dest, 82.5, 'square', 0.05),
        pad(ctx, dest, 110, 'sawtooth', 0.06),
      ];
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
    emoji: '\uD83E\uDDED',
    build(ctx, dest) {
      const freqs = [261.6, 329.6, 392, 523.3];
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
    emoji: '\uD83D\uDD2E',
    build(ctx, dest) {
      const nodes = [
        pad(ctx, dest, 146.8, 'sine', 0.1),
        pad(ctx, dest, 174.6, 'triangle', 0.06),
        pad(ctx, dest, 207.7, 'sine', 0.05),
        pad(ctx, dest, 293.7, 'sine', 0.03),
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
    emoji: '\uD83D\uDC79',
    build(ctx, dest) {
      const nodes = [
        pad(ctx, dest, 41.2, 'sawtooth', 0.14),
        pad(ctx, dest, 82.4, 'square', 0.06),
        pad(ctx, dest, 123.5, 'sawtooth', 0.04),
        pad(ctx, dest, 155.6, 'triangle', 0.05),
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
    emoji: '\uD83C\uDF3F',
    build(ctx, dest) {
      const nodes = [
        pad(ctx, dest, 196, 'sine', 0.08),
        pad(ctx, dest, 246.9, 'sine', 0.06),
        pad(ctx, dest, 293.7, 'triangle', 0.04),
        pad(ctx, dest, 370, 'sine', 0.03),
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
    emoji: '\uD83C\uDFDA\uFE0F',
    build(ctx, dest) {
      const nodes = [
        pad(ctx, dest, 55, 'sawtooth', 0.08),
        pad(ctx, dest, 58, 'sine', 0.06),
      ];
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
    emoji: '\u26C8\uFE0F',
    build(ctx, dest) {
      const n = noise(ctx, dest, 0.08);
      n.filter.type = 'bandpass';
      n.filter.frequency.value = 500;
      (n.filter.Q as AudioParam).value = 1;
      const windLfo = lfo(ctx, 0.07, n.filter.frequency, 300);
      const volLfo = lfo(ctx, 0.12, n.gain.gain, 0.04);
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
