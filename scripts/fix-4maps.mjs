import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'REDACTED_API_KEY';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro-preview:generateContent?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

// Much stronger top-down enforcement
const SUFFIX = '. This MUST be rendered as a perfectly flat top-down 2D floor plan, as if photographed by a camera mounted directly above looking straight down at 90 degrees. NO walls should be visible from the side. NO 3D perspective. NO isometric angle. Everything should appear flat like a blueprint or satellite photo. Realistic fantasy painting style with rich colors and textures, high detail, no people, no text, no labels, no grid lines';

const MAPS = [
  {
    file: 'merchant-quarter.png',
    prompt: 'A medieval town marketplace seen from directly above like a satellite image. Grey cobblestone ground fills the entire image. A round stone fountain in the exact center. Market stalls shown as rectangular colored canopy roofs viewed from above arranged around the fountain. Building rooftops along all four edges. Wooden barrels and crate clusters on the ground. No walls visible, only rooftops and ground' + SUFFIX,
  },
  {
    file: 'wine-cellar.png',
    prompt: 'An underground wine cellar floor seen from directly above like a floor plan. Grey stone tile floor filling the entire image. Large brown wooden barrel circles arranged in rows against the top and left edges. Wooden crate rectangles scattered on the floor. Four round stone pillar circles in a grid. A rectangular staircase opening in the top-right corner. Small grey puddle shapes on the floor. Warm torch light circles on the ground near walls. No walls visible from the side, only the floor surface' + SUFFIX,
  },
  {
    file: 'grymforge.png',
    prompt: 'An ancient dwarven underground forge seen from directly above like a floor plan. Multiple grey stone platform shapes separated by bright orange glowing lava river channels. Stone bridge rectangles crossing over the lava. Large dark anvil shapes and forge equipment on the stone platforms. Round stone pillar circles with carved rune patterns. Everything flat and viewed from directly above, no depth, no walls visible from the side' + SUFFIX,
  },
  {
    file: 'moonrise-towers.png',
    prompt: 'A dark castle courtyard seen from directly above like a satellite photo. Dark grey cracked stone floor filling the entire image. A glowing blue magical circle pattern in the center of the floor. Rubble pile shapes scattered near the edges. Round tower shapes in the four corners shown as circles from above. The courtyard floor is the main focus. No walls visible from the side, only the floor and rooftop circles of the towers' + SUFFIX,
  },
];

async function generate(prompt) {
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  throw new Error('No image');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let i = 0; i < MAPS.length; i++) {
  const m = MAPS[i];
  console.log(`[${i+1}/${MAPS.length}] ${m.file}...`);
  // Delete existing
  const fp = path.join(OUT, m.file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  try {
    const img = await generate(m.prompt);
    fs.writeFileSync(fp, img);
    console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
  }
  if (i < MAPS.length - 1) await sleep(3000);
}
console.log('Done');
