import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'REDACTED_API_KEY';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const FIX_MAPS = [
  {
    filename: 'last-light-inn.png',
    ratio: '4:3',
    prompt: 'Detailed top-down overhead view digital illustration of a fantasy medieval fortified inn building interior layout, stone walls and wooden upper floor, main common room with stone fireplace and wooden dining tables and chairs, long bar counter with barrels behind it, guest bedrooms with beds along one wall, an attached horse stable area, a small courtyard with a stone water well, wooden defensive fence surrounding the property, warm candlelight glowing from windows, RPG battle map style, isometric overhead perspective, digital art, high detail, no people, no text'
  },
  {
    filename: 'cathedral-lathander.png',
    ratio: '4:3',
    prompt: 'Detailed top-down overhead view digital illustration of a grand fantasy medieval cathedral interior layout, polished white marble floor with golden mosaic patterns, symmetrical rows of dark wooden pews on each side of a central aisle, ornate golden altar at the far end on a raised platform, tall stone columns supporting the ceiling, side chapel alcoves with prayer benches, golden candelabras throughout, colorful light patterns on the floor from stained glass windows above, sacred holy atmosphere, RPG battle map style, isometric overhead perspective, digital art, high detail, no people, no text'
  },
];

async function gen(prompt, ratio) {
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t.substring(0, 300)}`);
  }
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) {
    return Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
  }
  throw new Error('No image data');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < FIX_MAPS.length; i++) {
    const m = FIX_MAPS[i];
    const fp = path.join(OUT, m.filename);
    if (fs.existsSync(fp)) {
      console.log(`${m.filename} already exists, skip`);
      continue;
    }
    console.log(`Generating ${m.filename}...`);
    try {
      const img = await gen(m.prompt, m.ratio);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
    }
    if (i < FIX_MAPS.length - 1) await sleep(5000);
  }
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png'));
  console.log(`\nTotal maps: ${files.length}/15`);
}

main();
