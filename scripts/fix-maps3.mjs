import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'REDACTED_API_KEY';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const MAPS = [
  {
    filename: 'wine-cellar.png',
    ratio: '4:3',
    prompt: 'Top-down 2D game map of a stone wine cellar basement, looking straight down from above like a floor plan, grey stone tile floor, thick stone walls forming a rectangular room, rows of large brown wooden barrels lined up against the top and left walls, wooden crates and smaller barrels scattered on the floor, four stone support pillars in a grid pattern, a stone staircase in the corner, small water puddles on the floor, warm torch light from wall sconces, D&D RPG battle map with square grid lines visible, completely flat 2D overhead view, NOT isometric, NOT 3D, no walls visible from the side, no depth, clean digital art, no people, no text'
  },
  {
    filename: 'dense-forest.png',
    ratio: '1:1',
    prompt: 'Top-down 2D game map of a dense forest area, looking straight down from above, green grass ground with dirt patches, many tree canopies of various sizes scattered across the map in clusters, some fallen logs on the ground, patches of bushes and undergrowth, a small clearing in the center, mushroom rings, rocks and boulders scattered about, narrow winding dirt paths between the trees, forest floor with leaves and moss, D&D RPG battle map with square grid lines visible, completely flat 2D overhead view, NOT isometric, NOT 3D, clean digital art, no people, no text'
  },
  {
    filename: 'long-road.png',
    ratio: '16:9',
    prompt: 'Top-down 2D game map of a long dirt road stretching horizontally across the entire image from left edge to right edge, looking straight down from above, wide brown dirt road with cart wheel tracks, green grassy fields on both sides of the road, scattered trees and bushes along the roadside, a stone mile marker on the road, a small wooden bridge over a stream crossing the road in the middle, rolling hills texture in the grass, wildflowers along the road edges, D&D RPG battle map with square grid lines visible, completely flat 2D overhead view, NOT isometric, NOT 3D, clean digital art, no people, no text'
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
  for (let i = 0; i < MAPS.length; i++) {
    const m = MAPS[i];
    const fp = path.join(OUT, m.filename);
    if (fs.existsSync(fp)) { console.log(`${m.filename} exists, skip`); continue; }
    console.log(`Generating ${m.filename}...`);
    try {
      const img = await gen(m.prompt, m.ratio);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
    } catch (e) { console.log(`  FAIL: ${e.message}`); }
    if (i < MAPS.length - 1) await new Promise(r => setTimeout(r, 4000));
  }
}
main();
