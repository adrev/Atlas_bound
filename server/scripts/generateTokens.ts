/**
 * Token image pipeline for all compendium monsters:
 *   1. Download real artwork from Open5e where available (12 creatures)
 *   2. Generate SVG placeholder tokens for everything else
 *   3. Tag each monster's token_image_source in the DB ('open5e' | 'uploaded' | 'generated')
 *
 * Run: npx tsx server/scripts/generateTokens.ts
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import Database from 'better-sqlite3';
const projectRoot = process.cwd();
const dbPath = path.resolve(projectRoot, 'server/data/dnd-vtt.db');
const db = new Database(dbPath);

const TOKENS_DIR = path.resolve(projectRoot, 'server/uploads/tokens');
if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });

// Ensure the column exists
try {
  db.exec(`ALTER TABLE compendium_monsters ADD COLUMN token_image_source TEXT DEFAULT 'generated'`);
  console.log('Added token_image_source column');
} catch {
  // Already exists
}

// --- Slug-to-filename helper (matches client-side logic) ---
function slugToFilename(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ============================================================
// Phase 1: Download Open5e illustrations
// ============================================================
async function downloadOpen5eArt(): Promise<{ downloaded: number; failed: number }> {
  console.log('\n--- Phase 1: Downloading Open5e illustrations ---');

  // Find monsters with real img_main URLs (not just 'http://api.open5e.com/')
  const monsters = db.prepare(`
    SELECT slug, name, raw_json FROM compendium_monsters
    WHERE raw_json LIKE '%img_main":"http%'
    AND raw_json NOT LIKE '%img_main":"http://api.open5e.com/"%'
    AND raw_json NOT LIKE '%img_main":"http://api.open5e.com/","doc%'
  `).all() as { slug: string; name: string; raw_json: string }[];

  console.log(`Found ${monsters.length} monsters with Open5e artwork`);

  let downloaded = 0;
  let failed = 0;
  const updateStmt = db.prepare(`UPDATE compendium_monsters SET token_image_source = ? WHERE slug = ?`);

  for (const m of monsters) {
    const filename = slugToFilename(m.name) + '.png';
    const filepath = path.join(TOKENS_DIR, filename);

    // Skip if already downloaded
    if (existsSync(filepath)) {
      updateStmt.run('open5e', m.slug);
      downloaded++;
      continue;
    }

    // Extract URL from raw_json
    let rawJson: Record<string, unknown>;
    try { rawJson = JSON.parse(m.raw_json); } catch { failed++; continue; }
    const imgUrl = rawJson.img_main as string;
    if (!imgUrl || imgUrl === 'http://api.open5e.com/' || !imgUrl.startsWith('http')) {
      failed++;
      continue;
    }

    // Download
    const httpsUrl = imgUrl.replace('http://', 'https://');
    try {
      console.log(`  Downloading: ${m.name} (${m.slug})`);
      const resp = await fetch(httpsUrl, { redirect: 'follow' });
      if (!resp.ok) {
        console.log(`    FAILED: ${resp.status} ${resp.statusText}`);
        failed++;
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      writeFileSync(filepath, buffer);
      updateStmt.run('open5e', m.slug);
      downloaded++;
      console.log(`    OK (${(buffer.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.log(`    ERROR: ${(err as Error).message}`);
      failed++;
    }
  }

  return { downloaded, failed };
}

// ============================================================
// Phase 2: Generate SVG tokens for everything else
// ============================================================

const TYPE_SCHEMES: Record<string, { bg: string; ring: string; text: string; glow: string }> = {
  Aberration:  { bg: '#2d1b4e', ring: '#7b2d8e', text: '#d4a0f0', glow: '#9b59b6' },
  Beast:       { bg: '#1a3a1a', ring: '#4a7a2a', text: '#a0d468', glow: '#6b8e23' },
  Celestial:   { bg: '#3a3520', ring: '#c9a530', text: '#f0e070', glow: '#f0d866' },
  Construct:   { bg: '#2a2a2a', ring: '#6a6a6a', text: '#c0c0c0', glow: '#8e8e8e' },
  Dragon:      { bg: '#3a1515', ring: '#c53131', text: '#ff8888', glow: '#e74c3c' },
  Elemental:   { bg: '#15253a', ring: '#2980b9', text: '#88ccff', glow: '#3498db' },
  Fey:         { bg: '#1a3025', ring: '#27ae60', text: '#80f0a0', glow: '#2ecc71' },
  Fiend:       { bg: '#3a0a0a', ring: '#8b0000', text: '#ff6666', glow: '#b22222' },
  Giant:       { bg: '#2a2015', ring: '#8b6f47', text: '#d4b896', glow: '#a0845c' },
  Humanoid:    { bg: '#1a2030', ring: '#4a6a8a', text: '#90b0d0', glow: '#6a8ca0' },
  Monstrosity: { bg: '#2a1a0a', ring: '#8b4513', text: '#d4a06a', glow: '#a0632a' },
  Ooze:        { bg: '#0a2a0a', ring: '#2e7d32', text: '#66ff66', glow: '#4caf50' },
  Plant:       { bg: '#0a2a15', ring: '#1b5e20', text: '#66cc66', glow: '#2e7d32' },
  Undead:      { bg: '#1a1a2a', ring: '#4a4a6a', text: '#a0a0c0', glow: '#5c5c7a' },
};

const DEFAULT_SCHEME = { bg: '#1a1a2a', ring: '#555', text: '#ccc', glow: '#666' };

const SIZE_ICONS: Record<string, string> = {
  Tiny: 'T', Small: 'S', Medium: '', Large: 'L', Huge: 'H', Gargantuan: 'G',
};

function getInitials(name: string): string {
  const words = name.split(/[\s-]+/);
  if (words.length === 1) return name.slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function generateTokenSVG(name: string, type: string, size: string): string {
  const scheme = TYPE_SCHEMES[type] || DEFAULT_SCHEME;
  const initials = getInitials(name);
  const sizeIcon = SIZE_ICONS[size] || '';
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const patternRotation = hash % 360;
  const patternCount = 3 + (hash % 5);

  let decorations = '';
  for (let i = 0; i < patternCount; i++) {
    const angle = (360 / patternCount) * i + patternRotation;
    const rad = (angle * Math.PI) / 180;
    const cx = 64 + Math.cos(rad) * 52;
    const cy = 64 + Math.sin(rad) * 52;
    decorations += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="${scheme.ring}" opacity="0.6"/>`;
  }

  const fontSize = initials.length > 2 ? 28 : 34;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="${scheme.bg}" stop-opacity="1"/>
      <stop offset="100%" stop-color="#0a0a0a" stop-opacity="1"/>
    </radialGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <circle cx="64" cy="64" r="62" fill="url(#bg)" stroke="${scheme.ring}" stroke-width="3"/>
  <circle cx="64" cy="64" r="54" fill="none" stroke="${scheme.ring}" stroke-width="1" opacity="0.3"/>
  ${decorations}
  <text x="64" y="${68 + (sizeIcon ? -2 : 4)}" text-anchor="middle" font-family="Georgia, serif" font-size="${fontSize}" font-weight="bold" fill="${scheme.text}" filter="url(#glow)">${initials}</text>
  ${sizeIcon ? `<text x="64" y="92" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="${scheme.ring}" opacity="0.7">${sizeIcon}</text>` : ''}
  <circle cx="64" cy="64" r="62" fill="none" stroke="${scheme.glow}" stroke-width="1" opacity="0.4"/>
</svg>`;
}

function generateSVGs(): { generated: number; skipped: number } {
  console.log('\n--- Phase 2: Generating SVG placeholder tokens ---');

  const monsters = db.prepare(
    "SELECT slug, name, type, size, token_image_source FROM compendium_monsters ORDER BY name"
  ).all() as { slug: string; name: string; type: string; size: string; token_image_source: string | null }[];

  const updateStmt = db.prepare(`UPDATE compendium_monsters SET token_image_source = ? WHERE slug = ?`);
  let generated = 0;
  let skipped = 0;

  for (const m of monsters) {
    const base = slugToFilename(m.name);
    const pngPath = path.join(TOKENS_DIR, base + '.png');
    const svgPath = path.join(TOKENS_DIR, base + '.svg');

    // If a real PNG exists (downloaded or uploaded), skip SVG generation
    if (existsSync(pngPath)) {
      // Don't overwrite source if already set to open5e or uploaded
      if (!m.token_image_source || m.token_image_source === 'generated') {
        updateStmt.run('uploaded', m.slug);
      }
      skipped++;
      continue;
    }

    // Generate SVG if it doesn't exist yet
    if (!existsSync(svgPath)) {
      const svg = generateTokenSVG(m.name, m.type, m.size);
      writeFileSync(svgPath, svg, 'utf-8');
      generated++;
    } else {
      skipped++;
    }

    // Tag as generated
    if (m.token_image_source !== 'open5e' && m.token_image_source !== 'uploaded') {
      updateStmt.run('generated', m.slug);
    }
  }

  return { generated, skipped };
}

// ============================================================
// Phase 3: Summary
// ============================================================
function printSummary() {
  console.log('\n--- Summary ---');
  const stats = db.prepare(`
    SELECT token_image_source, COUNT(*) as cnt
    FROM compendium_monsters
    GROUP BY token_image_source
    ORDER BY cnt DESC
  `).all() as { token_image_source: string | null; cnt: number }[];

  for (const s of stats) {
    console.log(`  ${s.token_image_source || 'untagged'}: ${s.cnt}`);
  }
}

// ============================================================
// Run
// ============================================================
async function main() {
  console.log('=== Token Image Pipeline ===');
  console.log(`Database: ${dbPath}`);
  console.log(`Tokens dir: ${TOKENS_DIR}`);

  const dl = await downloadOpen5eArt();
  console.log(`Open5e: ${dl.downloaded} downloaded, ${dl.failed} failed`);

  const gen = generateSVGs();
  console.log(`SVGs: ${gen.generated} generated, ${gen.skipped} skipped`);

  printSummary();
}

main().catch(console.error);
