import db from '../db/connection.js';

// --- CR parsing helper ---
const CR_MAP: Record<string, number> = {
  '0': 0, '1/8': 0.125, '1/4': 0.25, '1/2': 0.5,
};

function parseCR(cr: string): number {
  if (CR_MAP[cr] !== undefined) return CR_MAP[cr];
  const n = parseFloat(cr);
  return isNaN(n) ? 0 : n;
}

// --- Spell level parsing helper ---
function parseSpellLevel(levelStr: string): number {
  if (!levelStr) return 0;
  const lower = levelStr.toLowerCase();
  if (lower === 'cantrip') return 0;
  const match = lower.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// --- Fetch all pages from an open5e paginated endpoint ---
async function fetchAllPages(baseUrl: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let url: string | null = baseUrl;
  let page = 0;

  while (url) {
    page++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`Open5e API error: ${response.status} for ${url}, skipping remaining pages`);
        break;
      }
      const data = (await response.json()) as { results: unknown[]; next: string | null };
      results.push(...data.results);
      url = data.next;
      if (page % 3 === 0) console.log(`  Fetched ${results.length} records...`);
    } catch (err) {
      console.warn(`Fetch failed for ${url}: ${(err as Error).message}. Got ${results.length} records so far.`);
      break; // Don't fail entirely, use what we have
    }
  }

  return results;
}

// --- Check if compendium is already seeded ---
export function isCompendiumSeeded(): Promise<boolean> {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM compendium_monsters').get() as { cnt: number };
  return Promise.resolve(row.cnt > 0);
}

// --- Get compendium stats ---
export function getCompendiumStats(): { monsterCount: number; spellCount: number; itemCount: number } {
  const monsters = (db.prepare('SELECT COUNT(*) as cnt FROM compendium_monsters').get() as { cnt: number }).cnt;
  const spells = (db.prepare('SELECT COUNT(*) as cnt FROM compendium_spells').get() as { cnt: number }).cnt;
  const items = (db.prepare('SELECT COUNT(*) as cnt FROM compendium_items').get() as { cnt: number }).cnt;
  return { monsterCount: monsters, spellCount: spells, itemCount: items };
}

// --- Seed monsters ---
function seedMonsters(rawMonsters: unknown[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO compendium_monsters
      (slug, name, size, type, alignment, armor_class, hit_points, hit_dice,
       speed, ability_scores, challenge_rating, cr_numeric,
       actions, special_abilities, legendary_actions,
       description, senses, languages,
       damage_resistances, damage_immunities, condition_immunities,
       source, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = db.transaction((monsters: unknown[]) => {
    for (const raw of monsters) {
      const m = raw as Record<string, unknown>;
      const slug = (m.slug as string) ?? '';
      const name = (m.name as string) ?? '';
      const size = (m.size as string) ?? '';
      const type = (m.type as string) ?? '';
      const alignment = (m.alignment as string) ?? '';
      const armorClass = typeof m.armor_class === 'number' ? m.armor_class : 10;
      const hitPoints = typeof m.hit_points === 'number' ? m.hit_points : 1;
      const hitDice = (m.hit_dice as string) ?? '';

      // Speed: can be object or string
      let speed: Record<string, number> = {};
      if (m.speed && typeof m.speed === 'object') {
        const speedObj = m.speed as Record<string, unknown>;
        for (const [key, val] of Object.entries(speedObj)) {
          if (typeof val === 'number') speed[key] = val;
          else if (typeof val === 'string') {
            const parsed = parseInt(val, 10);
            if (!isNaN(parsed)) speed[key] = parsed;
          }
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
      const crNumeric = parseCR(cr);

      const actions = Array.isArray(m.actions) ? m.actions : [];
      const specialAbilities = Array.isArray(m.special_abilities) ? m.special_abilities : [];
      const legendaryActions = Array.isArray(m.legendary_actions) ? m.legendary_actions : [];
      const description = (m.desc as string) ?? '';
      const senses = (m.senses as string) ?? '';
      const languages = (m.languages as string) ?? '';
      const damageResistances = (m.damage_resistances as string) ?? '';
      const damageImmunities = (m.damage_immunities as string) ?? '';
      const conditionImmunities = (m.condition_immunities as string) ?? '';
      const source = (m.document__title as string) ?? 'SRD';

      insert.run(
        slug, name, size, type, alignment, armorClass, hitPoints, hitDice,
        JSON.stringify(speed), JSON.stringify(abilityScores), cr, crNumeric,
        JSON.stringify(actions), JSON.stringify(specialAbilities), JSON.stringify(legendaryActions),
        description, senses, languages,
        damageResistances, damageImmunities, conditionImmunities,
        source, JSON.stringify(m),
      );
    }
  });

  batch(rawMonsters);
}

// --- Seed spells ---
function seedSpells(rawSpells: unknown[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO compendium_spells
      (slug, name, level, school, casting_time, range, components, duration,
       description, higher_levels, concentration, ritual, classes, source, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = db.transaction((spells: unknown[]) => {
    for (const raw of spells) {
      const s = raw as Record<string, unknown>;
      const slug = (s.slug as string) ?? '';
      const name = (s.name as string) ?? '';

      // level can be a string like "1st-level" or "Cantrip", or a number
      let level = 0;
      if (typeof s.level === 'number') {
        level = s.level;
      } else if (typeof s.level_int === 'number') {
        level = s.level_int;
      } else if (typeof s.level === 'string') {
        level = parseSpellLevel(s.level);
      }

      const school = (s.school as string) ?? '';
      const castingTime = (s.casting_time as string) ?? '';
      const range = (s.range as string) ?? '';
      const components = (s.components as string) ?? '';
      const duration = (s.duration as string) ?? '';
      const description = (s.desc as string) ?? '';
      const higherLevels = (s.higher_level as string) ?? '';

      // concentration: can be "yes"/"no" or boolean
      let concentration = 0;
      if (typeof s.concentration === 'boolean') {
        concentration = s.concentration ? 1 : 0;
      } else if (typeof s.concentration === 'string') {
        concentration = s.concentration.toLowerCase() === 'yes' ? 1 : 0;
      }

      // ritual: same pattern
      let ritual = 0;
      if (typeof s.ritual === 'boolean') {
        ritual = s.ritual ? 1 : 0;
      } else if (typeof s.ritual === 'string') {
        ritual = s.ritual.toLowerCase() === 'yes' ? 1 : 0;
      }

      // dnd_class is a comma-separated string
      let classes: string[] = [];
      if (typeof s.dnd_class === 'string' && s.dnd_class) {
        classes = s.dnd_class.split(',').map((c: string) => c.trim()).filter(Boolean);
      } else if (Array.isArray(s.classes)) {
        classes = s.classes as string[];
      }

      const source = (s.document__title as string) ?? 'SRD';

      insert.run(
        slug, name, level, school, castingTime, range, components, duration,
        description, higherLevels, concentration, ritual,
        JSON.stringify(classes), source, JSON.stringify(s),
      );
    }
  });

  batch(rawSpells);
}

// --- Seed items ---
function seedItems(rawItems: unknown[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO compendium_items
      (slug, name, type, rarity, requires_attunement, description, source, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = db.transaction((items: unknown[]) => {
    for (const raw of items) {
      const i = raw as Record<string, unknown>;
      const slug = (i.slug as string) ?? '';
      const name = (i.name as string) ?? '';
      const type = (i.type as string) ?? '';
      const rarity = (i.rarity as string) ?? '';

      // requires_attunement can be a string like "requires attunement" or boolean
      let requiresAttunement = 0;
      if (typeof i.requires_attunement === 'boolean') {
        requiresAttunement = i.requires_attunement ? 1 : 0;
      } else if (typeof i.requires_attunement === 'string') {
        requiresAttunement = i.requires_attunement.toLowerCase().includes('requires attunement') ? 1 : 0;
      }

      const description = (i.desc as string) ?? '';
      const source = (i.document__title as string) ?? 'SRD';

      insert.run(slug, name, type, rarity, requiresAttunement, description, source, JSON.stringify(i));
    }
  });

  batch(rawItems);
}

// --- Main seed function ---
export async function seedCompendium(): Promise<void> {
  console.log('Fetching monsters from Open5e...');
  const rawMonsters = await fetchAllPages('https://api.open5e.com/v1/monsters/?format=json&limit=50');
  console.log(`Seeding monsters... ${rawMonsters.length} fetched`);
  seedMonsters(rawMonsters);
  console.log(`Monsters seeded: ${rawMonsters.length}`);

  console.log('Fetching spells from Open5e...');
  const rawSpells = await fetchAllPages('https://api.open5e.com/v1/spells/?format=json&limit=50');
  console.log(`Seeding spells... ${rawSpells.length} fetched`);
  seedSpells(rawSpells);
  console.log(`Spells seeded: ${rawSpells.length}`);

  console.log('Fetching magic items from Open5e...');
  const rawItems = await fetchAllPages('https://api.open5e.com/v1/magicitems/?format=json&limit=50');
  console.log(`Seeding items... ${rawItems.length} fetched`);
  seedItems(rawItems);
  console.log(`Items seeded: ${rawItems.length}`);

  const stats = getCompendiumStats();
  console.log(`Compendium seeded: ${stats.monsterCount} monsters, ${stats.spellCount} spells, ${stats.itemCount} items`);
}

// --- Clear and re-seed ---
export async function reseedCompendium(): Promise<void> {
  db.exec('DELETE FROM compendium_monsters');
  db.exec('DELETE FROM compendium_spells');
  db.exec('DELETE FROM compendium_items');
  await seedCompendium();
}
