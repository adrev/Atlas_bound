import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from '../db/connection.js';
import { UPLOAD_DIR } from '../config.js';
import { isCompendiumSeeded, getCompendiumStats, reseedCompendium } from '../services/Open5eService.js';
import type {
  CompendiumMonster, CompendiumSpell, CompendiumItem,
  CompendiumSearchResult, CompendiumCategory,
} from '@dnd-vtt/shared';

const router = Router();

// Multer for slug-named token uploads
const tokenDir = path.join(UPLOAD_DIR, 'tokens');
const slugTokenUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid image type'));
  },
});

function safeJsonParse(value: unknown, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// --- Row mappers ---

function dbRowToMonster(row: Record<string, unknown>): CompendiumMonster {
  return {
    slug: row.slug as string,
    name: row.name as string,
    size: (row.size as string) ?? '',
    type: (row.type as string) ?? '',
    alignment: (row.alignment as string) ?? '',
    armorClass: (row.armor_class as number) ?? 10,
    hitPoints: (row.hit_points as number) ?? 1,
    hitDice: (row.hit_dice as string) ?? '',
    speed: safeJsonParse(row.speed, {}) as Record<string, number>,
    abilityScores: safeJsonParse(row.ability_scores, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }) as CompendiumMonster['abilityScores'],
    challengeRating: (row.challenge_rating as string) ?? '0',
    crNumeric: (row.cr_numeric as number) ?? 0,
    actions: safeJsonParse(row.actions, []) as CompendiumMonster['actions'],
    specialAbilities: safeJsonParse(row.special_abilities, []) as CompendiumMonster['specialAbilities'],
    legendaryActions: safeJsonParse(row.legendary_actions, []) as CompendiumMonster['legendaryActions'],
    description: (row.description as string) ?? '',
    senses: (row.senses as string) ?? '',
    languages: (row.languages as string) ?? '',
    damageResistances: (row.damage_resistances as string) ?? '',
    damageImmunities: (row.damage_immunities as string) ?? '',
    conditionImmunities: (row.condition_immunities as string) ?? '',
    source: (row.source as string) ?? 'SRD',
    tokenImageSource: (row.token_image_source as 'open5e' | 'uploaded' | 'ai-generated' | 'generated') ?? 'generated',
  };
}

function dbRowToSpell(row: Record<string, unknown>): CompendiumSpell {
  return {
    slug: row.slug as string,
    name: row.name as string,
    level: (row.level as number) ?? 0,
    school: (row.school as string) ?? '',
    castingTime: (row.casting_time as string) ?? '',
    range: (row.range as string) ?? '',
    components: (row.components as string) ?? '',
    duration: (row.duration as string) ?? '',
    description: (row.description as string) ?? '',
    higherLevels: (row.higher_levels as string) ?? '',
    concentration: (row.concentration as number) === 1,
    ritual: (row.ritual as number) === 1,
    classes: safeJsonParse(row.classes, []) as string[],
    source: (row.source as string) ?? 'SRD',
  };
}

function dbRowToItem(row: Record<string, unknown>): CompendiumItem & { rawJson?: unknown } {
  let rawJson: unknown = null;
  try { rawJson = row.raw_json ? JSON.parse(row.raw_json as string) : null; } catch { /* ignore */ }
  return {
    slug: row.slug as string,
    name: row.name as string,
    type: (row.type as string) ?? '',
    rarity: (row.rarity as string) ?? '',
    requiresAttunement: (row.requires_attunement as number) === 1,
    description: (row.description as string) ?? '',
    source: (row.source as string) ?? 'SRD',
    rawJson,
  };
}

// --- Snippet helper for search results ---
function makeSnippet(desc: string, maxLen = 120): string {
  if (!desc || desc === 'False' || desc === 'false' || desc === 'None') return '';
  const cleaned = String(desc).trim();
  if (!cleaned || cleaned.length <= 1) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/\s\S*$/, '') + '...';
}

// --- GET /search?q=...&category=...&limit=20 ---
router.get('/search', (req: Request, res: Response) => {
  const q = (req.query.q as string ?? '').trim();
  const category = req.query.category as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

  if (!q) {
    res.json({ results: [] });
    return;
  }

  const pattern = `%${q}%`;
  const results: CompendiumSearchResult[] = [];

  // Search monsters - deduplicated by name, prefer 5e Core Rules
  if (!category || category === 'monsters') {
    const monsters = db.prepare(
      `SELECT slug, name, description, challenge_rating, source FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
          CASE source WHEN '5e Core Rules' THEN 0 WHEN 'Systems Reference Document' THEN 1 WHEN 'SRD' THEN 1 ELSE 2 END
        ) as rn FROM compendium_monsters WHERE name LIKE ? OR description LIKE ?
      ) WHERE rn = 1
      ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name ASC LIMIT ?`
    ).all(pattern, pattern, pattern, limit) as Record<string, unknown>[];

    for (const m of monsters) {
      results.push({
        slug: m.slug as string,
        name: m.name as string,
        category: 'monsters',
        snippet: makeSnippet(m.description as string),
        cr: m.challenge_rating as string,
      });
    }
  }

    // Search spells - deduplicated by name
  if (!category || category === 'spells') {
    const spells = db.prepare(
      `SELECT slug, name, description, level FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
          CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
        ) as rn
        FROM compendium_spells WHERE name LIKE ? OR description LIKE ?
      ) WHERE rn = 1
      ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name ASC
      LIMIT ?`
    ).all(pattern, pattern, pattern, limit) as Record<string, unknown>[];

    for (const s of spells) {
      results.push({
        slug: s.slug as string,
        name: s.name as string,
        category: 'spells',
        snippet: makeSnippet(s.description as string),
        level: s.level as number,
      });
    }
  }

  // Search items - deduplicated by name
  if (!category || category === 'items') {
    const items = db.prepare(
      `SELECT slug, name, description, rarity FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
          CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
        ) as rn
        FROM compendium_items WHERE name LIKE ? OR description LIKE ?
      ) WHERE rn = 1
      ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name ASC
      LIMIT ?`
    ).all(pattern, pattern, pattern, limit) as Record<string, unknown>[];

    for (const i of items) {
      results.push({
        slug: i.slug as string,
        name: i.name as string,
        category: 'items',
        snippet: makeSnippet(i.description as string),
        rarity: (i.rarity as string) as CompendiumSearchResult['rarity'],
      });
    }
  }

  res.json({ results });
});

// --- GET /monsters/:slug ---
router.get('/monsters/:slug', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM compendium_monsters WHERE slug = ?').get(req.params.slug) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Monster not found' }); return; }
  res.json(dbRowToMonster(row));
});

// --- GET /monsters/:slug/versions - all versions of a monster by name ---
router.get('/monsters/:slug/versions', (req: Request, res: Response) => {
  const main = db.prepare('SELECT name FROM compendium_monsters WHERE slug = ?').get(req.params.slug) as { name: string } | undefined;
  if (!main) { res.status(404).json({ error: 'Monster not found' }); return; }
  const versions = db.prepare(
    'SELECT slug, name, source, challenge_rating, hit_points, armor_class FROM compendium_monsters WHERE name = ? ORDER BY CASE source WHEN \'5e Core Rules\' THEN 0 ELSE 1 END'
  ).all(main.name) as Record<string, unknown>[];
  res.json(versions.map(v => ({
    slug: v.slug, name: v.name, source: v.source,
    cr: v.challenge_rating, hp: v.hit_points, ac: v.armor_class,
  })));
});

// --- GET /spells/:slug ---
router.get('/spells/:slug', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM compendium_spells WHERE slug = ?').get(req.params.slug) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Spell not found' }); return; }
  res.json(dbRowToSpell(row));
});

// --- GET /items/:slug ---
router.get('/items/:slug', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM compendium_items WHERE slug = ?').get(req.params.slug) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Item not found' }); return; }
  res.json(dbRowToItem(row));
});

// --- GET /monsters?type=...&cr_min=...&cr_max=...&limit=50&offset=0 ---
router.get('/monsters', (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const crMin = parseFloat(req.query.cr_min as string);
  const crMax = parseFloat(req.query.cr_max as string);
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 500);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  let where = '1=1';
  const params: unknown[] = [];

  if (type) { where += ' AND type LIKE ?'; params.push(`%${type}%`); }
  if (!isNaN(crMin)) { where += ' AND cr_numeric >= ?'; params.push(crMin); }
  if (!isNaN(crMax)) { where += ' AND cr_numeric <= ?'; params.push(crMax); }

  const sql = `SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
      CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
    ) as rn FROM compendium_monsters WHERE ${where}
  ) WHERE rn = 1 ORDER BY cr_numeric ASC, name ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  res.json(rows.map(dbRowToMonster));
});

// --- GET /spells?level=...&school=...&class=...&limit=50 ---
router.get('/spells', (req: Request, res: Response) => {
  const level = req.query.level as string | undefined;
  const school = req.query.school as string | undefined;
  const classFilter = req.query.class as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

  let where = '1=1';
  const params: unknown[] = [];

  if (level !== undefined) {
    const lvl = parseInt(level, 10);
    if (!isNaN(lvl)) { where += ' AND level = ?'; params.push(lvl); }
  }
  if (school) { where += ' AND school LIKE ?'; params.push(`%${school}%`); }
  if (classFilter) { where += ' AND classes LIKE ?'; params.push(`%${classFilter}%`); }

  const sql = `SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
      CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
    ) as rn FROM compendium_spells WHERE ${where}
  ) WHERE rn = 1 ORDER BY level ASC, name ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  res.json(rows.map(dbRowToSpell));
});

// --- GET /items?rarity=...&limit=50 ---
router.get('/items', (req: Request, res: Response) => {
  const rarity = req.query.rarity as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

  let where = '1=1';
  const params: unknown[] = [];

  if (rarity) { where += ' AND rarity LIKE ?'; params.push(`%${rarity}%`); }

  const sql = `SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
      CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
    ) as rn FROM compendium_items WHERE ${where}
  ) WHERE rn = 1 ORDER BY name ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  res.json(rows.map(dbRowToItem));
});

// --- GET /status ---
router.get('/status', async (_req: Request, res: Response) => {
  const seeded = await isCompendiumSeeded();
  const stats = getCompendiumStats();
  res.json({ seeded, ...stats });
});

// --- POST /sync ---
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    await reseedCompendium();
    const stats = getCompendiumStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('Compendium sync error:', err);
    res.status(500).json({ error: 'Failed to sync compendium' });
  }
});

// --- POST /monsters/:slug/token-image --- Upload custom token art
router.post('/monsters/:slug/token-image', slugTokenUpload.single('image'), (req: Request, res: Response) => {
  const { slug } = req.params;
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }

  // Verify monster exists
  const monster = db.prepare('SELECT name FROM compendium_monsters WHERE slug = ?').get(slug) as { name: string } | undefined;
  if (!monster) { res.status(404).json({ error: 'Monster not found' }); return; }

  // Save as {slug}.png (overwrites any existing)
  const ext = req.file.mimetype === 'image/jpeg' ? '.jpg' : '.png';
  const filename = slug + ext;
  const filepath = path.join(tokenDir, filename);

  // Also remove old file if different extension
  for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp']) {
    const oldPath = path.join(tokenDir, slug + oldExt);
    if (fs.existsSync(oldPath) && oldPath !== filepath) {
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
  }

  fs.writeFileSync(filepath, req.file.buffer);

  // Update source tracking
  db.prepare('UPDATE compendium_monsters SET token_image_source = ? WHERE slug = ?').run('uploaded', slug);

  res.json({
    url: `/uploads/tokens/${filename}`,
    source: 'uploaded',
  });
});

export default router;
