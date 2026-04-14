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
fs.mkdirSync(OUT, { recursive: true });

// Common suffix to enforce flat top-down grid-ready battle map style
const SUFFIX = ', flat top-down birds-eye view looking straight down, D&D tabletop RPG battle map, visible square grid overlay, flat 2D map style, no perspective, no 3D, no isometric, no people, no characters, no text, no labels, high detail, clean digital illustration';

const MAPS = [
  {
    filename: 'goblin-camp.png', ratio: '1:1',
    prompt: 'Forest clearing with a makeshift camp, ring of wooden spike fences, six small canvas tents arranged in a circle around a central stone campfire pit, dirt paths between tents, fallen logs and large boulders scattered around for cover, dense dark green pine forest surrounding the clearing' + SUFFIX,
  },
  {
    filename: 'underdark-cavern.png', ratio: '4:3',
    prompt: 'Underground cave system with dark purple-blue stone floor, multiple cavern chambers connected by narrow passages, glowing cyan bioluminescent mushroom clusters along the walls, two pools of luminous blue water, a stone bridge crossing over a dark chasm in the center, purple crystal formations in corners' + SUFFIX,
  },
  {
    filename: 'druid-grove.png', ratio: '1:1',
    prompt: 'A sacred forest clearing, circle of twelve standing stones on green grass in the center, a stone altar in the middle of the stone circle, four massive ancient oak trees in the corners with large root systems, a winding blue stream running from top-left to bottom-right, wildflowers and ferns scattered around, dappled sunlight on the grass' + SUFFIX,
  },
  {
    filename: 'moonrise-towers.png', ratio: '1:1',
    prompt: 'Dark stone fortress courtyard viewed from above, thick castle walls forming a square perimeter, four round guard towers at the corners, a large iron portcullis gate on the south wall, cracked dark stone floor tiles, a glowing blue arcane ritual circle in the center of the courtyard, rubble piles near the walls, green-glowing wall-mounted lanterns, purple banners hanging from walls' + SUFFIX,
  },
  {
    filename: 'nautiloid-wreck.png', ratio: '4:3',
    prompt: 'Crashed organic alien spaceship interior seen from above, curved ribbed walls in dark purple and red forming interconnected rooms and corridors, strange pod-like chambers, scattered debris and small fire patches, bio-mechanical door frames, a large central chamber with a damaged control throne, organic tentacle-like wall structures' + SUFFIX,
  },
  {
    filename: 'grymforge.png', ratio: '4:3',
    prompt: 'Ancient underground dwarven forge complex, multiple stone platforms and rooms separated by channels of bright orange-red flowing lava, stone bridges crossing over the lava channels, large anvils and forge workstations on the platforms, carved stone pillars with dwarven rune decorations, stairs connecting different elevation levels, grey stone contrasting with orange lava glow' + SUFFIX,
  },
  {
    filename: 'forest-road-ambush.png', ratio: '16:9',
    prompt: 'A long narrow dirt road running horizontally through a dense forest, fallen tree trunks blocking sections of the road, an overturned wooden cart in the middle of the road, thick green bushes and undergrowth along both sides of the road providing hiding spots, tall pine trees with visible trunks on both sides, scattered rocks and logs as cover positions' + SUFFIX,
  },
  {
    filename: 'zhentarim-hideout.png', ratio: '1:1',
    prompt: 'Underground stone dungeon hideout floor plan, a large central room with a long wooden meeting table, six smaller rooms branching off connected by corridors, stone walls separating each room, wooden crates and barrels in storage rooms, weapon racks on walls, a small underground water dock area at the bottom edge with a wooden boat, torch sconces on walls providing warm light pools' + SUFFIX,
  },
  {
    filename: 'elfsong-tavern.png', ratio: '4:3',
    prompt: 'Interior floor plan of a medieval fantasy tavern, warm brown wooden plank floor, a long L-shaped bar counter along the left wall with bar stools, round wooden tables with chairs scattered across the main floor, a large stone fireplace on the back wall, wooden staircase leading up in the corner, barrels and shelving behind the bar, candle light on each table' + SUFFIX,
  },
  {
    filename: 'last-light-inn.png', ratio: '4:3',
    prompt: 'Medieval fantasy inn and courtyard floor plan viewed from above, stone building with multiple rooms: a main common room with fireplace and dining tables, a bar counter, four small guest bedrooms each with a bed, an attached stable area with horse stalls on the right side, a courtyard with a stone well in the center, wooden palisade fence surrounding the property, two entrance gates' + SUFFIX,
  },
  {
    filename: 'cathedral-lathander.png', ratio: '4:3',
    prompt: 'Grand medieval cathedral interior floor plan, white and gold marble tiled floor with decorative patterns, rows of wooden pews on both sides of a wide central aisle, an ornate golden altar on a raised platform at the far end, tall stone columns in two rows supporting the ceiling, small side chapel alcoves along the walls, golden candelabras throughout, warm golden lighting' + SUFFIX,
  },
  {
    filename: 'wine-cellar.png', ratio: '4:3',
    prompt: 'Stone underground wine cellar floor plan, arched stone walls and support columns creating three connected chambers, rows of large wooden wine barrels stacked against the walls, wooden crates and smaller barrels scattered on the floor, a stone staircase in one corner leading upward, cobblestone floor with small puddles, dim lantern light from wall sconces, spider webs in dark corners' + SUFFIX,
  },
  {
    filename: 'apothecary-shop.png', ratio: '1:1',
    prompt: 'Small fantasy apothecary shop interior floor plan, wooden plank floor, shelving units lining all four walls filled with colorful potion bottles and jars, a central wooden worktable with mortar and pestle and alchemical equipment, a large iron cauldron in one corner with green bubbling liquid, a shop counter near the entrance door, a small back storage room, dried herbs hanging from ceiling beams' + SUFFIX,
  },
  {
    filename: 'camp-long-rest.png', ratio: '1:1',
    prompt: 'Nighttime wilderness campsite clearing, a stone-ringed campfire in the center with warm orange glow, six bedrolls arranged in a circle around the fire, a small canvas tent, backpacks and adventuring gear near the bedrolls, a fallen log used as a bench, dense dark forest trees surrounding the clearing in a circle, a small stream running along one edge, starry dark sky' + SUFFIX,
  },
  {
    filename: 'merchant-quarter.png', ratio: '1:1',
    prompt: 'Medieval town marketplace square viewed from above, grey cobblestone streets, a circular stone fountain in the center, colorful market stalls with striped fabric canopy roofs arranged around the fountain, shop building fronts along all four edges, wooden barrels and crate displays, a town notice board, street lanterns on posts, narrow alleyways between buildings at the corners' + SUFFIX,
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
  console.log(`Generating ${MAPS.length} top-down grid battle maps...`);
  let success = 0;

  for (let i = 0; i < MAPS.length; i++) {
    const m = MAPS[i];
    const fp = path.join(OUT, m.filename);
    if (fs.existsSync(fp)) {
      console.log(`[${i + 1}/${MAPS.length}] ${m.filename} - exists, skipping`);
      success++;
      continue;
    }
    console.log(`[${i + 1}/${MAPS.length}] ${m.filename}...`);
    try {
      const img = await gen(m.prompt, m.ratio);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
      success++;
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
    }
    if (i < MAPS.length - 1) await sleep(4000);
  }
  console.log(`\nDone: ${success}/${MAPS.length} maps`);
}

main();
