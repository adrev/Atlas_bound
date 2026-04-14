import { Router, type Request, type Response } from 'express';
import pool from '../db/connection.js';
import { isCompendiumSeeded, getCompendiumStats, reseedCompendium } from '../services/Open5eService.js';
import { requireAuth } from '../auth/middleware.js';
import { requireAdmin } from '../auth/admin.js';
import { tokenUpload, validateAndSaveUpload } from './uploads.js';
import type {
  CompendiumMonster, CompendiumSpell, CompendiumItem,
  CompendiumSearchResult,
} from '@dnd-vtt/shared';

const router = Router();

function safeJsonParse(value: unknown, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function dbRowToMonster(row: Record<string, unknown>): CompendiumMonster {
  return {
    slug: row.slug as string, name: row.name as string,
    size: (row.size as string) ?? '', type: (row.type as string) ?? '',
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
    senses: (row.senses as string) ?? '', languages: (row.languages as string) ?? '',
    damageResistances: (row.damage_resistances as string) ?? '',
    damageImmunities: (row.damage_immunities as string) ?? '',
    conditionImmunities: (row.condition_immunities as string) ?? '',
    source: (row.source as string) ?? 'SRD',
    tokenImageSource: (row.token_image_source as 'open5e' | 'uploaded' | 'ai-generated' | 'generated') ?? 'generated',
  };
}

function dbRowToSpell(row: Record<string, unknown>): CompendiumSpell {
  return {
    slug: row.slug as string, name: row.name as string,
    level: (row.level as number) ?? 0, school: (row.school as string) ?? '',
    castingTime: (row.casting_time as string) ?? '', range: (row.range as string) ?? '',
    components: (row.components as string) ?? '', duration: (row.duration as string) ?? '',
    description: (row.description as string) ?? '', higherLevels: (row.higher_levels as string) ?? '',
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
    slug: row.slug as string, name: row.name as string,
    type: (row.type as string) ?? '', rarity: (row.rarity as string) ?? '',
    requiresAttunement: (row.requires_attunement as number) === 1,
    description: (row.description as string) ?? '',
    source: (row.source as string) ?? 'SRD', rawJson,
  };
}

function makeSnippet(desc: string, maxLen = 120): string {
  if (!desc || desc === 'False' || desc === 'false' || desc === 'None') return '';
  const cleaned = String(desc).trim();
  if (!cleaned || cleaned.length <= 1) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/\s\S*$/, '') + '...';
}

// --- GET /search?q=...&category=...&limit=20 ---
router.get('/search', async (req: Request, res: Response) => {
  const q = (req.query.q as string ?? '').trim();
  const category = req.query.category as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

  if (!q) { res.json({ results: [] }); return; }

  const pattern = `%${q}%`;
  const results: CompendiumSearchResult[] = [];

  if (!category || category === 'monsters') {
    const { rows: monsters } = await pool.query(
      `SELECT slug, name, description, challenge_rating, source FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
          CASE source WHEN '5e Core Rules' THEN 0 WHEN 'Systems Reference Document' THEN 1 WHEN 'SRD' THEN 1 ELSE 2 END
        ) as rn FROM compendium_monsters WHERE name LIKE $1 OR description LIKE $2
      ) sub WHERE rn = 1
      ORDER BY CASE WHEN name LIKE $3 THEN 0 ELSE 1 END, name ASC LIMIT $4`,
      [pattern, pattern, pattern, limit],
    );
    for (const m of monsters) {
      results.push({ slug: m.slug, name: m.name, category: 'monsters', snippet: makeSnippet(m.description), cr: m.challenge_rating });
    }
  }

  if (!category || category === 'spells') {
    const { rows: spells } = await pool.query(
      `SELECT slug, name, description, level FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
          CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
        ) as rn FROM compendium_spells WHERE name LIKE $1 OR description LIKE $2
      ) sub WHERE rn = 1
      ORDER BY CASE WHEN name LIKE $3 THEN 0 ELSE 1 END, name ASC LIMIT $4`,
      [pattern, pattern, pattern, limit],
    );
    for (const s of spells) {
      results.push({ slug: s.slug, name: s.name, category: 'spells', snippet: makeSnippet(s.description), level: s.level });
    }
  }

  if (!category || category === 'items') {
    const { rows: items } = await pool.query(
      `SELECT slug, name, description, rarity FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
          CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
        ) as rn FROM compendium_items WHERE name LIKE $1 OR description LIKE $2
      ) sub WHERE rn = 1
      ORDER BY CASE WHEN name LIKE $3 THEN 0 ELSE 1 END, name ASC LIMIT $4`,
      [pattern, pattern, pattern, limit],
    );
    for (const i of items) {
      results.push({ slug: i.slug, name: i.name, category: 'items', snippet: makeSnippet(i.description), rarity: i.rarity as CompendiumSearchResult['rarity'] });
    }
  }

  res.json({ results });
});

router.get('/monsters/:slug', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM compendium_monsters WHERE slug = $1', [req.params.slug]);
  if (rows.length === 0) { res.status(404).json({ error: 'Monster not found' }); return; }
  res.json(dbRowToMonster(rows[0]));
});

router.get('/monsters/:slug/versions', async (req: Request, res: Response) => {
  const { rows: mainRows } = await pool.query('SELECT name FROM compendium_monsters WHERE slug = $1', [req.params.slug]);
  if (mainRows.length === 0) { res.status(404).json({ error: 'Monster not found' }); return; }
  const { rows: versions } = await pool.query(
    "SELECT slug, name, source, challenge_rating, hit_points, armor_class FROM compendium_monsters WHERE name = $1 ORDER BY CASE source WHEN '5e Core Rules' THEN 0 ELSE 1 END",
    [mainRows[0].name],
  );
  res.json(versions.map(v => ({ slug: v.slug, name: v.name, source: v.source, cr: v.challenge_rating, hp: v.hit_points, ac: v.armor_class })));
});

router.get('/spells/:slug', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM compendium_spells WHERE slug = $1', [req.params.slug]);
  if (rows.length === 0) { res.status(404).json({ error: 'Spell not found' }); return; }
  res.json(dbRowToSpell(rows[0]));
});

router.get('/items/:slug', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM compendium_items WHERE slug = $1', [req.params.slug]);
  if (rows.length === 0) { res.status(404).json({ error: 'Item not found' }); return; }
  res.json(dbRowToItem(rows[0]));
});

router.get('/monsters', async (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const crMin = parseFloat(req.query.cr_min as string);
  const crMax = parseFloat(req.query.cr_max as string);
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 500);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  let where = '1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (type) { where += ` AND type LIKE $${paramIdx++}`; params.push(`%${type}%`); }
  if (!isNaN(crMin)) { where += ` AND cr_numeric >= $${paramIdx++}`; params.push(crMin); }
  if (!isNaN(crMax)) { where += ` AND cr_numeric <= $${paramIdx++}`; params.push(crMax); }

  const sql = `SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
      CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
    ) as rn FROM compendium_monsters WHERE ${where}
  ) sub WHERE rn = 1 ORDER BY cr_numeric ASC, name ASC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  params.push(limit, offset);

  const { rows } = await pool.query(sql, params);
  res.json(rows.map(dbRowToMonster));
});

router.get('/spells', async (req: Request, res: Response) => {
  const level = req.query.level as string | undefined;
  const school = req.query.school as string | undefined;
  const classFilter = req.query.class as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

  let where = '1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (level !== undefined) {
    const lvl = parseInt(level, 10);
    if (!isNaN(lvl)) { where += ` AND level = $${paramIdx++}`; params.push(lvl); }
  }
  if (school) { where += ` AND school LIKE $${paramIdx++}`; params.push(`%${school}%`); }
  if (classFilter) { where += ` AND classes LIKE $${paramIdx++}`; params.push(`%${classFilter}%`); }

  const sql = `SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
      CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
    ) as rn FROM compendium_spells WHERE ${where}
  ) sub WHERE rn = 1 ORDER BY level ASC, name ASC LIMIT $${paramIdx++}`;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  res.json(rows.map(dbRowToSpell));
});

router.get('/items', async (req: Request, res: Response) => {
  const rarity = req.query.rarity as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

  let where = '1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (rarity) { where += ` AND rarity LIKE $${paramIdx++}`; params.push(`%${rarity}%`); }

  const sql = `SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY
      CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END
    ) as rn FROM compendium_items WHERE ${where}
  ) sub WHERE rn = 1 ORDER BY name ASC LIMIT $${paramIdx++}`;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  res.json(rows.map(dbRowToItem));
});

router.get('/status', async (_req: Request, res: Response) => {
  const seeded = await isCompendiumSeeded();
  const stats = await getCompendiumStats();
  res.json({ seeded, ...stats });
});

// Mutating endpoints are restricted to admins. Compendium data is global
// SRD content — ordinary users must not be able to reseed it or overwrite
// shared monster token images.
router.post('/sync', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    await reseedCompendium();
    const stats = await getCompendiumStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('Compendium sync error:', err);
    res.status(500).json({ error: 'Failed to sync compendium' });
  }
});

router.post(
  '/monsters/:slug/token-image',
  requireAuth,
  requireAdmin,
  tokenUpload.single('image'),
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }

    const { rows } = await pool.query('SELECT name FROM compendium_monsters WHERE slug = $1', [slug]);
    if (rows.length === 0) { res.status(404).json({ error: 'Monster not found' }); return; }

    try {
      const filename = validateAndSaveUpload(req.file, 'tokens');
      await pool.query(
        'UPDATE compendium_monsters SET token_image_source = $1 WHERE slug = $2',
        ['uploaded', slug],
      );
      res.json({ url: `/uploads/tokens/${filename}`, source: 'uploaded' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid image file';
      res.status(400).json({ error: msg });
    }
  },
);

export default router;
