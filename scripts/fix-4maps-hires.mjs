import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY before running this script.');
}
const URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const SUFFIX = '. Perfectly flat top-down 2D view, as if photographed from directly above at 90 degrees. No walls visible from the side, no 3D perspective, no isometric angle. Realistic fantasy painting with rich textures, high detail, no people, no text, no labels, no grid lines, D&D battle map style';

const MAPS = [
  { file: 'merchant-quarter.png', ratio: '1:1', prompt: 'A medieval town marketplace viewed from directly above like a satellite photo, grey cobblestone ground, round stone fountain in center, colorful market stall canopy rooftops arranged around the fountain, building rooftops along edges, wooden barrels and crates on ground' + SUFFIX },
  { file: 'wine-cellar.png', ratio: '4:3', prompt: 'An underground wine cellar floor viewed from directly above, grey stone tile floor, rows of round wooden barrel tops against walls, wooden crates scattered on floor, stone pillar circles in grid, staircase opening in corner, puddles, torch light circles' + SUFFIX },
  { file: 'grymforge.png', ratio: '4:3', prompt: 'An ancient dwarven forge viewed from directly above, grey stone platforms separated by bright orange lava channels, stone bridges crossing lava, large anvil shapes and forge equipment on platforms, round stone pillars with rune patterns' + SUFFIX },
  { file: 'moonrise-towers.png', ratio: '1:1', prompt: 'A dark castle courtyard viewed from directly above, dark grey cracked stone floor, glowing blue magical circle in center, rubble piles near edges, round tower circles at four corners seen from above, dark atmosphere' + SUFFIX },
];

async function gen(prompt, ratio) {
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) return Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
  throw new Error('No image');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let i = 0; i < MAPS.length; i++) {
  const m = MAPS[i];
  const fp = path.join(OUT, m.file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  console.log(`[${i+1}/${MAPS.length}] ${m.file} (Imagen 4.0 hi-res)...`);
  try {
    const img = await gen(m.prompt, m.ratio);
    fs.writeFileSync(fp, img);
    console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
  }
  if (i < MAPS.length - 1) await sleep(3000);
}
console.log('Done');
