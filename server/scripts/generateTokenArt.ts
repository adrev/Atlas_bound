/**
 * Generates AI creature token art using Hugging Face Inference API (free tier).
 *
 * Resumable — tracks progress in DB (token_image_source column).
 * Only generates for creatures still marked as 'generated'.
 *
 * Usage:
 *   HF_TOKEN=hf_xxx npx tsx server/scripts/generateTokenArt.ts
 *   HF_TOKEN=hf_xxx npx tsx server/scripts/generateTokenArt.ts --limit 30
 *   HF_TOKEN=hf_xxx npx tsx server/scripts/generateTokenArt.ts --source "5e Core Rules"
 *
 * Get your free token at: https://huggingface.co/settings/tokens/new
 * (Select "Make calls to the Inference API" permission)
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const projectRoot = process.cwd();
const dbPath = path.resolve(projectRoot, 'server/data/dnd-vtt.db');
const db = new Database(dbPath);
const TOKENS_DIR = path.resolve(projectRoot, 'server/uploads/tokens');
if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });

// --- Config ---
const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.error('ERROR: Set HF_TOKEN environment variable.');
  console.error('Get one free at: https://huggingface.co/settings/tokens/new');
  process.exit(1);
}

// Model — SDXL Lightning is fast and works on free tier
const MODEL_URL = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0';
const IMAGE_SIZE = 512; // Generate at 512, will be displayed at token size
const DELAY_MS = 3000;  // 3 second delay between requests to avoid rate limits

// Parse CLI args
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const BATCH_LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 30;
const sourceIdx = args.indexOf('--source');
const SOURCE_FILTER = sourceIdx >= 0 ? args[sourceIdx + 1] : null;

// --- Prompt engineering ---
function buildPrompt(name: string, type: string, size: string): string {
  const sizeDesc = {
    'Tiny': 'tiny',
    'Small': 'small',
    'Medium': 'medium-sized',
    'Large': 'large',
    'Huge': 'huge towering',
    'Gargantuan': 'massive gargantuan',
  }[size] || '';

  const typeHints: Record<string, string> = {
    'Aberration': 'alien tentacled horror',
    'Beast': 'natural animal creature',
    'Celestial': 'radiant divine being with golden light',
    'Construct': 'mechanical golem made of stone or metal',
    'Dragon': 'scaled dragon with glowing eyes',
    'Elemental': 'elemental being of raw magical energy',
    'Fey': 'ethereal fey creature from the feywild',
    'Fiend': 'demonic fiendish creature from the lower planes',
    'Giant': 'towering giant humanoid',
    'Humanoid': 'humanoid character',
    'Monstrosity': 'monstrous unnatural beast',
    'Ooze': 'amorphous ooze or slime creature',
    'Plant': 'living plant creature',
    'Undead': 'decaying undead creature with hollow eyes',
  };

  const typeDesc = typeHints[type] || 'fantasy creature';

  return `Dark fantasy portrait of a ${sizeDesc} ${name}, ${typeDesc}, D&D monster token art, circular composition centered on face/body, dark moody background, dramatic lighting, highly detailed, digital painting style, dark atmospheric`;
}

const NEGATIVE_PROMPT = 'text, watermark, signature, blurry, low quality, deformed, ugly, frame, border, multiple creatures, white background, bright cheerful';

// --- API call ---
async function generateImage(prompt: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(MODEL_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            negative_prompt: NEGATIVE_PROMPT,
            guidance_scale: 7.5,
            num_inference_steps: 25,
            width: IMAGE_SIZE,
            height: IMAGE_SIZE,
          },
        }),
      });

      if (resp.status === 503) {
        // Model loading — wait and retry
        const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const wait = (data.estimated_time as number) || 30;
        console.log(`    Model loading, waiting ${Math.ceil(wait)}s...`);
        await sleep(Math.ceil(wait) * 1000);
        continue;
      }

      if (resp.status === 429) {
        // Rate limited
        console.log('    Rate limited — waiting 60s...');
        await sleep(60000);
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.log(`    API error ${resp.status}: ${errText.slice(0, 200)}`);
        if (attempt < 2) { await sleep(5000); continue; }
        return null;
      }

      const arrayBuffer = await resp.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.log(`    Fetch error: ${(err as Error).message}`);
      if (attempt < 2) { await sleep(5000); continue; }
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function slugToFilename(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// --- Main ---
async function main() {
  console.log('=== Creature Token Art Generator (Hugging Face) ===');
  console.log(`Model: ${MODEL_URL}`);
  console.log(`Batch limit: ${BATCH_LIMIT}`);
  if (SOURCE_FILTER) console.log(`Source filter: ${SOURCE_FILTER}`);
  console.log('');

  // Find creatures that still need art
  let query = `SELECT slug, name, type, size FROM compendium_monsters WHERE token_image_source = 'generated'`;
  const params: unknown[] = [];
  if (SOURCE_FILTER) {
    query += ' AND source = ?';
    params.push(SOURCE_FILTER);
  }
  query += ' ORDER BY CASE source WHEN \'5e Core Rules\' THEN 0 ELSE 1 END, cr_numeric ASC, name ASC';
  query += ` LIMIT ?`;
  params.push(BATCH_LIMIT);

  const monsters = db.prepare(query).all(...params) as {
    slug: string; name: string; type: string; size: string;
  }[];

  const totalRemaining = db.prepare(
    `SELECT COUNT(*) as cnt FROM compendium_monsters WHERE token_image_source = 'generated'` +
    (SOURCE_FILTER ? ' AND source = ?' : '')
  ).get(...(SOURCE_FILTER ? [SOURCE_FILTER] : [])) as { cnt: number };

  console.log(`Generating ${monsters.length} of ${totalRemaining.cnt} remaining creatures\n`);

  if (monsters.length === 0) {
    console.log('Nothing to generate!');
    return;
  }

  const updateStmt = db.prepare(`UPDATE compendium_monsters SET token_image_source = 'ai-generated' WHERE slug = ?`);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < monsters.length; i++) {
    const m = monsters[i];
    const filename = slugToFilename(m.name) + '.png';
    const filepath = path.join(TOKENS_DIR, filename);

    // Skip if PNG already exists (maybe uploaded manually since last check)
    if (existsSync(filepath)) {
      console.log(`[${i + 1}/${monsters.length}] ${m.name} — already has PNG, skipping`);
      updateStmt.run(m.slug);
      success++;
      continue;
    }

    const prompt = buildPrompt(m.name, m.type, m.size);
    console.log(`[${i + 1}/${monsters.length}] ${m.name} (${m.type}, ${m.size})`);

    const imageBuffer = await generateImage(prompt);

    if (imageBuffer && imageBuffer.length > 1000) {
      writeFileSync(filepath, imageBuffer);
      updateStmt.run(m.slug);
      success++;
      console.log(`    Saved (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
    } else {
      failed++;
      console.log('    FAILED — no valid image returned');
    }

    // Delay between requests
    if (i < monsters.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n=== Done: ${success} generated, ${failed} failed ===`);
  console.log(`Remaining: ${totalRemaining.cnt - success} creatures still need art`);
}

main().catch(console.error);
