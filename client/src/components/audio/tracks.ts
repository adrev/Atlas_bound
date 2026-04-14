/* ──────────────────────────────────────────────────────────
   Music tracks hosted on Google Cloud Storage.
   Each theme has multiple tracks that shuffle automatically.
   ────────────────────────────────────────────────────────── */

const CDN = 'https://storage.googleapis.com/atlas-bound-data/music';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * Derive a human-readable display name from a CDN filename.
 * e.g. "tavern-01.mp3" → "Tavern I", "combat-03-bis.mp3" → "Combat III (Alt)"
 */
export function getTrackFileName(url: string): string {
  const filename = url.split('/').pop() ?? '';
  const match = filename.match(/^(.+?)-(\d+)(-bis)?\.mp3$/);
  if (!match) return filename;
  const [, rawTheme, numStr, bis] = match;
  const theme = rawTheme
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const num = parseInt(numStr, 10);
  const roman = ROMAN[num - 1] ?? String(num);
  return `${theme} ${roman}${bis ? ' (Alt)' : ''}`;
}

export interface Track {
  id: string;
  name: string;
  emoji: string;
  /** MP3 URLs for this theme — the engine shuffles through them */
  files: string[];
}

export const TRACKS: Track[] = [
  {
    id: 'tavern',
    name: 'Tavern',
    emoji: '🍺',
    files: [
      `${CDN}/tavern-01.mp3`,
      `${CDN}/tavern-01-bis.mp3`,
      `${CDN}/tavern-02.mp3`,
      `${CDN}/tavern-02-bis.mp3`,
      `${CDN}/tavern-03.mp3`,
      `${CDN}/tavern-03-bis.mp3`,
    ],
  },
  {
    id: 'combat',
    name: 'Combat',
    emoji: '⚔️',
    files: [
      `${CDN}/combat-01.mp3`,
      `${CDN}/combat-01-bis.mp3`,
      `${CDN}/combat-02.mp3`,
      `${CDN}/combat-02-bis.mp3`,
      `${CDN}/combat-03.mp3`,
      `${CDN}/combat-03-bis.mp3`,
      `${CDN}/combat-04.mp3`,
      `${CDN}/combat-04-bis.mp3`,
    ],
  },
  {
    id: 'exploration',
    name: 'Exploration',
    emoji: '🌲',
    files: [
      `${CDN}/exploration-01.mp3`,
      `${CDN}/exploration-01-bis.mp3`,
      `${CDN}/exploration-02.mp3`,
      `${CDN}/exploration-02-bis.mp3`,
      `${CDN}/exploration-03.mp3`,
      `${CDN}/exploration-03-bis.mp3`,
    ],
  },
  {
    id: 'mystery',
    name: 'Mystery',
    emoji: '🔮',
    files: [
      `${CDN}/mystery-01.mp3`,
      `${CDN}/mystery-01-bis.mp3`,
      `${CDN}/mystery-02.mp3`,
      `${CDN}/mystery-02-bis.mp3`,
    ],
  },
  {
    id: 'bossfight',
    name: 'Boss Fight',
    emoji: '👹',
    files: [
      `${CDN}/boss-fight-01.mp3`,
      `${CDN}/boss-fight-01-bis.mp3`,
      `${CDN}/boss-fight-02.mp3`,
      `${CDN}/boss-fight-02-bis.mp3`,
    ],
  },
  {
    id: 'peaceful',
    name: 'Peaceful',
    emoji: '🌸',
    files: [
      `${CDN}/peaceful-01.mp3`,
      `${CDN}/peaceful-01-bis.mp3`,
      `${CDN}/peaceful-02.mp3`,
      `${CDN}/peaceful-02-bis.mp3`,
    ],
  },
  {
    id: 'dungeon',
    name: 'Dungeon',
    emoji: '🕯️',
    files: [
      `${CDN}/dungeon-01.mp3`,
      `${CDN}/dungeon-01-bis.mp3`,
      `${CDN}/dungeon-02.mp3`,
      `${CDN}/dungeon-02-bis.mp3`,
    ],
  },
  {
    id: 'storm',
    name: 'Storm',
    emoji: '⛈️',
    files: [
      `${CDN}/storm-01.mp3`,
      `${CDN}/storm-01-bis.mp3`,
      `${CDN}/storm-02.mp3`,
      `${CDN}/storm-02-bis.mp3`,
    ],
  },
];
