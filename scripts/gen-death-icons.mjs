import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY before running this script.');
}
const URL = `https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro-preview:generateContent?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'tokens');

const ICONS = [
  {
    filename: 'skull.png',
    prompt: 'A dark fantasy skull icon for a tabletop RPG game, cracked bone texture, glowing red eye sockets, dark background, circular token format, ominous and foreboding, no text, no border, digital art'
  },
  {
    filename: 'loot-bag.png',
    prompt: 'A brown leather loot pouch bag icon for a tabletop RPG game, tied with a golden rope, coins and gems slightly visible at the top, dark background, circular token format, treasure and adventure feel, no text, no border, digital art'
  },
];

async function gen(prompt) {
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  throw new Error('No image');
}

for (const icon of ICONS) {
  const fp = path.join(OUT, icon.filename);
  console.log(`Generating ${icon.filename}...`);
  try {
    const img = await gen(icon.prompt);
    fs.writeFileSync(fp, img);
    console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 3000));
}
console.log('Done');
