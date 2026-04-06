import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { UPLOAD_DIR } from '../config.js';

const router = Router();

function slugify(name: string): string {
  return 'custom-' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80) + '-' + uuidv4().slice(0, 6);
}

// ============================================================
// Custom Monsters
// ============================================================

router.post('/monsters', (req: Request, res: Response) => {
  const { sessionId, name, size, type, alignment, armorClass, hitPoints, hitDice,
    speed, abilityScores, challengeRating, crNumeric, actions, specialAbilities,
    legendaryActions, description, senses, languages, damageResistances,
    damageImmunities, conditionImmunities, imageUrl } = req.body;

  if (!sessionId || !name) { res.status(400).json({ error: 'sessionId and name required' }); return; }

  const slug = slugify(name);
  try {
    db.prepare(`INSERT INTO custom_monsters (
      slug, session_id, name, size, type, alignment, armor_class, hit_points, hit_dice,
      speed, ability_scores, challenge_rating, cr_numeric, actions, special_abilities,
      legendary_actions, description, senses, languages, damage_resistances,
      damage_immunities, condition_immunities, image_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      slug, sessionId, name, size ?? 'Medium', type ?? 'Humanoid', alignment ?? '',
      armorClass ?? 10, hitPoints ?? 10, hitDice ?? '1d8',
      JSON.stringify(speed ?? { walk: 30 }),
      JSON.stringify(abilityScores ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
      challengeRating ?? '0', crNumeric ?? 0,
      JSON.stringify(actions ?? []), JSON.stringify(specialAbilities ?? []),
      JSON.stringify(legendaryActions ?? []),
      description ?? '', senses ?? '', languages ?? '',
      damageResistances ?? '', damageImmunities ?? '', conditionImmunities ?? '',
      imageUrl ?? null,
    );
    res.json({ slug, name, source: 'Custom' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create monster' });
  }
});

router.get('/monsters', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) { res.json([]); return; }
  const rows = db.prepare('SELECT * FROM custom_monsters WHERE session_id = ? ORDER BY name ASC').all(sessionId) as Record<string, unknown>[];
  res.json(rows.map(mapMonsterRow));
});

router.get('/monsters/:slug', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM custom_monsters WHERE slug = ?').get(req.params.slug) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(mapMonsterRow(row));
});

router.put('/monsters/:slug', (req: Request, res: Response) => {
  const existing = db.prepare('SELECT slug FROM custom_monsters WHERE slug = ?').get(req.params.slug);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, size, type, alignment, armorClass, hitPoints, hitDice,
    speed, abilityScores, challengeRating, crNumeric, actions, specialAbilities,
    legendaryActions, description, senses, languages, damageResistances,
    damageImmunities, conditionImmunities, imageUrl } = req.body;

  db.prepare(`UPDATE custom_monsters SET
    name=COALESCE(?,name), size=COALESCE(?,size), type=COALESCE(?,type),
    alignment=COALESCE(?,alignment), armor_class=COALESCE(?,armor_class),
    hit_points=COALESCE(?,hit_points), hit_dice=COALESCE(?,hit_dice),
    speed=COALESCE(?,speed), ability_scores=COALESCE(?,ability_scores),
    challenge_rating=COALESCE(?,challenge_rating), cr_numeric=COALESCE(?,cr_numeric),
    actions=COALESCE(?,actions), special_abilities=COALESCE(?,special_abilities),
    legendary_actions=COALESCE(?,legendary_actions), description=COALESCE(?,description),
    senses=COALESCE(?,senses), languages=COALESCE(?,languages),
    damage_resistances=COALESCE(?,damage_resistances), damage_immunities=COALESCE(?,damage_immunities),
    condition_immunities=COALESCE(?,condition_immunities), image_url=COALESCE(?,image_url)
  WHERE slug = ?`).run(
    name, size, type, alignment, armorClass, hitPoints, hitDice,
    speed ? JSON.stringify(speed) : null,
    abilityScores ? JSON.stringify(abilityScores) : null,
    challengeRating, crNumeric,
    actions ? JSON.stringify(actions) : null,
    specialAbilities ? JSON.stringify(specialAbilities) : null,
    legendaryActions ? JSON.stringify(legendaryActions) : null,
    description, senses, languages,
    damageResistances, damageImmunities, conditionImmunities,
    imageUrl, req.params.slug,
  );
  res.json({ success: true });
});

router.delete('/monsters/:slug', (req: Request, res: Response) => {
  db.prepare('DELETE FROM custom_monsters WHERE slug = ?').run(req.params.slug);
  res.json({ success: true });
});

function mapMonsterRow(row: Record<string, unknown>) {
  return {
    slug: row.slug, name: row.name, size: row.size, type: row.type,
    alignment: row.alignment, armorClass: row.armor_class, hitPoints: row.hit_points,
    hitDice: row.hit_dice,
    speed: safeJson(row.speed, { walk: 30 }),
    abilityScores: safeJson(row.ability_scores, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
    challengeRating: row.challenge_rating, crNumeric: row.cr_numeric,
    actions: safeJson(row.actions, []),
    specialAbilities: safeJson(row.special_abilities, []),
    legendaryActions: safeJson(row.legendary_actions, []),
    description: row.description, senses: row.senses, languages: row.languages,
    damageResistances: row.damage_resistances, damageImmunities: row.damage_immunities,
    conditionImmunities: row.condition_immunities,
    source: 'Custom', imageUrl: row.image_url,
    tokenImageSource: row.image_url ? 'uploaded' : 'generated',
  };
}

// ============================================================
// Custom Spells
// ============================================================

router.post('/spells', (req: Request, res: Response) => {
  const { sessionId, name, level, school, castingTime, range, components, duration,
    description, higherLevels, concentration, ritual, classes, imageUrl } = req.body;

  if (!sessionId || !name) { res.status(400).json({ error: 'sessionId and name required' }); return; }

  const slug = slugify(name);
  try {
    db.prepare(`INSERT INTO custom_spells (
      slug, session_id, name, level, school, casting_time, range, components, duration,
      description, higher_levels, concentration, ritual, classes, image_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      slug, sessionId, name, level ?? 0, school ?? 'Evocation',
      castingTime ?? '1 action', range ?? '30 feet', components ?? 'V, S',
      duration ?? 'Instantaneous', description ?? '', higherLevels ?? '',
      concentration ? 1 : 0, ritual ? 1 : 0,
      JSON.stringify(classes ?? []), imageUrl ?? null,
    );
    res.json({ slug, name, source: 'Custom' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create spell' });
  }
});

router.get('/spells', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) { res.json([]); return; }
  const rows = db.prepare('SELECT * FROM custom_spells WHERE session_id = ? ORDER BY level ASC, name ASC').all(sessionId) as Record<string, unknown>[];
  res.json(rows.map(mapSpellRow));
});

router.get('/spells/:slug', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM custom_spells WHERE slug = ?').get(req.params.slug) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(mapSpellRow(row));
});

router.put('/spells/:slug', (req: Request, res: Response) => {
  const existing = db.prepare('SELECT slug FROM custom_spells WHERE slug = ?').get(req.params.slug);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, level, school, castingTime, range, components, duration,
    description, higherLevels, concentration, ritual, classes, imageUrl } = req.body;

  db.prepare(`UPDATE custom_spells SET
    name=COALESCE(?,name), level=COALESCE(?,level), school=COALESCE(?,school),
    casting_time=COALESCE(?,casting_time), range=COALESCE(?,range),
    components=COALESCE(?,components), duration=COALESCE(?,duration),
    description=COALESCE(?,description), higher_levels=COALESCE(?,higher_levels),
    concentration=COALESCE(?,concentration), ritual=COALESCE(?,ritual),
    classes=COALESCE(?,classes), image_url=COALESCE(?,image_url)
  WHERE slug = ?`).run(
    name, level, school, castingTime, range, components, duration,
    description, higherLevels,
    concentration !== undefined ? (concentration ? 1 : 0) : null,
    ritual !== undefined ? (ritual ? 1 : 0) : null,
    classes ? JSON.stringify(classes) : null, imageUrl,
    req.params.slug,
  );
  res.json({ success: true });
});

router.delete('/spells/:slug', (req: Request, res: Response) => {
  db.prepare('DELETE FROM custom_spells WHERE slug = ?').run(req.params.slug);
  res.json({ success: true });
});

function mapSpellRow(row: Record<string, unknown>) {
  return {
    slug: row.slug, name: row.name, level: row.level, school: row.school,
    castingTime: row.casting_time, range: row.range, components: row.components,
    duration: row.duration, description: row.description,
    higherLevels: row.higher_levels,
    concentration: (row.concentration as number) === 1,
    ritual: (row.ritual as number) === 1,
    classes: safeJson(row.classes, []),
    source: 'Custom', imageUrl: row.image_url,
  };
}

// ============================================================
// Custom Items (rewire existing custom_items table)
// ============================================================

router.post('/items', (req: Request, res: Response) => {
  const { sessionId, name, type, rarity, requiresAttunement, description,
    weight, valueGp, damage, damageType, properties, imageUrl, range, ac, acType, magicBonus } = req.body;

  if (!sessionId || !name) { res.status(400).json({ error: 'sessionId and name required' }); return; }

  const id = uuidv4();
  try {
    db.prepare(`INSERT INTO custom_items (
      id, session_id, name, type, rarity, requires_attunement, description,
      weight, value_gp, damage, damage_type, properties, image_url, range, ac, ac_type, magic_bonus
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, sessionId, name, type ?? 'gear', rarity ?? 'common',
      requiresAttunement ? 1 : 0, description ?? '',
      weight ?? 0, valueGp ?? 0,
      damage ?? '', damageType ?? '',
      JSON.stringify(properties ?? []), imageUrl ?? null,
      range ?? '', ac ?? 0, acType ?? '', magicBonus ?? 0,
    );
    res.json({ id, name, source: 'Custom' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create item' });
  }
});

router.get('/items', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) { res.json([]); return; }
  const rows = db.prepare('SELECT * FROM custom_items WHERE session_id = ? ORDER BY name ASC').all(sessionId);
  res.json(rows);
});

router.get('/items/:id', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM custom_items WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(row);
});

router.put('/items/:id', (req: Request, res: Response) => {
  const existing = db.prepare('SELECT id FROM custom_items WHERE id = ?').get(req.params.id);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, type, rarity, description, weight, valueGp, damage, damageType, properties,
    requiresAttunement, imageUrl, range, ac, acType, magicBonus } = req.body;

  db.prepare(`UPDATE custom_items SET
    name=COALESCE(?,name), type=COALESCE(?,type), rarity=COALESCE(?,rarity),
    description=COALESCE(?,description), weight=COALESCE(?,weight), value_gp=COALESCE(?,value_gp),
    damage=COALESCE(?,damage), damage_type=COALESCE(?,damage_type),
    properties=COALESCE(?,properties), requires_attunement=COALESCE(?,requires_attunement),
    image_url=COALESCE(?,image_url), range=COALESCE(?,range), ac=COALESCE(?,ac), ac_type=COALESCE(?,ac_type),
    magic_bonus=COALESCE(?,magic_bonus)
  WHERE id = ?`).run(
    name, type, rarity, description,
    weight !== undefined ? weight : null,
    valueGp !== undefined ? valueGp : null,
    damage, damageType,
    properties ? JSON.stringify(properties) : null,
    requiresAttunement !== undefined ? (requiresAttunement ? 1 : 0) : null,
    imageUrl,
    range !== undefined ? range : null,
    ac !== undefined ? ac : null,
    acType !== undefined ? acType : null,
    magicBonus !== undefined ? magicBonus : null,
    req.params.id,
  );
  res.json({ success: true });
});

// POST /items/:id/image - Upload custom item icon
const itemImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/items/:id/image', itemImageUpload.single('image'), (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  const itemId = req.params.id;

  // Verify item exists
  const item = db.prepare('SELECT id, name FROM custom_items WHERE id = ?').get(itemId) as { id: string; name: string } | undefined;
  if (!item) { res.status(404).json({ error: 'Item not found' }); return; }

  // Save to /uploads/items/ with the item ID as filename
  const itemsDir = path.join(UPLOAD_DIR, 'items');
  if (!fs.existsSync(itemsDir)) fs.mkdirSync(itemsDir, { recursive: true });

  const ext = req.file.mimetype === 'image/jpeg' ? '.jpg' : '.png';
  const filename = itemId + ext;
  const filepath = path.join(itemsDir, filename);
  fs.writeFileSync(filepath, req.file.buffer);

  const url = `/uploads/items/${filename}`;
  db.prepare('UPDATE custom_items SET image_url = ? WHERE id = ?').run(url, itemId);

  res.json({ url });
});

router.delete('/items/:id', (req: Request, res: Response) => {
  db.prepare('DELETE FROM custom_items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// Helpers
// ============================================================

function safeJson(val: unknown, fallback: unknown) {
  if (val == null) return fallback;
  if (typeof val !== 'string') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
