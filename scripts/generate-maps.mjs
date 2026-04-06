#!/usr/bin/env node
/**
 * Generate battle map images for D&D VTT using Google Gemini Imagen API.
 * Run: npx tsx scripts/generate-maps.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'client', 'public', 'maps');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const API_KEY = 'AIzaSyAX4yOSVOghzkMLG26tKdDUXnjqqnDINYc';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;

const MAPS = [
  { filename: 'goblin-camp.png', ratio: '1:1', prompt: 'Top-down battle map of a forest clearing with a goblin camp, scattered makeshift tents made of animal hides, a central campfire with orange glow, wooden spikes around the perimeter, fallen logs and rocks for cover, dirt paths between tents, dark green pine forest surrounding the clearing, warm firelight illuminating the center, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'underdark-cavern.png', ratio: '4:3', prompt: 'Top-down battle map of a vast underground Underdark cavern, dark purple and blue stone walls, bioluminescent fungi and mushrooms glowing cyan and teal, pools of glowing blue water, stalactite shadows, narrow stone bridges over dark chasms, scattered crystals, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'druid-grove.png', ratio: '1:1', prompt: 'Top-down battle map of a sacred druid grove, ancient stone circle with moss-covered standing stones, massive ancient oak trees with gnarled roots, carpet of wildflowers and ferns, a small clear stream, soft dappled sunlight, natural stone altar in center, fairy lights and fireflies, lush green and gold colors, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'moonrise-towers.png', ratio: '1:1', prompt: 'Top-down battle map of a dark gothic fortress courtyard, cracked stone floor with arcane symbols, shadowy towers casting long shadows, iron gates and portcullis, dark purple banners, eerie green magical torches, rubble and broken columns, central dark altar, ominous atmosphere, Baldur\'s Gate 3 inspired, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'nautiloid-wreck.png', ratio: '4:3', prompt: 'Top-down battle map of a crashed mind flayer nautiloid ship, organic alien architecture with curved ribbed walls in purple and dark red, bio-mechanical corridors, pulsing tentacle-like structures, burning wreckage, strange organic pods, debris scattered around crash site, otherworldly atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'grymforge.png', ratio: '4:3', prompt: 'Top-down battle map of an ancient dwarven forge complex, massive stone architecture with carved dwarven runes, channels of flowing molten lava glowing orange and red, stone bridges over lava rivers, enormous anvils and forging stations, warm orange and red lighting contrasting with cool grey stone, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'forest-road-ambush.png', ratio: '16:9', prompt: 'Top-down battle map of a narrow forest road perfect for an ambush, dirt path winding through dense woodland, fallen trees blocking the road, thick bushes providing cover, an overturned merchant cart, tall pine and oak trees casting shadows, morning mist, realistic forest floor with leaves and roots, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'zhentarim-hideout.png', ratio: '1:1', prompt: 'Top-down battle map of an underground smugglers den, hewn stone rooms connected by narrow corridors, central meeting room with large table, crates and barrels of stolen goods, dim torchlight, weapon racks and stolen treasure, small underground dock at one edge, criminal underworld atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'elfsong-tavern.png', ratio: '4:3', prompt: 'Top-down battle map of a cozy fantasy tavern interior, warm wooden floors and walls, long bar counter with stools, round tables and chairs, large stone fireplace with fire, stairs to second floor balcony, kegs and bottles behind bar, warm golden candlelight, small stage area, cozy inviting atmosphere, Baldur\'s Gate inspired, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'last-light-inn.png', ratio: '4:3', prompt: 'Top-down battle map of a fortified roadside inn, two-story building with stone walls, main common room with fireplace and dining tables, bar area, guest rooms with beds, attached stable for horses, small courtyard with well, defensive wooden palisade, warm interior lighting, safe haven atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'cathedral-lathander.png', ratio: '4:3', prompt: 'Top-down battle map of a grand cathedral interior, polished marble floors with mosaic patterns, rows of wooden pews leading to ornate golden altar, stained glass windows casting colorful light on floor, stone pillars, side chapels with prayer alcoves, candelabras and holy symbols, warm golden light, divine sacred atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'wine-cellar.png', ratio: '4:3', prompt: 'Top-down battle map of a medieval wine cellar, stone brick walls and arched ceiling supports, rows of large wooden wine barrels, wooden crates, narrow staircase leading up, cobblestone floor with puddles, dim lantern light, spider webs, tight corridors between barrel rows, cool damp atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'apothecary-shop.png', ratio: '1:1', prompt: 'Top-down battle map of a cluttered fantasy apothecary shop, wooden shelving with colorful potion bottles, central worktable with alchemical equipment, dried herbs hanging from ceiling, small counter near entrance, back room with storage, bubbling cauldron, magical ingredients glowing faintly, cozy mysterious atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'camp-long-rest.png', ratio: '1:1', prompt: 'Top-down battle map of a wilderness campsite at night, warm central campfire with orange glow, bedrolls in a circle around fire, small tent, backpacks and adventuring gear, cooking pot over fire, fallen log seating, surrounding dark forest, starry night sky reflected in nearby stream, warm safe circle in wilderness darkness, peaceful atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
  { filename: 'merchant-quarter.png', ratio: '1:1', prompt: 'Top-down battle map of a medieval town square marketplace, cobblestone streets and central stone fountain, colorful market stalls with fabric awnings, shops lining edges, barrels and crates of goods, town notice board, flower planters and street lanterns, narrow alleyways between buildings, warm afternoon sunlight, lively commercial atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting' },
];

async function generateImage(prompt, aspectRatio) {
  const payload = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio },
  };

  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 300)}`);
  }

  const body = await resp.json();
  const predictions = body.predictions || [];
  if (predictions.length > 0 && predictions[0].bytesBase64Encoded) {
    return Buffer.from(predictions[0].bytesBase64Encoded, 'base64');
  }
  throw new Error('No image data in response');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Generating ${MAPS.length} battle maps using Gemini Imagen...`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  let success = 0;

  for (let i = 0; i < MAPS.length; i++) {
    const m = MAPS[i];
    const filepath = path.join(OUTPUT_DIR, m.filename);

    if (fs.existsSync(filepath)) {
      console.log(`[${i + 1}/${MAPS.length}] ${m.filename} - already exists, skipping`);
      success++;
      continue;
    }

    console.log(`[${i + 1}/${MAPS.length}] Generating ${m.filename}...`);
    try {
      const imgData = await generateImage(m.prompt, m.ratio);
      fs.writeFileSync(filepath, imgData);
      console.log(`  Saved (${Math.round(imgData.length / 1024)} KB)`);
      success++;
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }

    // Rate limit
    if (i < MAPS.length - 1) {
      await sleep(3000);
    }
  }

  console.log(`\nDone: ${success}/${MAPS.length} maps generated`);
}

main().catch(console.error);
