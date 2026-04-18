import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import pool from '../db/connection.js';
import { getAuthUserId, assertCharacterOwnerOrDM } from '../utils/authorization.js';
import { createLootSchema } from '../utils/validation.js';
import { getIO } from '../socket/ioInstance.js';
import { getRoom, socketsOnMap } from '../utils/roomState.js';
import type { Token } from '@dnd-vtt/shared';

const lootDropSchema = z.object({
  itemIndex: z.number().int().min(0),
  mapId: z.string().min(1),
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
});

const updateLootSchema = z.object({
  quantity: z.number().int().min(0).max(9999).optional(),
  equipped: z.boolean().optional(),
});

// Local DB row shapes. We don't exhaustively list every column; the
// handler only reads the fields it needs. Keeps the route typed
// without duplicating the full `characters`/`loot_entries` schema.
interface LootEntryRow {
  id: string;
  character_id: string;
  item_slug: string | null;
  custom_item_id: string | null;
  item_name: string;
  item_rarity: string;
  quantity: number;
  equipped: number;
}
interface CharacterInventoryRow {
  id: string;
  inventory: string | null;
  user_id?: string;
}
interface CompendiumItemRow {
  description: string | null;
  rarity: string | null;
  requires_attunement: number;
  type: string | null;
  raw_json: string | null;
}
interface CustomItemRow {
  description: string | null;
  rarity: string | null;
  requires_attunement: number;
  type: string | null;
  weight: number | null;
  value_gp: number | null;
  damage: string | null;
  damage_type: string | null;
  properties: string | null;
  range: string | null;
  ac: number | null;
  ac_type: string | null;
  magic_bonus: number | null;
  image_url: string | null;
  stat_effects: string | null;
}

const router = Router();

// GET /api/characters/:id/loot
router.get('/characters/:id/loot', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const charId = String(req.params.id);

  // Loot bags (NPC-owned dropped items or dead-creature remains) have
  // user_id = 'npc' and no session_players link, so the default
  // owner-or-DM check rejects every caller. Any session member who can
  // see a token backed by this character should be able to read its
  // loot, otherwise dropped items become unlootable (the bug reported
  // from live play).
  const { rows: ownerRows } = await pool.query(
    'SELECT user_id FROM characters WHERE id = $1',
    [charId],
  );
  if (ownerRows.length === 0) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  const ownerUserId = ownerRows[0].user_id as string | null;

  if (ownerUserId === 'npc' || ownerUserId === null) {
    // Loot bag: require session membership via a token link.
    const { rows: accessRows } = await pool.query(
      `SELECT 1 FROM tokens t
       JOIN maps m ON m.id = t.map_id
       JOIN session_players sp ON sp.session_id = m.session_id
       WHERE t.character_id = $1 AND sp.user_id = $2
       LIMIT 1`,
      [charId, userId],
    );
    if (accessRows.length === 0) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
  } else {
    await assertCharacterOwnerOrDM(charId, userId);
  }

  const { rows: entries } = await pool.query('SELECT * FROM loot_entries WHERE character_id = $1 ORDER BY sort_order', [charId]);
  res.json(entries);
});

// POST /api/characters/:id/loot
router.post('/characters/:id/loot', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const charId = String(req.params.id);
  await assertCharacterOwnerOrDM(charId, userId);
  const parsed = createLootSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }
  const { itemName, itemSlug, customItemId, itemRarity, quantity } = parsed.data;
  const id = uuidv4();
  await pool.query(
    'INSERT INTO loot_entries (id, character_id, item_slug, custom_item_id, item_name, item_rarity, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, charId, itemSlug || null, customItemId || null, itemName, itemRarity || 'common', quantity || 1],
  );
  res.status(201).json({ id, characterId: charId, itemName, itemRarity: itemRarity || 'common', quantity: quantity || 1 });
});

// DELETE /api/characters/:id/loot/:entryId
router.delete('/characters/:id/loot/:entryId', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  await assertCharacterOwnerOrDM(String(req.params.id), userId);
  await pool.query('DELETE FROM loot_entries WHERE id = $1 AND character_id = $2', [req.params.entryId, String(req.params.id)]);
  res.json({ success: true });
});

// PATCH /api/characters/:id/loot/:entryId
router.patch('/characters/:id/loot/:entryId', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const charId = String(req.params.id);
  await assertCharacterOwnerOrDM(charId, userId);
  const parsed = updateLootSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }
  const { quantity, equipped } = parsed.data;
  const entryId = req.params.entryId;

  if (quantity !== undefined) {
    if (quantity === 0) {
      await pool.query('DELETE FROM loot_entries WHERE id = $1 AND character_id = $2', [entryId, charId]);
    } else {
      await pool.query('UPDATE loot_entries SET quantity = $1 WHERE id = $2 AND character_id = $3', [quantity, entryId, charId]);
    }
  }

  if (equipped !== undefined) {
    await pool.query('UPDATE loot_entries SET equipped = $1 WHERE id = $2 AND character_id = $3', [equipped ? 1 : 0, entryId, charId]);
  }

  res.json({ success: true });
});

// POST /api/characters/:id/loot/take
router.post('/characters/:id/loot/take', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const creatureCharId = String(req.params.id);
  const { entryId, targetCharacterId } = req.body;

  // Verify user owns the target character (the one receiving the loot)
  if (targetCharacterId) {
    await assertCharacterOwnerOrDM(targetCharacterId, userId);
  }

  // Authorize the SOURCE.
  //
  // Prior behaviour allowed any session member to take from any
  // character linked to a shared session — which meant a player could
  // rip entries out of another player's PC just by knowing the
  // character id. Close that hole by splitting the accept cases:
  //
  //   1. Caller owns the source character — fine (looting your own bag).
  //   2. Caller is the DM of a session containing the source — fine
  //      (DM cleanup / NPC hand-off).
  //   3. Source is an NPC/loot-bag container (user_id === 'npc' or
  //      the character has no real human owner) AND the source token
  //      is placed on a map belonging to a session the caller is in.
  //      That covers the "goblin drops a longsword" case without
  //      letting a player siphon from another PC's inventory.
  //
  // A PC owned by another human user is explicitly rejected, even if
  // both characters share the same session.
  const { rows: sourceRows } = await pool.query('SELECT user_id FROM characters WHERE id = $1', [creatureCharId]);
  if (sourceRows.length === 0) { res.status(404).json({ error: 'Source not found' }); return; }
  const sourceOwner = sourceRows[0].user_id as string | null;
  const sourceIsHumanPC = sourceOwner !== null && sourceOwner !== 'npc';

  if (sourceOwner !== userId) {
    // 2 — DM override: caller is DM of some session that contains the source.
    const { rows: dmOverride } = await pool.query(
      `SELECT 1 FROM session_players sp
       JOIN tokens t ON t.character_id = $2
       JOIN maps m ON m.id = t.map_id AND m.session_id = sp.session_id
       WHERE sp.user_id = $1 AND sp.role = 'dm'
       LIMIT 1`,
      [userId, creatureCharId],
    );
    if (dmOverride.length === 0) {
      // 3 — non-DM player looting an NPC / loot-bag that's present on a
      // shared map. Human-owned PCs never qualify; that was the bug.
      if (sourceIsHumanPC) {
        res.status(403).json({ error: 'Not authorized to take from another player\'s character' });
        return;
      }
      const { rows: npcInSession } = await pool.query(
        `SELECT 1 FROM tokens t
         JOIN maps m ON t.map_id = m.id
         JOIN session_players sp ON sp.session_id = m.session_id
         WHERE t.character_id = $1 AND sp.user_id = $2
         LIMIT 1`,
        [creatureCharId, userId],
      );
      if (npcInSession.length === 0) {
        res.status(403).json({ error: 'Not authorized to take from this source' });
        return;
      }
    }
  }

  // Race-safe take: lock the loot_entries row for the duration of this
  // request so two concurrent take calls can't both see the same quantity
  // and both decrement it (item duplication).
  const client = await pool.connect();
  let responseInventory: unknown[] = [];
  let responseItemName = '';
  try {
    await client.query('BEGIN');

    const { rows: entryRows } = await client.query(
      'SELECT * FROM loot_entries WHERE id = $1 AND character_id = $2 FOR UPDATE',
      [entryId, creatureCharId],
    );
    const entry = entryRows[0] as LootEntryRow | undefined;
    if (!entry) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Loot entry not found' });
      return;
    }
    if (entry.quantity <= 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Item no longer available' });
      return;
    }

    // Lock the target character row too, so parallel inventory writers
    // to the same character serialize cleanly.
    const { rows: targetRows } = await client.query(
      'SELECT id, inventory FROM characters WHERE id = $1 FOR UPDATE',
      [targetCharacterId],
    );
    const targetChar = targetRows[0] as CharacterInventoryRow | undefined;
    if (!targetChar) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Target character not found' });
      return;
    }

    const inventory = JSON.parse(targetChar.inventory || '[]');

    let itemType: string = 'gear';
    let weight = 0;
    let description = '';
    let cost = 0;
    let damage = '';
    let damageType = '';
    let properties: string[] = [];
    let range = '';
    let rarity = entry.item_rarity || 'common';
    let attunement = false;
    let acBonus: number | undefined;
    const slug = entry.item_slug || null;
    const customItemId = entry.custom_item_id || null;

    const mapType = (t: string): string => {
      const lower = t.toLowerCase();
      if (lower.includes('weapon')) return 'weapon';
      if (lower.includes('armor') || lower.includes('shield')) return 'armor';
      if (lower.includes('potion')) return 'potion';
      if (lower.includes('scroll')) return 'scroll';
      if (lower.includes('currency')) return 'currency';
      if (lower.includes('treasure')) return 'treasure';
      return 'gear';
    };

    if (slug) {
      const { rows: compRows } = await client.query('SELECT * FROM compendium_items WHERE slug = $1', [slug]);
      const compItem = compRows[0] as CompendiumItemRow | undefined;
      if (compItem) {
        description = compItem.description || '';
        rarity = compItem.rarity || rarity;
        attunement = compItem.requires_attunement === 1;
        itemType = mapType(compItem.type || '');
        try {
          const raw = JSON.parse(compItem.raw_json || '{}');
          weight = raw.weight ?? 0;
          cost = raw.costGp ?? raw.valueGp ?? 0;
          damage = raw.damage ?? '';
          damageType = raw.damageType ?? '';
          properties = raw.properties ?? [];
          range = raw.range ?? '';
          if (raw.acBonus) acBonus = raw.acBonus;
          if (raw.ac && itemType === 'armor') acBonus = raw.ac;
        } catch { /* ignore */ }
        if (!damage && itemType === 'weapon' && description) {
          const m = description.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(slashing|piercing|bludgeoning|fire|cold|lightning|thunder|acid|poison|necrotic|radiant|force|psychic)/i);
          if (m) { damage = m[1].replace(/\s/g, ''); damageType = m[2].toLowerCase(); }
        }
      }
    }

    if (customItemId) {
      const { rows: ciRows } = await client.query('SELECT * FROM custom_items WHERE id = $1', [customItemId]);
      const ci = ciRows[0] as CustomItemRow | undefined;
      if (ci) {
        description = ci.description || '';
        rarity = ci.rarity || rarity;
        attunement = ci.requires_attunement === 1;
        itemType = mapType(ci.type || '');
        weight = ci.weight ?? 0;
        cost = ci.value_gp ?? 0;
        damage = ci.damage || '';
        damageType = ci.damage_type || '';
        try { properties = JSON.parse(ci.properties || '[]'); } catch { properties = []; }
      }
    }

    const existingIdx = inventory.findIndex((i: { slug?: string; name?: string; type?: string }) =>
      (slug && i.slug === slug) || (!slug && i.name === entry.item_name && i.type === itemType)
    );

    if (existingIdx >= 0) {
      inventory[existingIdx].quantity = (inventory[existingIdx].quantity || 1) + 1;
    } else {
      const newItem: Record<string, unknown> = {
        name: entry.item_name, quantity: 1, weight, description, equipped: false,
        type: itemType, cost, rarity, slug, imageUrl: slug ? `/uploads/items/${slug}.png` : null,
      };
      if (attunement) newItem.attunement = true;
      if (damage) newItem.damage = damage;
      if (damageType) newItem.damageType = damageType;
      if (properties.length > 0) newItem.properties = properties;
      if (range) newItem.range = range;
      if (acBonus !== undefined) newItem.acBonus = acBonus;
      inventory.push(newItem);
    }

    if (customItemId) {
      const lastItem = inventory[inventory.length - 1];
      if (lastItem && !lastItem.slug) lastItem.customItemId = customItemId;
    }

    const inventoryJson = JSON.stringify(inventory);

    // Decrement or delete the loot entry, then persist the target inventory.
    // Both writes are inside the transaction, with the loot_entries row
    // held under FOR UPDATE, so concurrent take calls serialize and the
    // second one sees quantity = 0 (or missing row) instead of racing.
    if (entry.quantity <= 1) {
      await client.query('DELETE FROM loot_entries WHERE id = $1', [entryId]);
    } else {
      await client.query('UPDATE loot_entries SET quantity = quantity - 1 WHERE id = $1', [entryId]);
    }
    await client.query('UPDATE characters SET inventory = $1 WHERE id = $2', [inventoryJson, targetCharacterId]);

    await client.query('COMMIT');

    responseInventory = inventory;
    responseItemName = entry.item_name;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ success: true, itemName: responseItemName, inventory: responseInventory, targetCharacterId });

  // Fan out the inventory change to everyone in the target character's
  // session. Without this the receiving player's inventory panel keeps
  // showing stale data until they refresh — even though the DB is
  // already updated and the response returned the new inventory.
  //
  // Fire-and-forget: failures here should NEVER roll back the take.
  try {
    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT m.session_id AS session_id
       FROM tokens t JOIN maps m ON m.id = t.map_id
       WHERE t.character_id = $1
       LIMIT 1`,
      [targetCharacterId],
    );
    const sessionId = sessionRows[0]?.session_id as string | undefined;
    const io = getIO();
    if (sessionId && io) {
      io.to(sessionId).emit('character:updated', {
        characterId: targetCharacterId,
        changes: { inventory: responseInventory },
      });
    }
  } catch (err) {
    // Log but don't throw — the HTTP response has already been sent.
    console.warn('[loot/take] inventory broadcast failed:', err);
  }
});

// POST /api/characters/:id/inventory/enrich
router.post('/characters/:id/inventory/enrich', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const charId = String(req.params.id);
  await assertCharacterOwnerOrDM(charId, userId);
  const { rows: charRows } = await pool.query('SELECT id, inventory FROM characters WHERE id = $1', [charId]);
  const char = charRows[0] as CharacterInventoryRow | undefined;
  if (!char) { res.status(404).json({ error: 'Character not found' }); return; }

  const inventory = JSON.parse(char.inventory || '[]');
  let updated = false;

  const aliases: Record<string, string> = {
    'leather': 'leather-armor', 'studded leather': 'studded-leather-armor',
    'chain shirt': 'chain-shirt', 'chain mail': 'chain-mail',
    'half plate': 'half-plate', 'scale mail': 'scale-mail',
    'hide': 'hide-armor', 'padded': 'padded-armor',
    'ring mail': 'ring-mail', 'splint': 'splint-armor',
    'plate': 'plate-armor', 'breastplate': 'breastplate',
    'rations': 'rations-1-day', 'oil': 'oil-flask',
    'crossbow, light': 'crossbow-light', 'crossbow, hand': 'crossbow-hand',
    'crossbow, heavy': 'crossbow-heavy',
    'rope, hempen (50 feet)': 'rope-hempen-50-feet', 'rope, silk (50 feet)': 'rope-silk-50-feet',
  };

  for (const item of inventory) {
    if (item.slug) continue;
    const nameLower = item.name.toLowerCase().trim();

    let match: { slug: string; type: string | null; rarity: string | null; raw_json: string | null } | undefined;
    const { rows: r1 } = await pool.query('SELECT slug, type, rarity, raw_json FROM compendium_items WHERE LOWER(name) = $1 LIMIT 1', [nameLower]);
    match = r1[0];

    if (!match && aliases[nameLower]) {
      const { rows: r2 } = await pool.query('SELECT slug, type, rarity, raw_json FROM compendium_items WHERE slug = $1 LIMIT 1', [aliases[nameLower]]);
      match = r2[0];
    }

    if (!match) {
      const { rows: r3 } = await pool.query("SELECT slug, type, rarity, raw_json FROM compendium_items WHERE LOWER(name) LIKE $1 AND source = 'PHB Equipment' LIMIT 1", [`${nameLower}%`]);
      match = r3[0];
    }

    if (match) {
      item.slug = match.slug;
      item.imageUrl = `/uploads/items/${match.slug}.png`;
      item.rarity = item.rarity || match.rarity || 'common';
      try {
        const raw = JSON.parse(match.raw_json || '{}');
        if (!item.damage && raw.damage) { item.damage = raw.damage; item.damageType = raw.damageType || ''; }
        if (!item.properties && raw.properties) item.properties = raw.properties;
        if (raw.range && !item.range) item.range = raw.range;
        if (!item.weight && raw.weight) item.weight = raw.weight;
        if (!item.cost && raw.costGp) item.cost = raw.costGp;
      } catch { /* ignore */ }
      const cType = (match.type || '').toLowerCase();
      if (cType.includes('weapon') && item.type === 'gear') item.type = 'weapon';
      else if ((cType.includes('armor') || cType.includes('shield')) && item.type === 'gear') item.type = 'armor';
      updated = true;
    }
  }

  if (updated) {
    await pool.query('UPDATE characters SET inventory = $1 WHERE id = $2', [JSON.stringify(inventory), charId]);
  }

  res.json({ success: true, updated, inventory });
});

// POST /api/loot/transfer
router.post('/loot/transfer', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { fromCharacterId, toCharacterId, lootEntryId } = req.body;

  if (!fromCharacterId || !toCharacterId || !lootEntryId) {
    res.status(400).json({ error: 'Missing required fields: fromCharacterId, toCharacterId, lootEntryId' });
    return;
  }

  // Must own the source character or be DM
  await assertCharacterOwnerOrDM(String(fromCharacterId), userId);

  // Verify target character is in the same session as the source
  const { rows: fromSessions } = await pool.query(
    'SELECT session_id FROM session_players WHERE character_id = $1', [fromCharacterId]
  );
  const { rows: toSessions } = await pool.query(
    'SELECT session_id FROM session_players WHERE character_id = $1', [toCharacterId]
  );
  const fromSessionIds = new Set(fromSessions.map(r => r.session_id));
  const sharedSession = toSessions.some(r => fromSessionIds.has(r.session_id));
  if (!sharedSession) {
    res.status(403).json({ error: 'Target character is not in the same session' });
    return;
  }

  // Race-safe transfer: lock the loot row so two concurrent transfers of
  // the same entry can't both succeed (which would leave the entry under
  // whichever transaction committed last while both clients believed
  // they received it).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: entryRows } = await client.query(
      'SELECT * FROM loot_entries WHERE id = $1 AND character_id = $2 FOR UPDATE',
      [lootEntryId, String(fromCharacterId)],
    );
    const entry = entryRows[0] as LootEntryRow | undefined;
    if (!entry) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Loot entry not found' });
      return;
    }

    const { rows: targetRows } = await client.query(
      'SELECT id, name FROM characters WHERE id = $1',
      [String(toCharacterId)],
    );
    const targetChar = targetRows[0] as { id: string; name: string } | undefined;
    if (!targetChar) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Target character not found' });
      return;
    }

    await client.query(
      'UPDATE loot_entries SET character_id = $1 WHERE id = $2',
      [String(toCharacterId), lootEntryId],
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      entry: { ...entry, character_id: String(toCharacterId) },
      itemName: entry.item_name,
      targetCharacterName: targetChar.name,
      targetCharacterId: String(toCharacterId),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/characters/:id/loot/drop
//
// Atomically drops an item from a character's inventory onto a map as
// a loot-bag token. All writes happen in a single transaction; the
// token is created server-side and broadcast via socket.io so that
// clients no longer need to emit `map:token-add` for loot drops.
//
// Authorization:
//   1. Caller must own the source character OR be DM of a session
//      containing that character (assertCharacterOwnerOrDM).
//   2. The target map must belong to a session the caller is a
//      member of. Prevents dropping loot into unrelated sessions.
//   3. The item must actually exist at itemIndex in the current
//      (SELECT FOR UPDATE) inventory snapshot — no races.
router.post('/characters/:id/loot/drop', async (req: Request, res: Response) => {
  const authUserId = getAuthUserId(req);
  const charId = String(req.params.id);
  await assertCharacterOwnerOrDM(charId, authUserId);

  const parsed = lootDropSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }
  const { itemIndex, mapId, x, y } = parsed.data;

  // Verify the target map belongs to a session the caller is in.
  const { rows: mapRows } = await pool.query('SELECT session_id FROM maps WHERE id = $1', [mapId]);
  if (mapRows.length === 0) { res.status(404).json({ error: 'Map not found' }); return; }
  const targetSessionId = mapRows[0].session_id as string;

  const { rows: memberRows } = await pool.query(
    'SELECT role FROM session_players WHERE session_id = $1 AND user_id = $2',
    [targetSessionId, authUserId],
  );
  if (memberRows.length === 0) {
    res.status(403).json({ error: 'Not a member of the target session' });
    return;
  }

  // Non-DMs can only drop loot onto the active player ribbon map.
  // Without this, a player who guesses a prep-map ID can create
  // loot-bag characters + tokens on a DM-only scene.
  const callerIsDM = memberRows[0].role === 'dm';
  if (!callerIsDM) {
    const { rows: sessionRows } = await pool.query(
      'SELECT player_map_id FROM sessions WHERE id = $1',
      [targetSessionId],
    );
    const ribbonMapId = sessionRows[0]?.player_map_id as string | null;
    if (!ribbonMapId || ribbonMapId !== mapId) {
      res.status(403).json({ error: 'Can only drop loot on the active map' });
      return;
    }
  }

  const client = await pool.connect();
  let createdToken: Token | null = null;
  let updatedInventory: unknown[] = [];
  try {
    await client.query('BEGIN');

    // SELECT FOR UPDATE to serialize concurrent drops of the same
    // character and prevent an attacker from draining a single item
    // twice via two parallel requests.
    const { rows: charRows } = await client.query(
      'SELECT id, inventory FROM characters WHERE id = $1 FOR UPDATE',
      [charId],
    );
    const char = charRows[0];
    if (!char) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Character not found' });
      return;
    }

    const inventory = JSON.parse(char.inventory || '[]');
    if (itemIndex < 0 || itemIndex >= inventory.length) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Invalid item index' });
      return;
    }

    const item = inventory[itemIndex];
    if (!item || typeof item !== 'object') {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Inventory entry is malformed' });
      return;
    }

    const lootCharId = uuidv4();
    await client.query(
      `INSERT INTO characters (id, user_id, name, race, class, level, hit_points, max_hit_points, armor_class)
       VALUES ($1, 'npc', $2, 'loot', 'bag', 1, 0, 1, 0)`,
      [lootCharId, `Dropped: ${item.name}`],
    );

    const lootEntryId = uuidv4();
    await client.query(
      `INSERT INTO loot_entries (id, character_id, item_slug, custom_item_id, item_name, item_rarity, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [lootEntryId, lootCharId, item.slug || null, item.customItemId || null, item.name, item.rarity || 'common'],
    );

    if (item.quantity > 1) {
      inventory[itemIndex] = { ...item, quantity: item.quantity - 1 };
    } else {
      inventory.splice(itemIndex, 1);
    }
    await client.query(
      'UPDATE characters SET inventory = $1 WHERE id = $2',
      [JSON.stringify(inventory), charId],
    );
    updatedInventory = inventory;

    // Create the loot-bag token on the target map.
    const imgUrl: string = item.imageUrl || (item.slug ? `/uploads/items/${item.slug}.png` : '/uploads/items/default-item.svg');
    const tokenId = uuidv4();
    const now = new Date().toISOString();
    const dropX = typeof x === 'number' ? x : 0;
    const dropY = typeof y === 'number' ? y : 0;

    await client.query(
      `INSERT INTO tokens (
         id, map_id, character_id, name, x, y, size, image_url, color, layer,
         visible, has_light, light_radius, light_dim_radius, light_color,
         conditions, owner_user_id, faction
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        tokenId, mapId, lootCharId, item.name,
        dropX, dropY, 0.5, imgUrl, '#d4a843', 'token',
        1, 0, 0, 0, '#ffcc44',
        JSON.stringify([]), null, 'neutral',
      ],
    );

    createdToken = {
      id: tokenId, mapId, characterId: lootCharId, name: item.name,
      x: dropX, y: dropY, size: 0.5, imageUrl: imgUrl, color: '#d4a843',
      layer: 'token', visible: true,
      hasLight: false, lightRadius: 0, lightDimRadius: 0, lightColor: '#ffcc44',
      conditions: [], ownerUserId: null, faction: 'neutral', createdAt: now,
    } as Token;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Broadcast the new token to every socket rendering the target map.
  if (createdToken) {
    const room = getRoom(targetSessionId);
    const io = getIO();
    if (room && io) {
      if (mapId === room.playerMapId) {
        room.tokens.set(createdToken.id, createdToken);
      }
      const recipients = socketsOnMap(room, mapId);
      for (const sid of recipients) io.to(sid).emit('map:token-added', createdToken);
    }
  }

  res.json({
    success: true,
    inventory: updatedInventory,
    tokenId: createdToken?.id ?? null,
    token: createdToken,
  });
});

export default router;
