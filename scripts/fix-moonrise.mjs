import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY before running this script.');
}
const URL = `https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro-preview:generateContent?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'maps');

const prompt = 'A dark castle courtyard seen from directly above like a satellite photo. Dark grey cracked stone floor filling the entire image. A glowing blue magical circle pattern in the center of the floor. Rubble pile shapes scattered near the edges. Round tower shapes in the four corners shown as circles from above. The courtyard floor is the main focus. No walls visible from the side, only the floor and rooftop circles of the towers. Perfectly flat top-down 2D view, as if photographed from directly above at 90 degrees. Realistic fantasy painting with rich textures, high detail, no people, no text, no labels, no grid lines, D&D battle map style';

async function main() {
  console.log('Generating moonrise-towers.png...');
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });
  if (!resp.ok) { console.log('FAIL:', (await resp.text()).substring(0, 200)); return; }
  const data = await resp.json();
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.data) {
      const buf = Buffer.from(part.inlineData.data, 'base64');
      fs.writeFileSync(path.join(OUT, 'moonrise-towers.png'), buf);
      console.log(`OK (${Math.round(buf.length / 1024)} KB)`);
      return;
    }
  }
  console.log('No image data');
}
main();
