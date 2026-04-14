#!/usr/bin/env node
/**
 * Generate 3 test maps using Google Gemini Imagen API.
 * Strictly top-down VTT style (no isometric / no 3D buildings).
 *
 * Auto-loads .env from repo root. Just run:
 *   node scripts/generate-test-maps.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Minimal zero-dep .env loader (only fills vars not already set in the env)
function loadDotenv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotenv();

const OUTPUT_DIR = path.join(REPO_ROOT, 'tmp-gemini-maps');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY in .env or export it before running this script.');
}

const URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;

/**
 * Strong prefix/suffix that forces strict orthographic top-down perspective.
 * Critical when the scene contains buildings — otherwise Imagen defaults to
 * 3/4 isometric because that's what "architectural illustration" looks like
 * in its training set. Forest-only scenes don't need it as badly.
 */
const TOPDOWN_PREFIX =
  'A strictly orthographic top-down bird\'s eye view battle map for a Dungeons and Dragons virtual tabletop. ' +
  'Camera is pointed straight down at 90 degrees from directly above. ' +
  'Show ONLY roof tiles and rooftops viewed from above — NEVER show vertical walls, ' +
  'NEVER show building sides, NEVER show chimneys rising up, NEVER any 3/4 isometric perspective. ' +
  'Buildings are flat roof outlines with ridge lines. No skylines, no horizon line, no sky. ';

const TOPDOWN_SUFFIX =
  ' Hand-drawn fantasy RPG style, rich natural painterly colors, like Dungeondraft or Forgotten Adventures assets. ' +
  'Strict overhead view, roofs only, flat 2D map style. ' +
  'NO TEXT, NO WRITING, NO LABELS, NO GRID OVERLAY, NO WATERMARK, ' +
  'no tokens, no characters, no miniatures, no people, no creatures. ' +
  'NO ISOMETRIC, NO 3/4 VIEW, NO VERTICAL WALLS, NO HORIZON, NO SKY.';

const MAPS = [
  {
    filename: 'forest-fork.png',
    ratio: '16:9',
    prompt:
      TOPDOWN_PREFIX +
      'A forest battle map. Dirt path enters from the south edge and splits at the center into two branches: ' +
      'one curves to the northwest into dense dark pine forest with mossy boulders and twisted roots, ' +
      'the other curves to the northeast toward a small clearing with a low mossy stone shrine (viewed from above as a flat ring of stones). ' +
      'A narrow blue stream runs roughly north-to-south through the middle, crossed by a small wooden plank bridge at the fork. ' +
      'Scattered grey boulders, fallen tree logs (seen from above as long cylinders), ' +
      'patches of wildflowers, varying tree canopy density. Soft dappled forest lighting.' +
      TOPDOWN_SUFFIX,
  },
  {
    filename: 'crossroads-inn.png',
    ratio: '4:3',
    prompt:
      TOPDOWN_PREFIX +
      'An inn building sits at the center of a four-way dirt road crossroads. ' +
      'The inn building is visible ONLY as its thatched roof seen directly from above — a rectangular thatched roof shape ' +
      'with a visible ridge line and a single stone chimney cap flush with the roof (no vertical chimney rising up). ' +
      'Four dirt roads radiate out from the inn in four cardinal directions (north, south, east, west), each reaching the map edge. ' +
      'Around the inn, still seen from straight above: a small horse stable (flat wooden roof shape) on the east side, ' +
      'a small kitchen garden with neat rows, a stone-ringed well in the south courtyard (seen as a dark circle), ' +
      'wooden fence lines as thin dark lines, scattered trees (seen from above as circular green canopies), ' +
      'wooden signpost shapes at each road. Warm earthy grass and dirt palette.' +
      TOPDOWN_SUFFIX,
  },
  {
    filename: 'ruined-keep-entrance.png',
    ratio: '4:3',
    prompt:
      TOPDOWN_PREFIX +
      'A ruined stone keep exterior, strictly viewed as a flat floorplan from directly above. ' +
      'A stone road enters from the south edge of the map and leads north into a broken fortress gateway. ' +
      'Building walls are visible only as THICK GREY STONE LINES seen from above, NOT as standing vertical walls — ' +
      'broken rectangular outlines of collapsed rooms, a square watchtower footprint on the west with broken walls, ' +
      'the main gate drawn as a gap in the thick wall outline with broken portcullis rubble. ' +
      'Inside the keep outline: scattered fallen stone blocks as grey rectangles on stone-flagged ground, ' +
      'round torch markers, grass and weeds breaking through in green patches, ' +
      'piled siege rubble, a broken cart shape. ' +
      'A narrow plank bridge across a half-empty moat (thin blue channel) south of the gate. ' +
      'Overcast muted daylight, greys and earthy browns, moss accents.' +
      TOPDOWN_SUFFIX,
  },
];

async function generateImage(prompt, aspectRatio) {
  const payload = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio },
  };
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 500)}`);
  }
  const body = await resp.json();
  const predictions = body.predictions || [];
  if (predictions.length > 0 && predictions[0].bytesBase64Encoded) {
    return Buffer.from(predictions[0].bytesBase64Encoded, 'base64');
  }
  throw new Error('No image data in response: ' + JSON.stringify(body).substring(0, 300));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Generating ${MAPS.length} strict top-down test maps...`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  let success = 0;
  for (let i = 0; i < MAPS.length; i++) {
    const m = MAPS[i];
    const filepath = path.join(OUTPUT_DIR, m.filename);
    console.log(`[${i + 1}/${MAPS.length}] ${m.filename} (${m.ratio})...`);
    try {
      const imgData = await generateImage(m.prompt, m.ratio);
      fs.writeFileSync(filepath, imgData);
      console.log(`  ✓ Saved (${Math.round(imgData.length / 1024)} KB)`);
      success++;
    } catch (err) {
      console.log(`  ✗ FAILED: ${err.message}`);
    }
    if (i < MAPS.length - 1) await sleep(3000);
  }
  console.log(`\nDone. ${success}/${MAPS.length} maps generated.`);
  console.log(`Open: open ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
