import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { UPLOAD_DIR } from '../config.js';

const router = Router();

function slugify(name: string): string {
  return 'custom-' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80) + '-' + uuidv4().slice(0, 6);
}

// ============================================================
// Custom Monsters
// ============================================================

router.post('/monsters', async (req: Request, res: Response) => {
  const { sessionId, name, size, type, alignment, armorClass, hitPoints, hitDice,
    speed, abilityScores, challengeRating, crNumeric, actions, specialAbilities,
    legendaryActions, description, senses, languages, damageResistances,
    damageImmunities, conditionImmunities, imageUrl } = req.body;

  if (!sessionId || !name) { res.status(400).json({ error: 'sessionId and name required' }); return; }

  const slug = slugify(name);
  try {
    await pool.query(`INSERT INTO custom_monsters (
      slug, session_id, name, size, type, alignment, armor_class, hit_points, hit_dice,
      speed, ability_scores, challenge_rating, cr_numeric, actions, special_abilities,
      legendary_actions, description, senses, languages, damage_resistances,
      damage_immunities, condition_immunities, image_url
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`, [
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
    ]);
    res.json({ slug, name, source: 'Custom' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create monster' });
  }
});

router.get('/monsters', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) { res.json([]); return; }
  const { rows } = await pool.query('SELECT * FROM custom_monsters WHERE session_id = $1 ORDER BY name ASC', [sessionId]);
  res.json(rows.map(mapMonsterRow));
});

router.get('/monsters/:slug', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM custom_monsters WHERE slug = $1', [req.params.slug]);
  if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(mapMonsterRow(rows[0]));
});

router.put('/monsters/:slug', async (req: Request, res: Response) => {
  const { rows: existingRows } = await pool.query('SELECT slug FROM custom_monsters WHERE slug = $1', [req.params.slug]);
  if (existingRows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, size, type, alignment, armorClass, hitPoints, hitDice,
    speed, abilityScores, challengeRating, crNumeric, actions, specialAbilities,
    legendaryActions, description, senses, languages, damageResistances,
    damageImmunities, conditionImmunities, imageUrl } = req.body;

  await pool.query(`UPDATE custom_monsters SET
    name=COALESCE($1,name), size=COALESCE($2,size), type=COALESCE($3,type),
    alignment=COALESCE($4,alignment), armor_class=COALESCE($5,armor_class),
    hit_points=COALESCE($6,hit_points), hit_dice=COALESCE($7,hit_dice),
    speed=COALESCE($8,speed), ability_scores=COALESCE($9,ability_scores),
    challenge_rating=COALESCE($10,challenge_rating), cr_numeric=COALESCE($11,cr_numeric),
    actions=COALESCE($12,actions), special_abilities=COALESCE($13,special_abilities),
    legendary_actions=COALESCE($14,legendary_actions), description=COALESCE($15,description),
    senses=COALESCE($16,senses), languages=COALESCE($17,languages),
    damage_resistances=COALESCE($18,damage_resistances), damage_immunities=COALESCE($19,damage_immunities),
    condition_immunities=COALESCE($20,condition_immunities), image_url=COALESCE($21,image_url)
  WHERE slug = $22`, [
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
  ]);
  res.json({ success: true });
});

router.delete('/monsters/:slug', async (req: Request, res: Response) => {
  await pool.query('DELETE FROM custom_monsters WHERE slug = $1', [req.params.slug]);
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

router.post('/spells', async (req: Request, res: Response) => {
  const { sessionId, name, level, school, castingTime, range, components, duration,
    description, higherLevels, concentration, ritual, classes, imageUrl,
    damage, damageType, savingThrow, attackType,
    aoeType, aoeSize, halfOnSave, pushDistance,
    appliesCondition, animationType, animationColor,
  } = req.body;

  if (!sessionId || !name) { res.status(400).json({ error: 'sessionId and name required' }); return; }

  const slug = slugify(name);
  try {
    await pool.query(`INSERT INTO custom_spells (
      slug, session_id, name, level, school, casting_time, range, components, duration,
      description, higher_levels, concentration, ritual, classes, image_url,
      damage, damage_type, saving_throw, attack_type,
      aoe_type, aoe_size, half_on_save, push_distance,
      applies_condition, animation_type, animation_color
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`, [
      slug, sessionId, name, level ?? 0, school ?? 'Evocation',
      castingTime ?? '1 action', range ?? '30 feet', components ?? 'V, S',
      duration ?? 'Instantaneous', description ?? '', higherLevels ?? '',
      concentration ? 1 : 0, ritual ? 1 : 0,
      JSON.stringify(classes ?? []), imageUrl ?? null,
      damage ?? null, damageType ?? null, savingThrow ?? null, attackType ?? null,
      aoeType ?? null, aoeSize ?? 0, halfOnSave ? 1 : 0, pushDistance ?? 0,
      appliesCondition ?? null, animationType ?? null, animationColor ?? null,
    ]);
    res.json({ slug, name, source: 'Custom' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create spell' });
  }
});

router.get('/spells', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) { res.json([]); return; }
  const { rows } = await pool.query('SELECT * FROM custom_spells WHERE session_id = $1 ORDER BY level ASC, name ASC', [sessionId]);
  res.json(rows.map(mapSpellRow));
});

router.get('/spells/:slug', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM custom_spells WHERE slug = $1', [req.params.slug]);
  if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(mapSpellRow(rows[0]));
});

router.put('/spells/:slug', async (req: Request, res: Response) => {
  const { rows: existingRows } = await pool.query('SELECT slug FROM custom_spells WHERE slug = $1', [req.params.slug]);
  if (existingRows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, level, school, castingTime, range, components, duration,
    description, higherLevels, concentration, ritual, classes, imageUrl } = req.body;

  await pool.query(`UPDATE custom_spells SET
    name=COALESCE($1,name), level=COALESCE($2,level), school=COALESCE($3,school),
    casting_time=COALESCE($4,casting_time), range=COALESCE($5,range),
    components=COALESCE($6,components), duration=COALESCE($7,duration),
    description=COALESCE($8,description), higher_levels=COALESCE($9,higher_levels),
    concentration=COALESCE($10,concentration), ritual=COALESCE($11,ritual),
    classes=COALESCE($12,classes), image_url=COALESCE($13,image_url)
  WHERE slug = $14`, [
    name, level, school, castingTime, range, components, duration,
    description, higherLevels,
    concentration !== undefined ? (concentration ? 1 : 0) : null,
    ritual !== undefined ? (ritual ? 1 : 0) : null,
    classes ? JSON.stringify(classes) : null, imageUrl,
    req.params.slug,
  ]);
  res.json({ success: true });
});

router.delete('/spells/:slug', async (req: Request, res: Response) => {
  await pool.query('DELETE FROM custom_spells WHERE slug = $1', [req.params.slug]);
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
    damage: row.damage ?? null, damageType: row.damage_type ?? null,
    savingThrow: row.saving_throw ?? null, attackType: row.attack_type ?? null,
    aoeType: row.aoe_type ?? null, aoeSize: row.aoe_size ?? 0,
    halfOnSave: (row.half_on_save as number) === 1,
    pushDistance: row.push_distance ?? 0,
    appliesCondition: row.applies_condition ?? null,
    animationType: row.animation_type ?? null, animationColor: row.animation_color ?? null,
  };
}

// ============================================================
// Custom Items
// ============================================================

router.post('/items', async (req: Request, res: Response) => {
  const { sessionId, name, type, rarity, requiresAttunement, description,
    weight, valueGp, damage, damageType, properties, imageUrl, range, ac, acType, magicBonus } = req.body;

  if (!sessionId || !name) { res.status(400).json({ error: 'sessionId and name required' }); return; }

  const id = uuidv4();
  try {
    await pool.query(`INSERT INTO custom_items (
      id, session_id, name, type, rarity, requires_attunement, description,
      weight, value_gp, damage, damage_type, properties, image_url, range, ac, ac_type, magic_bonus
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
      id, sessionId, name, type ?? 'gear', rarity ?? 'common',
      requiresAttunement ? 1 : 0, description ?? '',
      weight ?? 0, valueGp ?? 0,
      damage ?? '', damageType ?? '',
      JSON.stringify(properties ?? []), imageUrl ?? null,
      range ?? '', ac ?? 0, acType ?? '', magicBonus ?? 0,
    ]);
    res.json({ id, name, source: 'Custom' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create item' });
  }
});

router.get('/items', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) { res.json([]); return; }
  const { rows } = await pool.query('SELECT * FROM custom_items WHERE session_id = $1 ORDER BY name ASC', [sessionId]);
  res.json(rows);
});

router.get('/items/:id', async (req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT * FROM custom_items WHERE id = $1', [req.params.id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(rows[0]);
});

router.put('/items/:id', async (req: Request, res: Response) => {
  const { rows: existingRows } = await pool.query('SELECT id FROM custom_items WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, type, rarity, description, weight, valueGp, damage, damageType, properties,
    requiresAttunement, imageUrl, range, ac, acType, magicBonus } = req.body;

  await pool.query(`UPDATE custom_items SET
    name=COALESCE($1,name), type=COALESCE($2,type), rarity=COALESCE($3,rarity),
    description=COALESCE($4,description), weight=COALESCE($5,weight), value_gp=COALESCE($6,value_gp),
    damage=COALESCE($7,damage), damage_type=COALESCE($8,damage_type),
    properties=COALESCE($9,properties), requires_attunement=COALESCE($10,requires_attunement),
    image_url=COALESCE($11,image_url), range=COALESCE($12,range), ac=COALESCE($13,ac), ac_type=COALESCE($14,ac_type),
    magic_bonus=COALESCE($15,magic_bonus)
  WHERE id = $16`, [
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
  ]);
  res.json({ success: true });
});

const itemImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/items/:id/image', itemImageUpload.single('image'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  const itemId = req.params.id;

  const { rows } = await pool.query('SELECT id, name FROM custom_items WHERE id = $1', [itemId]);
  if (rows.length === 0) { res.status(404).json({ error: 'Item not found' }); return; }

  const itemsDir = path.join(UPLOAD_DIR, 'items');
  if (!fs.existsSync(itemsDir)) fs.mkdirSync(itemsDir, { recursive: true });

  const ext = req.file.mimetype === 'image/jpeg' ? '.jpg' : '.png';
  const filename = itemId + ext;
  const filepath = path.join(itemsDir, filename);
  fs.writeFileSync(filepath, req.file.buffer);

  const url = `/uploads/items/${filename}`;
  await pool.query('UPDATE custom_items SET image_url = $1 WHERE id = $2', [url, itemId]);
  res.json({ url });
});

router.delete('/items/:id', async (req: Request, res: Response) => {
  await pool.query('DELETE FROM custom_items WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

function safeJson(val: unknown, fallback: unknown) {
  if (val == null) return fallback;
  if (typeof val !== 'string') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
