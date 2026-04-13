import pool from '../db/connection.js';

const CR_MAP: Record<string, number> = { '0': 0, '1/8': 0.125, '1/4': 0.25, '1/2': 0.5 };

function parseCR(cr: string): number {
  if (CR_MAP[cr] !== undefined) return CR_MAP[cr];
  const n = parseFloat(cr);
  return isNaN(n) ? 0 : n;
}

function parseSpellLevel(levelStr: string): number {
  if (!levelStr) return 0;
  const lower = levelStr.toLowerCase();
  if (lower === 'cantrip') return 0;
  const match = lower.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

async function fetchAllPages(baseUrl: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let url: string | null = baseUrl;
  let page = 0;

  while (url) {
    page++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timeout);
      if (!response.ok) { console.warn(`Open5e API error: ${response.status} for ${url}`); break; }
      const data = (await response.json()) as { results: unknown[]; next: string | null };
      results.push(...data.results);
      url = data.next;
      if (page % 3 === 0) console.log(`  Fetched ${results.length} records...`);
    } catch (err) {
      console.warn(`Fetch failed for ${url}: ${(err as Error).message}. Got ${results.length} records so far.`);
      break;
    }
  }
  return results;
}

export async function isCompendiumSeeded(): Promise<boolean> {
  const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM compendium_monsters');
  return Number(rows[0].cnt) > 0;
}

export async function getCompendiumStats(): Promise<{ monsterCount: number; spellCount: number; itemCount: number }> {
  const [m, s, i] = await Promise.all([
    pool.query('SELECT COUNT(*) as cnt FROM compendium_monsters'),
    pool.query('SELECT COUNT(*) as cnt FROM compendium_spells'),
    pool.query('SELECT COUNT(*) as cnt FROM compendium_items'),
  ]);
  return { monsterCount: Number(m.rows[0].cnt), spellCount: Number(s.rows[0].cnt), itemCount: Number(i.rows[0].cnt) };
}

async function seedMonsters(rawMonsters: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const raw of rawMonsters) {
      const m = raw as Record<string, unknown>;
      const slug = (m.slug as string) ?? '';
      const name = (m.name as string) ?? '';
      const size = (m.size as string) ?? '';
      const type = (m.type as string) ?? '';
      const alignment = (m.alignment as string) ?? '';
      const armorClass = typeof m.armor_class === 'number' ? m.armor_class : 10;
      const hitPoints = typeof m.hit_points === 'number' ? m.hit_points : 1;
      const hitDice = (m.hit_dice as string) ?? '';

      let speed: Record<string, number> = {};
      if (m.speed && typeof m.speed === 'object') {
        const speedObj = m.speed as Record<string, unknown>;
        for (const [key, val] of Object.entries(speedObj)) {
          if (typeof val === 'number') speed[key] = val;
          else if (typeof val === 'string') { const parsed = parseInt(val, 10); if (!isNaN(parsed)) speed[key] = parsed; }
        }
      }

      const abilityScores = {
        str: typeof m.strength === 'number' ? m.strength : 10,
        dex: typeof m.dexterity === 'number' ? m.dexterity : 10,
        con: typeof m.constitution === 'number' ? m.constitution : 10,
        int: typeof m.intelligence === 'number' ? m.intelligence : 10,
        wis: typeof m.wisdom === 'number' ? m.wisdom : 10,
        cha: typeof m.charisma === 'number' ? m.charisma : 10,
      };

      const cr = (m.challenge_rating as string) ?? '0';
      const actions = Array.isArray(m.actions) ? m.actions : [];
      const specialAbilities = Array.isArray(m.special_abilities) ? m.special_abilities : [];
      const legendaryActions = Array.isArray(m.legendary_actions) ? m.legendary_actions : [];
      const source = (m.document__title as string) ?? 'SRD';

      await client.query(`
        INSERT INTO compendium_monsters
          (slug, name, size, type, alignment, armor_class, hit_points, hit_dice,
           speed, ability_scores, challenge_rating, cr_numeric,
           actions, special_abilities, legendary_actions,
           description, senses, languages,
           damage_resistances, damage_immunities, condition_immunities,
           source, raw_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT (slug) DO UPDATE SET name=$2, raw_json=$23
      `, [
        slug, name, size, type, alignment, armorClass, hitPoints, hitDice,
        JSON.stringify(speed), JSON.stringify(abilityScores), cr, parseCR(cr),
        JSON.stringify(actions), JSON.stringify(specialAbilities), JSON.stringify(legendaryActions),
        (m.desc as string) ?? '', (m.senses as string) ?? '', (m.languages as string) ?? '',
        (m.damage_resistances as string) ?? '', (m.damage_immunities as string) ?? '',
        (m.condition_immunities as string) ?? '', source, JSON.stringify(m),
      ]);
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function seedSpells(rawSpells: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const raw of rawSpells) {
      const s = raw as Record<string, unknown>;
      const slug = (s.slug as string) ?? '';
      const name = (s.name as string) ?? '';
      let level = 0;
      if (typeof s.level === 'number') level = s.level;
      else if (typeof s.level_int === 'number') level = s.level_int;
      else if (typeof s.level === 'string') level = parseSpellLevel(s.level);
      let concentration = 0;
      if (typeof s.concentration === 'boolean') concentration = s.concentration ? 1 : 0;
      else if (typeof s.concentration === 'string') concentration = s.concentration.toLowerCase() === 'yes' ? 1 : 0;
      let ritual = 0;
      if (typeof s.ritual === 'boolean') ritual = s.ritual ? 1 : 0;
      else if (typeof s.ritual === 'string') ritual = s.ritual.toLowerCase() === 'yes' ? 1 : 0;
      let classes: string[] = [];
      if (typeof s.dnd_class === 'string' && s.dnd_class) classes = s.dnd_class.split(',').map((c: string) => c.trim()).filter(Boolean);
      else if (Array.isArray(s.classes)) classes = s.classes as string[];
      const source = (s.document__title as string) ?? 'SRD';

      await client.query(`
        INSERT INTO compendium_spells
          (slug, name, level, school, casting_time, range, components, duration,
           description, higher_levels, concentration, ritual, classes, source, raw_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (slug) DO UPDATE SET name=$2, raw_json=$15
      `, [
        slug, name, level, (s.school as string) ?? '', (s.casting_time as string) ?? '',
        (s.range as string) ?? '', (s.components as string) ?? '', (s.duration as string) ?? '',
        (s.desc as string) ?? '', (s.higher_level as string) ?? '',
        concentration, ritual, JSON.stringify(classes), source, JSON.stringify(s),
      ]);
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function seedItems(rawItems: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const raw of rawItems) {
      const i = raw as Record<string, unknown>;
      const slug = (i.slug as string) ?? '';
      const name = (i.name as string) ?? '';
      let requiresAttunement = 0;
      if (typeof i.requires_attunement === 'boolean') requiresAttunement = i.requires_attunement ? 1 : 0;
      else if (typeof i.requires_attunement === 'string') requiresAttunement = i.requires_attunement.toLowerCase().includes('requires attunement') ? 1 : 0;
      const source = (i.document__title as string) ?? 'SRD';

      await client.query(`
        INSERT INTO compendium_items (slug, name, type, rarity, requires_attunement, description, source, raw_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (slug) DO UPDATE SET name=$2, raw_json=$8
      `, [slug, name, (i.type as string) ?? '', (i.rarity as string) ?? '', requiresAttunement, (i.desc as string) ?? '', source, JSON.stringify(i)]);
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

export async function seedCompendium(): Promise<void> {
  console.log('Fetching monsters from Open5e...');
  const rawMonsters = await fetchAllPages('https://api.open5e.com/v1/monsters/?format=json&limit=50');
  console.log(`Seeding monsters... ${rawMonsters.length} fetched`);
  await seedMonsters(rawMonsters);
  console.log(`Monsters seeded: ${rawMonsters.length}`);

  console.log('Fetching spells from Open5e...');
  const rawSpells = await fetchAllPages('https://api.open5e.com/v1/spells/?format=json&limit=50');
  console.log(`Seeding spells... ${rawSpells.length} fetched`);
  await seedSpells(rawSpells);
  console.log(`Spells seeded: ${rawSpells.length}`);

  console.log('Fetching magic items from Open5e...');
  const rawItems = await fetchAllPages('https://api.open5e.com/v1/magicitems/?format=json&limit=50');
  console.log(`Seeding items... ${rawItems.length} fetched`);
  await seedItems(rawItems);
  console.log(`Items seeded: ${rawItems.length}`);

  const stats = await getCompendiumStats();
  console.log(`Compendium seeded: ${stats.monsterCount} monsters, ${stats.spellCount} spells, ${stats.itemCount} items`);
}

export async function reseedCompendium(): Promise<void> {
  await pool.query('DELETE FROM compendium_monsters');
  await pool.query('DELETE FROM compendium_spells');
  await pool.query('DELETE FROM compendium_items');
  await seedCompendium();
}
