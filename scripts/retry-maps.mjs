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

const RETRY_MAPS = [
  { filename: 'goblin-camp.png', ratio: '1:1', prompt: 'Top-down fantasy battle map of a forest clearing campsite, small canvas tents around a central campfire, wooden fences, dirt paths, fallen logs and boulders for cover, surrounded by dense pine forest, warm orange firelight, fantasy RPG style, digital painting, no text, no UI, high detail' },
  { filename: 'underdark-cavern.png', ratio: '4:3', prompt: 'Top-down fantasy battle map of a vast underground cavern, purple and blue stone walls, glowing cyan mushrooms and fungi, pools of luminescent blue water, stone bridges over deep chasms, crystal formations, mysterious underground atmosphere, fantasy RPG style, digital painting, no text, no UI, high detail' },
  { filename: 'druid-grove.png', ratio: '1:1', prompt: 'Top-down fantasy battle map of a peaceful sacred forest grove, ancient standing stones in a circle, massive oak trees with twisted roots, wildflowers and ferns, clear stream, dappled sunlight through canopy, stone altar, lush green and gold, nature sanctuary atmosphere, fantasy RPG style, digital painting, no text, no UI, high detail' },
  { filename: 'moonrise-towers.png', ratio: '1:1', prompt: 'Top-down fantasy battle map of a dark stone castle courtyard, cracked flagstone floor, tall towers at corners, iron gates, purple cloth banners, green glowing lanterns, broken columns and rubble, mysterious arcane circle in center, dark gothic fantasy atmosphere, digital painting, no text, no UI, high detail' },
  { filename: 'nautiloid-wreck.png', ratio: '4:3', prompt: 'Top-down fantasy battle map of a crashed alien organic ship wreckage, curved purple and red ribbed walls, strange bio-mechanical corridors, unusual organic pods, scattered debris, small fires, otherworldly science-fantasy atmosphere, digital painting, no text, no UI, high detail' },
  { filename: 'grymforge.png', ratio: '4:3', prompt: 'Top-down fantasy battle map of an ancient dwarven forge and foundry, massive stone architecture with carved runes, channels of bright orange molten metal, stone bridges, large anvils and workstations, warm orange glow contrasting cool grey stone, industrial fantasy atmosphere, digital painting, no text, no UI, high detail' },
];

async function gen(prompt, ratio) {
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t.substring(0, 200)}`);
  }
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) {
    return Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
  }
  throw new Error('No image data');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < RETRY_MAPS.length; i++) {
    const m = RETRY_MAPS[i];
    const fp = path.join(OUT, m.filename);
    if (fs.existsSync(fp)) {
      console.log(`[${i + 1}] ${m.filename} exists, skip`);
      continue;
    }
    console.log(`[${i + 1}/${RETRY_MAPS.length}] ${m.filename}...`);
    try {
      const img = await gen(m.prompt, m.ratio);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
    }
    if (i < RETRY_MAPS.length - 1) await sleep(5000);
  }
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png'));
  console.log(`\nTotal maps: ${files.length}/15`);
}

main();
