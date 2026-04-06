import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'AIzaSyAX4yOSVOghzkMLG26tKdDUXnjqqnDINYc';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const prompt = 'A flat top-down overhead map of a magical forest clearing with a stone circle, twelve grey standing stones arranged in a perfect circle on bright green grass, a flat stone altar slab in the center, four enormous ancient oak tree canopies in the four corners with visible thick roots spreading outward, a winding blue stream crossing from upper-left to lower-right with stepping stones, patches of colorful wildflowers and ferns scattered on the grass, soft green and gold tones, flat top-down birds-eye view looking straight down, D&D tabletop RPG battle map, visible square grid overlay, flat 2D map style, no perspective, no 3D, no isometric, no people, no characters, no faces, no text, no labels, high detail, clean digital illustration';

async function main() {
  console.log('Generating druid-grove.png...');
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } }),
  });
  if (!resp.ok) { console.log('FAIL:', (await resp.text()).substring(0, 200)); return; }
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) {
    const buf = Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
    fs.writeFileSync(path.join(OUT, 'druid-grove.png'), buf);
    console.log(`OK (${Math.round(buf.length / 1024)} KB)`);
  } else {
    console.log('No image data');
  }
}
main();
