#!/usr/bin/env node
/**
 * Generate 3 test maps using Google Gemini Imagen API.
 * These are the story-ready maps from our Phase B plan — testing Gemini
 * quality before committing to the full set.
 *
 * Run: GEMINI_API_KEY=... node scripts/generate-test-maps.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'tmp-gemini-maps');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY before running this script.');
}

const URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;

// Story-ready spec: clear entry point, branching paths, natural cover, focal point.
// Style anchor: matches Druid Grove / Cathedral of Lathander aesthetic (hand-drawn fantasy, top-down).
const MAPS = [
  {
    filename: 'forest-fork.png',
    ratio: '16:9',
    prompt: `Top-down battle map, hand-drawn fantasy RPG style with rich natural colors. A forest path enters from the south edge of the map (clear entry point for adventurers) and splits into two distinct paths at the center: one branch curves northwest leading deeper into dense dark pine forest with twisted roots and mossy boulders, the other branch curves northeast leading toward a sunlit clearing with an ancient mossy stone shrine partially overgrown. Between the paths: a small babbling stream with a simple wooden footbridge, scattered boulders providing tactical cover, fallen logs, wildflowers, varying tree densities for sightlines. Soft natural lighting with dappled shadows through canopy. NO TEXT, NO UI, NO LABELS, no grid overlay, no watermark. High detail digital painting, top-down perspective straight down, suitable for D&D virtual tabletop.`,
  },
  {
    filename: 'crossroads-inn.png',
    ratio: '4:3',
    prompt: `Top-down battle map, hand-drawn fantasy RPG style. A two-story wooden-and-stone fantasy inn sits at the center of a four-way crossroads. Four dirt roads radiate out from the inn in cardinal directions (north, south, east, west) — each road extends to the map edge, giving adventurers clear entry points from any side. The inn has a thatched roof with stone chimney, small outdoor garden with wooden tables and lanterns, a horse stable attached to the east side, a well with bucket in the courtyard, wooden fence perimeter with a main gate facing south. Surrounding the inn: small grassy fields, scattered trees, wooden signposts at each road, warm glowing windows suggesting evening. Warm earthy color palette with golden firelight from windows. NO TEXT, NO UI, NO LABELS, no grid overlay, no watermark. High detail digital painting, strict top-down perspective looking straight down, suitable for D&D virtual tabletop.`,
  },
  {
    filename: 'ruined-keep-entrance.png',
    ratio: '4:3',
    prompt: `Top-down battle map, hand-drawn fantasy RPG style, dark atmospheric palette. A weathered stone road winds from the south edge of the map (clear entry point) up to a crumbling fortress gate in the north. The ancient stone keep's broken portcullis and half-collapsed walls are the central focal point. Scattered details for tactical play: large fallen stone blocks providing cover, a half-ruined watchtower on the west side with broken stairs leading up, dying torches in rusted brackets, overgrown weeds breaking through flagstones, old siege rubble and broken carts, a partially filled moat with a narrow plank bridge, exposed dungeon entrance visible behind the gate implying depth. Overcast daylight, muted greys and earthy browns with hints of moss green. NO TEXT, NO UI, NO LABELS, no grid overlay, no watermark. High detail digital painting, strict top-down perspective, suitable for D&D virtual tabletop.`,
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
  console.log(`Generating ${MAPS.length} story-ready test maps...`);
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
