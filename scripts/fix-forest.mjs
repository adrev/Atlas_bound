import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'REDACTED_API_KEY';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const prompt = 'Top-down 2D game map of a dense enchanted forest area, looking straight down from above, dark green grass ground, many round tree canopies of different sizes scattered densely across the map, some fallen logs, thick bushes and undergrowth patches, a small mossy clearing in the center, rocks and boulders, narrow winding dirt paths between trees, forest floor covered in leaves, D&D RPG battle map with square grid lines visible, completely flat 2D overhead view, absolutely no text anywhere, no labels, no writing, no words, NOT isometric, NOT 3D, clean digital art, no people';

async function main() {
  console.log('Generating dense-forest.png...');
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } }),
  });
  if (!resp.ok) { console.log('FAIL:', (await resp.text()).substring(0, 200)); return; }
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) {
    const buf = Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
    fs.writeFileSync(path.join(OUT, 'dense-forest.png'), buf);
    console.log(`OK (${Math.round(buf.length / 1024)} KB)`);
  } else { console.log('No image data'); }
}
main();
