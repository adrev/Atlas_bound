import db from './connection.js';

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT UNIQUE NOT NULL,
      dm_user_id TEXT NOT NULL,
      current_map_id TEXT,
      player_map_id TEXT,
      combat_active INTEGER DEFAULT 0,
      game_mode TEXT DEFAULT 'free-roam',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      settings TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_players (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'player',
      character_id TEXT,
      PRIMARY KEY (session_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      race TEXT NOT NULL DEFAULT '',
      class TEXT NOT NULL DEFAULT '',
      level INTEGER DEFAULT 1,
      hit_points INTEGER NOT NULL DEFAULT 10,
      max_hit_points INTEGER NOT NULL DEFAULT 10,
      temp_hit_points INTEGER DEFAULT 0,
      armor_class INTEGER NOT NULL DEFAULT 10,
      speed INTEGER DEFAULT 30,
      proficiency_bonus INTEGER DEFAULT 2,
      ability_scores TEXT NOT NULL DEFAULT '{"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}',
      saving_throws TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '{}',
      spell_slots TEXT NOT NULL DEFAULT '{}',
      spells TEXT NOT NULL DEFAULT '[]',
      features TEXT NOT NULL DEFAULT '[]',
      inventory TEXT NOT NULL DEFAULT '[]',
      death_saves TEXT DEFAULT '{"successes":0,"failures":0}',
      portrait_url TEXT,
      dndbeyond_id TEXT,
      dndbeyond_json TEXT,
      source TEXT DEFAULT 'manual',
      background TEXT DEFAULT '{"name":"","description":"","feature":""}',
      characteristics TEXT DEFAULT '{"alignment":"","gender":"","eyes":"","hair":"","skin":"","height":"","weight":"","age":"","faith":"","size":"Medium"}',
      personality TEXT DEFAULT '{"traits":"","ideals":"","bonds":"","flaws":""}',
      notes_data TEXT DEFAULT '{"organizations":"","allies":"","enemies":"","backstory":"","other":""}',
      proficiencies_data TEXT DEFAULT '{"armor":[],"weapons":[],"tools":[],"languages":[]}',
      senses TEXT DEFAULT '{"passivePerception":10,"passiveInvestigation":10,"passiveInsight":10,"darkvision":0}',
      defenses TEXT DEFAULT '{"resistances":[],"immunities":[],"vulnerabilities":[]}',
      conditions TEXT DEFAULT '[]',
      currency TEXT DEFAULT '{"cp":0,"sp":0,"ep":0,"gp":0,"pp":0}',
      extras TEXT DEFAULT '[]',
      spellcasting_ability TEXT DEFAULT '',
      spell_attack_bonus INTEGER DEFAULT 0,
      spell_save_dc INTEGER DEFAULT 10,
      initiative INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS maps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      image_url TEXT,
      width INTEGER NOT NULL DEFAULT 1400,
      height INTEGER NOT NULL DEFAULT 1050,
      grid_size INTEGER DEFAULT 70,
      grid_type TEXT DEFAULT 'square',
      grid_offset_x INTEGER DEFAULT 0,
      grid_offset_y INTEGER DEFAULT 0,
      walls TEXT DEFAULT '[]',
      fog_state TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      character_id TEXT,
      name TEXT NOT NULL DEFAULT 'Token',
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      size REAL DEFAULT 1,
      image_url TEXT,
      color TEXT DEFAULT '#666666',
      layer TEXT DEFAULT 'token',
      visible INTEGER DEFAULT 1,
      has_light INTEGER DEFAULT 0,
      light_radius REAL DEFAULT 0,
      light_dim_radius REAL DEFAULT 0,
      light_color TEXT DEFAULT '#ffcc44',
      conditions TEXT DEFAULT '[]',
      owner_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS combat_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      round_number INTEGER DEFAULT 1,
      current_turn_index INTEGER DEFAULT 0,
      combatants TEXT NOT NULL DEFAULT '[]',
      action_economy TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'ooc',
      content TEXT NOT NULL DEFAULT '',
      character_name TEXT,
      whisper_to TEXT,
      roll_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_tokens_map
      ON tokens(map_id);

    CREATE INDEX IF NOT EXISTS idx_maps_session
      ON maps(session_id);

    CREATE INDEX IF NOT EXISTS idx_session_players_user
      ON session_players(user_id);

    -- DM / player drawings. One row per committed (non-ephemeral)
    -- drawing. Geometry is a JSON blob whose shape depends on kind.
    CREATE TABLE IF NOT EXISTS drawings (
      id TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      creator_user_id TEXT NOT NULL,
      creator_role TEXT NOT NULL,
      kind TEXT NOT NULL,
      visibility TEXT NOT NULL,
      color TEXT NOT NULL,
      stroke_width REAL NOT NULL,
      geometry TEXT NOT NULL,
      grid_snapped INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      fade_after_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_drawings_map
      ON drawings(map_id);

    -- Compendium tables
    CREATE TABLE IF NOT EXISTS compendium_monsters (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size TEXT, type TEXT, alignment TEXT,
      armor_class INTEGER, hit_points INTEGER, hit_dice TEXT,
      speed TEXT DEFAULT '{}',
      ability_scores TEXT DEFAULT '{}',
      challenge_rating TEXT, cr_numeric REAL DEFAULT 0,
      actions TEXT DEFAULT '[]',
      special_abilities TEXT DEFAULT '[]',
      legendary_actions TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      senses TEXT DEFAULT '', languages TEXT DEFAULT '',
      damage_resistances TEXT DEFAULT '',
      damage_immunities TEXT DEFAULT '',
      condition_immunities TEXT DEFAULT '',
      source TEXT DEFAULT 'SRD',
      raw_json TEXT DEFAULT '{}',
      cached_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS compendium_spells (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      school TEXT DEFAULT '',
      casting_time TEXT DEFAULT '',
      range TEXT DEFAULT '',
      components TEXT DEFAULT '',
      duration TEXT DEFAULT '',
      description TEXT DEFAULT '',
      higher_levels TEXT DEFAULT '',
      concentration INTEGER DEFAULT 0,
      ritual INTEGER DEFAULT 0,
      classes TEXT DEFAULT '[]',
      source TEXT DEFAULT 'SRD',
      raw_json TEXT DEFAULT '{}',
      cached_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS compendium_items (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT '',
      rarity TEXT DEFAULT '',
      requires_attunement INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      source TEXT DEFAULT 'SRD',
      raw_json TEXT DEFAULT '{}',
      cached_at TEXT DEFAULT (datetime('now'))
    );


    CREATE TABLE IF NOT EXISTS custom_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'gear',
      rarity TEXT DEFAULT 'common',
      description TEXT DEFAULT '',
      image_url TEXT,
      weight REAL DEFAULT 0,
      value_gp REAL DEFAULT 0,
      requires_attunement INTEGER DEFAULT 0,
      stat_effects TEXT DEFAULT '{}',
      properties TEXT DEFAULT '[]',
      damage TEXT DEFAULT '',
      damage_type TEXT DEFAULT '',
      history TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS loot_entries (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      item_slug TEXT,
      custom_item_id TEXT,
      item_name TEXT NOT NULL,
      item_rarity TEXT DEFAULT 'common',
      quantity INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      equipped INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_custom_items_session ON custom_items(session_id);
    CREATE INDEX IF NOT EXISTS idx_loot_entries_character ON loot_entries(character_id);

    -- Create a system NPC user for creature character records
    INSERT OR IGNORE INTO users (id, display_name) VALUES ('npc', 'NPC/Creature');
  `);

  // Safe migrations — add columns if they don't exist
  try { db.exec(`ALTER TABLE compendium_monsters ADD COLUMN token_image_source TEXT DEFAULT 'generated'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE compendium_items ADD COLUMN token_image_source TEXT DEFAULT 'none'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE chat_messages ADD COLUMN hidden INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN hit_dice TEXT DEFAULT '[]'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN concentrating_on TEXT`); } catch { /* exists */ }

  // Map Builder / Player Ribbon — add player_map_id to sessions so we can
  // decouple "where the DM is viewing" from "where the players are on the
  // map". Backfill from existing current_map_id so existing sessions keep
  // working. current_map_id stays as the DM's ephemeral viewing pointer
  // (used for DM reconnect rehydration).
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN player_map_id TEXT`);
    db.exec(`UPDATE sessions SET player_map_id = current_map_id WHERE player_map_id IS NULL AND current_map_id IS NOT NULL`);
  } catch { /* exists */ }
  // Spell-related fields. These exist in the CREATE TABLE definition but
  // weren't there originally, so existing databases need them backfilled
  // via ALTER TABLE. Without these the spell save DC defaults to 10 and
  // every save against a player's spell looks artificially easy.
  try { db.exec(`ALTER TABLE characters ADD COLUMN spellcasting_ability TEXT DEFAULT ''`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN spell_attack_bonus INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN spell_save_dc INTEGER DEFAULT 10`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN initiative INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN background TEXT DEFAULT '{"name":"","description":"","feature":""}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN characteristics TEXT DEFAULT '{}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN personality TEXT DEFAULT '{}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN notes_data TEXT DEFAULT '{}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN proficiencies_data TEXT DEFAULT '{"armor":[],"weapons":[],"tools":[],"languages":[]}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN senses TEXT DEFAULT '{}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN defenses TEXT DEFAULT '{}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN conditions TEXT DEFAULT '[]'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN currency TEXT DEFAULT '{"cp":0,"sp":0,"ep":0,"gp":0,"pp":0}'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN extras TEXT DEFAULT '[]'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE characters ADD COLUMN compendium_slug TEXT DEFAULT NULL`); } catch { /* exists */ }

  // Backfill spellcasting fields for existing DDB-imported characters that
  // were created before these columns existed. Computes spell_save_dc and
  // spell_attack_bonus from the character's class, level, and primary
  // ability score whenever those fields are still 0/empty.
  try { backfillSpellcastingFromExistingChars(db); } catch (err) {
    console.warn('[migration] Failed to backfill spellcasting fields:', err);
  }

  // Custom content tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_monsters (
      slug TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      size TEXT DEFAULT 'Medium',
      type TEXT DEFAULT 'Humanoid',
      alignment TEXT DEFAULT '',
      armor_class INTEGER DEFAULT 10,
      hit_points INTEGER DEFAULT 10,
      hit_dice TEXT DEFAULT '1d8',
      speed TEXT DEFAULT '{"walk":30}',
      ability_scores TEXT DEFAULT '{"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}',
      challenge_rating TEXT DEFAULT '0',
      cr_numeric REAL DEFAULT 0,
      actions TEXT DEFAULT '[]',
      special_abilities TEXT DEFAULT '[]',
      legendary_actions TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      senses TEXT DEFAULT '',
      languages TEXT DEFAULT '',
      damage_resistances TEXT DEFAULT '',
      damage_immunities TEXT DEFAULT '',
      condition_immunities TEXT DEFAULT '',
      source TEXT DEFAULT 'Custom',
      image_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_spells (
      slug TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      school TEXT DEFAULT 'Evocation',
      casting_time TEXT DEFAULT '1 action',
      range TEXT DEFAULT '30 feet',
      components TEXT DEFAULT 'V, S',
      duration TEXT DEFAULT 'Instantaneous',
      description TEXT DEFAULT '',
      higher_levels TEXT DEFAULT '',
      concentration INTEGER DEFAULT 0,
      ritual INTEGER DEFAULT 0,
      classes TEXT DEFAULT '[]',
      source TEXT DEFAULT 'Custom',
      image_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_monsters_session ON custom_monsters(session_id);
    CREATE INDEX IF NOT EXISTS idx_custom_spells_session ON custom_spells(session_id);
  `);

  // Spell combat resolution columns — added after initial schema.
  const spellCombatCols: [string, string][] = [
    ['damage', 'TEXT DEFAULT NULL'],
    ['damage_type', 'TEXT DEFAULT NULL'],
    ['saving_throw', 'TEXT DEFAULT NULL'],
    ['attack_type', 'TEXT DEFAULT NULL'],
    ['aoe_type', 'TEXT DEFAULT NULL'],
    ['aoe_size', 'INTEGER DEFAULT 0'],
    ['half_on_save', 'INTEGER DEFAULT 0'],
    ['push_distance', 'INTEGER DEFAULT 0'],
    ['applies_condition', 'TEXT DEFAULT NULL'],
    ['animation_type', 'TEXT DEFAULT NULL'],
    ['animation_color', 'TEXT DEFAULT NULL'],
  ];
  for (const [col, def] of spellCombatCols) {
    try { db.exec(`ALTER TABLE custom_spells ADD COLUMN ${col} ${def}`); } catch { /* exists */ }
  }
}

/**
 * One-time backfill for characters that were created before the
 * spell_save_dc / spell_attack_bonus / spellcasting_ability columns
 * existed. Computes the values from the character's class, level, and
 * ability scores. Only touches rows where the values are still default
 * (0 / empty), so re-running is idempotent.
 */
function backfillSpellcastingFromExistingChars(db: import('better-sqlite3').Database): void {
  // Class → primary spellcasting ability. Half-casters and unusual cases
  // fall back to a sensible default; this is a backfill for testing, not
  // perfect canonical data.
  const CLASS_ABILITY: Record<string, string> = {
    bard: 'cha', cleric: 'wis', druid: 'wis', paladin: 'cha',
    ranger: 'wis', sorcerer: 'cha', warlock: 'cha', wizard: 'int',
    artificer: 'int',
  };

  const rows = db.prepare(`
    SELECT id, class, level, ability_scores, proficiency_bonus,
           spell_save_dc, spell_attack_bonus, spellcasting_ability
    FROM characters
    WHERE (spell_save_dc IS NULL OR spell_save_dc = 0 OR spell_save_dc = 10)
      AND class != ''
  `).all() as Array<Record<string, unknown>>;

  if (rows.length === 0) return;

  const update = db.prepare(`
    UPDATE characters
    SET spellcasting_ability = ?, spell_attack_bonus = ?, spell_save_dc = ?
    WHERE id = ?
  `);

  let updated = 0;
  for (const row of rows) {
    const classStr = (row.class as string) || '';
    const lowerClass = classStr.toLowerCase();
    // Pick the first matching class word
    let ability: string | null = null;
    for (const [key, val] of Object.entries(CLASS_ABILITY)) {
      if (lowerClass.includes(key)) { ability = val; break; }
    }
    if (!ability) continue;

    let scores: Record<string, number> = {};
    try { scores = JSON.parse((row.ability_scores as string) || '{}'); } catch { /* ignore */ }
    const score = scores[ability] ?? 10;
    const mod = Math.floor((score - 10) / 2);
    const profBonus = (row.proficiency_bonus as number) || 2;
    const dc = 8 + profBonus + mod;
    const atkBonus = profBonus + mod;

    update.run(ability, atkBonus, dc, row.id);
    updated++;
  }

  if (updated > 0) {
    console.log(`[migration] Backfilled spellcasting fields on ${updated} character${updated !== 1 ? 's' : ''}`);
  }
}
