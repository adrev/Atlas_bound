import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';

const router = Router();

// GET /api/characters/:id/loot - Get loot for a creature
router.get('/characters/:id/loot', (req: Request, res: Response) => {
  const charId = String(req.params.id);
  const entries = db.prepare('SELECT * FROM loot_entries WHERE character_id = ? ORDER BY sort_order').all(charId);
  res.json(entries);
});

// POST /api/characters/:id/loot - Add item to loot
router.post('/characters/:id/loot', (req: Request, res: Response) => {
  const charId = String(req.params.id);
  const { itemName, itemSlug, customItemId, itemRarity, quantity } = req.body;
  const id = uuidv4();
  db.prepare(
    'INSERT INTO loot_entries (id, character_id, item_slug, custom_item_id, item_name, item_rarity, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, charId, itemSlug || null, customItemId || null, itemName, itemRarity || 'common', quantity || 1);
  res.status(201).json({ id, characterId: charId, itemName, itemRarity: itemRarity || 'common', quantity: quantity || 1 });
});

// DELETE /api/characters/:id/loot/:entryId - Remove loot entry
router.delete('/characters/:id/loot/:entryId', (req: Request, res: Response) => {
  db.prepare('DELETE FROM loot_entries WHERE id = ? AND character_id = ?').run(req.params.entryId, String(req.params.id));
  res.json({ success: true });
});

// PATCH /api/characters/:id/loot/:entryId - Update quantity or equipped
router.patch('/characters/:id/loot/:entryId', (req: Request, res: Response) => {
  const { quantity, equipped } = req.body;
  const entryId = req.params.entryId;
  const charId = String(req.params.id);

  if (quantity !== undefined) {
    if (typeof quantity !== 'number' || quantity < 0) {
      res.status(400).json({ error: 'Invalid quantity' });
      return;
    }
    if (quantity === 0) {
      db.prepare('DELETE FROM loot_entries WHERE id = ? AND character_id = ?').run(entryId, charId);
    } else {
      db.prepare('UPDATE loot_entries SET quantity = ? WHERE id = ? AND character_id = ?').run(quantity, entryId, charId);
    }
  }

  if (equipped !== undefined) {
    db.prepare('UPDATE loot_entries SET equipped = ? WHERE id = ? AND character_id = ?').run(equipped ? 1 : 0, entryId, charId);
  }

  res.json({ success: true });
});

// POST /api/characters/:id/loot/take - Player takes item from loot
router.post('/characters/:id/loot/take', (req: Request, res: Response) => {
  const creatureCharId = String(req.params.id);
  const { entryId, targetCharacterId } = req.body;

  const entry = db.prepare('SELECT * FROM loot_entries WHERE id = ? AND character_id = ?').get(entryId, creatureCharId) as any;
  if (!entry) { res.status(404).json({ error: 'Loot entry not found' }); return; }

  const targetChar = db.prepare('SELECT id, inventory FROM characters WHERE id = ?').get(targetCharacterId) as any;
  if (!targetChar) { res.status(404).json({ error: 'Target character not found' }); return; }

  const inventory = JSON.parse(targetChar.inventory || '[]');

  // Build a rich inventory item from compendium data if available
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

  // Helper to map type string to inventory type
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

  // Enrich from compendium item
  if (slug) {
    const compItem = db.prepare('SELECT * FROM compendium_items WHERE slug = ?').get(slug) as any;
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

      // Fallback: parse damage from description for magic weapons
      if (!damage && itemType === 'weapon' && description) {
        const m = description.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(slashing|piercing|bludgeoning|fire|cold|lightning|thunder|acid|poison|necrotic|radiant|force|psychic)/i);
        if (m) { damage = m[1].replace(/\s/g, ''); damageType = m[2].toLowerCase(); }
      }
    }
  }

  // Enrich from custom item
  if (customItemId) {
    const ci = db.prepare('SELECT * FROM custom_items WHERE id = ?').get(customItemId) as any;
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

  // Check if this item already exists in inventory (stack by slug or name)
  const existingIdx = inventory.findIndex((i: any) =>
    (slug && i.slug === slug) || (!slug && i.name === entry.item_name && i.type === itemType)
  );

  if (existingIdx >= 0) {
    // Stack: increment quantity
    inventory[existingIdx].quantity = (inventory[existingIdx].quantity || 1) + 1;
  } else {
    // New item
    const newItem: Record<string, unknown> = {
      name: entry.item_name,
      quantity: 1,
      weight,
      description,
      equipped: false,
      type: itemType,
      cost,
      rarity,
      slug,
      imageUrl: slug ? `/uploads/items/${slug}.png` : null,
    };
    if (attunement) newItem.attunement = true;
    if (damage) newItem.damage = damage;
    if (damageType) newItem.damageType = damageType;
    if (properties.length > 0) newItem.properties = properties;
    if (range) newItem.range = range;
    if (acBonus !== undefined) newItem.acBonus = acBonus;
    inventory.push(newItem);
  }

  // Also store custom_item_id on inventory item for future lookups
  if (customItemId) {
    const lastItem = inventory[inventory.length - 1];
    if (lastItem && !lastItem.slug) lastItem.customItemId = customItemId;
  }

  const inventoryJson = JSON.stringify(inventory);

  // Update inventory and remove/decrement loot entry
  const tx = db.transaction(() => {
    db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(inventoryJson, targetCharacterId);
    if (entry.quantity <= 1) {
      db.prepare('DELETE FROM loot_entries WHERE id = ?').run(entryId);
    } else {
      db.prepare('UPDATE loot_entries SET quantity = quantity - 1 WHERE id = ?').run(entryId);
    }
  });
  tx();

  res.json({ success: true, itemName: entry.item_name, inventory, targetCharacterId });
});

// POST /api/characters/:id/inventory/enrich - Match inventory items to compendium and add slugs/images
router.post('/characters/:id/inventory/enrich', (req: Request, res: Response) => {
  const charId = String(req.params.id);
  const char = db.prepare('SELECT id, inventory FROM characters WHERE id = ?').get(charId) as any;
  if (!char) { res.status(404).json({ error: 'Character not found' }); return; }

  const inventory = JSON.parse(char.inventory || '[]');
  let updated = false;

  // DDB name aliases → compendium name
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
    if (item.slug) continue; // Already matched

    const nameLower = item.name.toLowerCase().trim();

    // Try direct name match
    let match = db.prepare('SELECT slug, type, rarity, raw_json FROM compendium_items WHERE LOWER(name) = ? LIMIT 1').get(nameLower) as any;

    // Try alias
    if (!match && aliases[nameLower]) {
      match = db.prepare('SELECT slug, type, rarity, raw_json FROM compendium_items WHERE slug = ? LIMIT 1').get(aliases[nameLower]) as any;
    }

    // Try fuzzy match (name contains)
    if (!match) {
      match = db.prepare('SELECT slug, type, rarity, raw_json FROM compendium_items WHERE LOWER(name) LIKE ? AND source = \'PHB Equipment\' LIMIT 1').get(`${nameLower}%`) as any;
    }

    if (match) {
      item.slug = match.slug;
      item.imageUrl = `/uploads/items/${match.slug}.png`;
      item.rarity = item.rarity || match.rarity || 'common';
      // Enrich with compendium stats if missing
      try {
        const raw = JSON.parse(match.raw_json || '{}');
        if (!item.damage && raw.damage) { item.damage = raw.damage; item.damageType = raw.damageType || ''; }
        if (!item.properties && raw.properties) item.properties = raw.properties;
        if (raw.range && !item.range) item.range = raw.range;
        if (!item.weight && raw.weight) item.weight = raw.weight;
        if (!item.cost && raw.costGp) item.cost = raw.costGp;
      } catch { /* ignore */ }
      // Map type
      const cType = (match.type || '').toLowerCase();
      if (cType.includes('weapon') && item.type === 'gear') item.type = 'weapon';
      else if ((cType.includes('armor') || cType.includes('shield')) && item.type === 'gear') item.type = 'armor';
      updated = true;
    }
  }

  if (updated) {
    db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), charId);
  }

  res.json({ success: true, updated, inventory });
});

// POST /api/characters/:id/loot/drop - Drop an item from inventory onto the map as a loot token
router.post('/characters/:id/loot/drop', (req: Request, res: Response) => {
  const charId = String(req.params.id);
  const { itemIndex, mapId, x, y } = req.body;

  // Get character inventory
  const char = db.prepare('SELECT id, inventory FROM characters WHERE id = ?').get(charId) as any;
  if (!char) { res.status(404).json({ error: 'Character not found' }); return; }

  const inventory = JSON.parse(char.inventory || '[]');
  if (itemIndex < 0 || itemIndex >= inventory.length) { res.status(400).json({ error: 'Invalid item index' }); return; }

  const item = inventory[itemIndex];

  // Create a loot bag character
  const lootCharId = uuidv4();
  db.prepare(`INSERT INTO characters (id, user_id, name, race, class, level, hit_points, max_hit_points, armor_class)
    VALUES (?, 'npc', ?, 'loot', 'bag', 1, 0, 1, 0)`)
    .run(lootCharId, `Dropped: ${item.name}`);

  // Add item to loot_entries
  const lootEntryId = uuidv4();
  db.prepare(`INSERT INTO loot_entries (id, character_id, item_slug, custom_item_id, item_name, item_rarity, quantity)
    VALUES (?, ?, ?, ?, ?, ?, 1)`)
    .run(lootEntryId, lootCharId, item.slug || null, item.customItemId || null, item.name, item.rarity || 'common');

  // Remove item from inventory (or decrement quantity)
  if (item.quantity > 1) {
    inventory[itemIndex] = { ...item, quantity: item.quantity - 1 };
  } else {
    inventory.splice(itemIndex, 1);
  }
  db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), charId);

  // Build token data for the caller to emit via socket
  const imgUrl = item.imageUrl || (item.slug ? `/uploads/items/${item.slug}.png` : '/uploads/items/default-item.svg');

  res.json({
    success: true,
    inventory, // updated inventory for the character
    token: {
      mapId,
      characterId: lootCharId,
      name: item.name,
      x: x || 0,
      y: y || 0,
      size: 0.5,
      imageUrl: imgUrl,
      color: '#d4a843',
      layer: 'token',
      visible: true,
      hasLight: false,
      lightRadius: 0,
      lightDimRadius: 0,
      lightColor: '#ffcc44',
      conditions: [],
      ownerUserId: null,
    },
  });
});

export default router;
