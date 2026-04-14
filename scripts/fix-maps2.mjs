import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY before running this script.');
}
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const MAPS = [
  {
    filename: 'apothecary-shop.png',
    ratio: '1:1',
    prompt: 'Flat top-down overhead map of a small fantasy potion shop interior, square room with wooden plank floor, tall wooden shelving units along all four walls filled with rows of colorful glass bottles and jars, a large rectangular wooden worktable in the center covered with alchemy equipment and flasks, a big black iron cauldron in one corner with green liquid, a wooden shop counter near the entrance door on the bottom wall, a small back storage room behind a doorway on the top wall, dried herb bundles hanging from ceiling, flat top-down birds-eye view looking straight down, D&D tabletop RPG battle map, visible square grid overlay, flat 2D map style, no perspective, no 3D, no isometric, no people, no animals, no faces, no text, no labels, high detail, clean digital illustration'
  },
  {
    filename: 'wine-cellar.png',
    ratio: '4:3',
    prompt: 'Flat top-down overhead map of an underground stone wine cellar, rectangular room with grey cobblestone floor, thick stone walls, three arched alcoves along the top wall each filled with rows of horizontal wooden barrels, wooden crates and smaller barrels stacked in clusters on the floor, a stone staircase in the top-right corner leading upward, stone support pillars in the room, small puddles of water on the floor, wall-mounted torch sconces casting warm light circles, flat top-down birds-eye view looking straight down, D&D tabletop RPG battle map, visible square grid overlay, flat 2D map style, no perspective, no 3D, no isometric, no people, no animals, no faces, no text, no labels, high detail, clean digital illustration'
  },
];

async function gen(prompt, ratio) {
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) return Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
  throw new Error('No image data');
}

async function main() {
  for (const m of MAPS) {
    const fp = path.join(OUT, m.filename);
    if (fs.existsSync(fp)) { console.log(`${m.filename} exists, skip`); continue; }
    console.log(`Generating ${m.filename}...`);
    try {
      const img = await gen(m.prompt, m.ratio);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
    } catch (e) { console.log(`  FAIL: ${e.message}`); }
    await new Promise(r => setTimeout(r, 4000));
  }
}
main();
