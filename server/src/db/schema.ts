import pool from './connection.js';

export async function initDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT UNIQUE NOT NULL,
      dm_user_id TEXT NOT NULL,
      current_map_id TEXT,
      player_map_id TEXT,
      combat_active INTEGER DEFAULT 0,
      game_mode TEXT DEFAULT 'free-roam',
      created_at TEXT NOT NULL DEFAULT (NOW()::text),
      updated_at TEXT NOT NULL DEFAULT (NOW()::text),
      settings TEXT DEFAULT '{}',
      visibility TEXT NOT NULL DEFAULT 'public',
      password_hash TEXT,
      invite_code TEXT
    );

    -- Privacy columns for legacy sessions that pre-date the feature.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS invite_code TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_invite_code
      ON sessions(invite_code) WHERE invite_code IS NOT NULL;

    CREATE TABLE IF NOT EXISTS session_bans (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      banned_by  TEXT NOT NULL,
      banned_at  TEXT NOT NULL DEFAULT (NOW()::text),
      reason     TEXT,
      PRIMARY KEY (session_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_bans_session ON session_bans(session_id);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      auth_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (NOW()::text)
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
      hit_dice TEXT DEFAULT '[]',
      concentrating_on TEXT,
      compendium_slug TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (NOW()::text),
      updated_at TEXT NOT NULL DEFAULT (NOW()::text)
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
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()::text)
    );

    -- display_order added 2026-04-15 for map reorder. Legacy rows get
    -- their created_at rank so the existing list stays stable until
    -- the DM drags something.
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
    UPDATE maps SET display_order = sub.rn FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC) AS rn
      FROM maps
    ) AS sub WHERE maps.id = sub.id AND maps.display_order = 0;

    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      character_id TEXT,
      name TEXT NOT NULL DEFAULT 'Token',
      x DOUBLE PRECISION NOT NULL DEFAULT 0,
      y DOUBLE PRECISION NOT NULL DEFAULT 0,
      size DOUBLE PRECISION DEFAULT 1,
      image_url TEXT,
      color TEXT DEFAULT '#666666',
      layer TEXT DEFAULT 'token',
      visible INTEGER DEFAULT 1,
      has_light INTEGER DEFAULT 0,
      light_radius DOUBLE PRECISION DEFAULT 0,
      light_dim_radius DOUBLE PRECISION DEFAULT 0,
      light_color TEXT DEFAULT '#ffcc44',
      conditions TEXT DEFAULT '[]',
      owner_user_id TEXT,
      faction TEXT NOT NULL DEFAULT 'neutral',
      created_at TEXT NOT NULL DEFAULT (NOW()::text)
    );

    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS faction TEXT NOT NULL DEFAULT 'neutral';

    CREATE TABLE IF NOT EXISTS combat_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      round_number INTEGER DEFAULT 1,
      current_turn_index INTEGER DEFAULT 0,
      combatants TEXT NOT NULL DEFAULT '[]',
      action_economy TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (NOW()::text)
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
      hidden INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()::text)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_tokens_map
      ON tokens(map_id);

    CREATE INDEX IF NOT EXISTS idx_maps_session
      ON maps(session_id);

    CREATE INDEX IF NOT EXISTS idx_session_players_user
      ON session_players(user_id);

    CREATE TABLE IF NOT EXISTS drawings (
      id TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      creator_user_id TEXT NOT NULL,
      creator_role TEXT NOT NULL,
      kind TEXT NOT NULL,
      visibility TEXT NOT NULL,
      color TEXT NOT NULL,
      stroke_width DOUBLE PRECISION NOT NULL,
      geometry TEXT NOT NULL,
      grid_snapped INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      fade_after_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_drawings_map
      ON drawings(map_id);

    CREATE TABLE IF NOT EXISTS compendium_monsters (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size TEXT, type TEXT, alignment TEXT,
      armor_class INTEGER, hit_points INTEGER, hit_dice TEXT,
      speed TEXT DEFAULT '{}',
      ability_scores TEXT DEFAULT '{}',
      challenge_rating TEXT, cr_numeric DOUBLE PRECISION DEFAULT 0,
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
      token_image_source TEXT DEFAULT 'generated',
      cached_at TEXT DEFAULT (NOW()::text)
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
      cached_at TEXT DEFAULT (NOW()::text)
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
      token_image_source TEXT DEFAULT 'none',
      cached_at TEXT DEFAULT (NOW()::text)
    );

    CREATE TABLE IF NOT EXISTS custom_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'gear',
      rarity TEXT DEFAULT 'common',
      description TEXT DEFAULT '',
      image_url TEXT,
      weight DOUBLE PRECISION DEFAULT 0,
      value_gp DOUBLE PRECISION DEFAULT 0,
      requires_attunement INTEGER DEFAULT 0,
      stat_effects TEXT DEFAULT '{}',
      properties TEXT DEFAULT '[]',
      damage TEXT DEFAULT '',
      damage_type TEXT DEFAULT '',
      history TEXT DEFAULT '',
      range TEXT DEFAULT '',
      ac INTEGER DEFAULT 0,
      ac_type TEXT DEFAULT '',
      magic_bonus INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (NOW()::text)
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

    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      email_verified INTEGER DEFAULT 0,
      hashed_password TEXT,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT DEFAULT (NOW()::text),
      updated_at TEXT DEFAULT (NOW()::text)
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_accounts (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      provider_email TEXT,
      provider_username TEXT,
      provider_avatar_url TEXT,
      created_at TEXT DEFAULT (NOW()::text),
      PRIMARY KEY (provider, provider_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON oauth_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

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
      cr_numeric DOUBLE PRECISION DEFAULT 0,
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
      created_at TEXT DEFAULT (NOW()::text)
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
      damage TEXT DEFAULT NULL,
      damage_type TEXT DEFAULT NULL,
      saving_throw TEXT DEFAULT NULL,
      attack_type TEXT DEFAULT NULL,
      aoe_type TEXT DEFAULT NULL,
      aoe_size INTEGER DEFAULT 0,
      half_on_save INTEGER DEFAULT 0,
      push_distance INTEGER DEFAULT 0,
      applies_condition TEXT DEFAULT NULL,
      animation_type TEXT DEFAULT NULL,
      animation_color TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (NOW()::text)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_monsters_session ON custom_monsters(session_id);
    CREATE INDEX IF NOT EXISTS idx_custom_spells_session ON custom_spells(session_id);

    CREATE TABLE IF NOT EXISTS encounter_presets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      creatures TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (NOW()::text)
    );

    CREATE INDEX IF NOT EXISTS idx_encounter_presets_session ON encounter_presets(session_id);

    CREATE TABLE IF NOT EXISTS session_notes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      is_shared INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (NOW()::text),
      updated_at TEXT DEFAULT (NOW()::text)
    );

    CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes(session_id);

    CREATE TABLE IF NOT EXISTS map_zones (
      id TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Zone',
      x DOUBLE PRECISION NOT NULL DEFAULT 0,
      y DOUBLE PRECISION NOT NULL DEFAULT 0,
      width DOUBLE PRECISION NOT NULL DEFAULT 0,
      height DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (NOW()::text)
    );

    CREATE INDEX IF NOT EXISTS idx_map_zones_map ON map_zones(map_id);

    -- Owner must also be present in session_players with role='dm'.
    -- Back-fill for any legacy sessions where the owner row is missing,
    -- otherwise the co-DM logic won't find them when checking role.
    INSERT INTO session_players (session_id, user_id, role)
    SELECT s.id, s.dm_user_id, 'dm'
    FROM sessions s
    LEFT JOIN session_players sp
      ON sp.session_id = s.id AND sp.user_id = s.dm_user_id
    WHERE sp.session_id IS NULL;

    -- Any existing DM row with a different role (shouldn't happen, but
    -- defensive against manual DB edits) gets corrected to 'dm'.
    UPDATE session_players sp SET role = 'dm'
    FROM sessions s
    WHERE s.id = sp.session_id AND s.dm_user_id = sp.user_id AND sp.role <> 'dm';
  `);

  // --- Backfill invite codes for legacy sessions. --------------------------
  //
  // Sessions created before the privacy feature shipped have
  // `invite_code IS NULL`. If a DM flips one of those to private
  // without a password, there'd be no way in. Generate a fresh code
  // for each NULL row on boot.
  try {
    const { rows: needInvite } = await pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE invite_code IS NULL',
    );
    if (needInvite.length > 0) {
      const { generateInviteCode } = await import('../utils/sessionPassword.js');
      for (const row of needInvite) {
        // Collisions against the UNIQUE index are astronomically rare
        // but we retry up to 3x per row just in case.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await pool.query('UPDATE sessions SET invite_code = $1 WHERE id = $2', [generateInviteCode(), row.id]);
            break;
          } catch (err) {
            if (attempt === 2) throw err;
          }
        }
      }
      console.log(`[migration] Backfilled invite_code on ${needInvite.length} legacy session${needInvite.length !== 1 ? 's' : ''}`);
    }
  } catch (err) {
    console.warn('[migration] Failed to backfill invite_code:', err);
  }

  // --- Backfill FK cascades on tables that shipped without them. -----------
  //
  // These tables were created in production with no foreign-key constraint,
  // so a DELETE on the parent row would orphan children. Postgres has no
  // "ADD CONSTRAINT IF NOT EXISTS" so we probe first and add the constraint
  // only when it's missing. Safe to re-run on every boot.
  const CASCADE_FKS: Array<{ table: string; column: string; ref: string; onDelete: 'CASCADE' | 'SET NULL'; constraint: string }> = [
    { table: 'custom_items',    column: 'session_id',   ref: 'sessions(id)',   onDelete: 'CASCADE',  constraint: 'custom_items_session_fk' },
    { table: 'custom_monsters', column: 'session_id',   ref: 'sessions(id)',   onDelete: 'CASCADE',  constraint: 'custom_monsters_session_fk' },
    { table: 'custom_spells',   column: 'session_id',   ref: 'sessions(id)',   onDelete: 'CASCADE',  constraint: 'custom_spells_session_fk' },
    { table: 'loot_entries',    column: 'character_id', ref: 'characters(id)', onDelete: 'CASCADE',  constraint: 'loot_entries_character_fk' },
    { table: 'tokens',          column: 'character_id', ref: 'characters(id)', onDelete: 'SET NULL', constraint: 'tokens_character_fk' },
  ];

  for (const fk of CASCADE_FKS) {
    try {
      const { rows } = await pool.query(
        'SELECT 1 FROM pg_constraint WHERE conname = $1',
        [fk.constraint],
      );
      if (rows.length > 0) continue;

      // Purge orphans before adding the constraint, otherwise ADD CONSTRAINT
      // will fail against any existing dangling rows.
      const parentTable = fk.ref.split('(')[0];
      if (fk.onDelete === 'CASCADE') {
        await pool.query(
          `DELETE FROM ${fk.table} WHERE ${fk.column} IS NOT NULL AND ${fk.column} NOT IN (SELECT id FROM ${parentTable})`,
        );
      } else {
        await pool.query(
          `UPDATE ${fk.table} SET ${fk.column} = NULL WHERE ${fk.column} IS NOT NULL AND ${fk.column} NOT IN (SELECT id FROM ${parentTable})`,
        );
      }

      await pool.query(
        `ALTER TABLE ${fk.table} ADD CONSTRAINT ${fk.constraint} FOREIGN KEY (${fk.column}) REFERENCES ${fk.ref} ON DELETE ${fk.onDelete}`,
      );
      console.log(`[migration] Added FK ${fk.constraint} (${fk.table}.${fk.column} -> ${fk.ref})`);
    } catch (err) {
      console.warn(`[migration] Failed to add FK ${fk.constraint}:`, err);
    }
  }

  // Create system NPC user if it doesn't exist
  await pool.query(`
    INSERT INTO users (id, display_name) VALUES ('npc', 'NPC/Creature')
    ON CONFLICT (id) DO NOTHING
  `);

  // Backfill spellcasting fields for existing DDB-imported characters
  try { await backfillSpellcastingFromExistingChars(); } catch (err) {
    console.warn('[migration] Failed to backfill spellcasting fields:', err);
  }
}

/**
 * One-time backfill for characters that were created before the
 * spell_save_dc / spell_attack_bonus / spellcasting_ability columns
 * existed.
 */
async function backfillSpellcastingFromExistingChars(): Promise<void> {
  const CLASS_ABILITY: Record<string, string> = {
    bard: 'cha', cleric: 'wis', druid: 'wis', paladin: 'cha',
    ranger: 'wis', sorcerer: 'cha', warlock: 'cha', wizard: 'int',
    artificer: 'int',
  };

  const { rows } = await pool.query(`
    SELECT id, class, level, ability_scores, proficiency_bonus,
           spell_save_dc, spell_attack_bonus, spellcasting_ability
    FROM characters
    WHERE (spell_save_dc IS NULL OR spell_save_dc = 0 OR spell_save_dc = 10)
      AND class != ''
  `);

  if (rows.length === 0) return;

  let updated = 0;
  for (const row of rows) {
    const classStr = (row.class as string) || '';
    const lowerClass = classStr.toLowerCase();
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

    await pool.query(
      'UPDATE characters SET spellcasting_ability = $1, spell_attack_bonus = $2, spell_save_dc = $3 WHERE id = $4',
      [ability, atkBonus, dc, row.id],
    );
    updated++;
  }

  if (updated > 0) {
    console.log(`[migration] Backfilled spellcasting fields on ${updated} character${updated !== 1 ? 's' : ''}`);
  }
}
