import { traitsForRace } from '@dnd-vtt/shared';
import pool from './connection.js';
import {
  readWildShapeColumn,
  druidLevel,
  isMoonDruid,
  wildShapeCrCap,
} from '../utils/wildShapeState.js';
import { parseCharacterFeatureState, type CharacterFeatureState } from '../utils/featureRuntime.js';

const migration = 'canonical-character-features-v1';
type Feature = Record<string, unknown> & { name: string };
interface Provenance {
  experience: boolean;
  wildShape: boolean;
  complete: boolean;
  fence: boolean;
}

/** Must surround schema DDL in the same transaction. A default zero/NULL added
 * by that DDL is NOT evidence that an old character had canonical state. */
export async function prepareLegacyFeatureUpgrade(): Promise<Provenance> {
  await pool.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':canonical-character-features-v1', 0))"
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS character_feature_upgrades (
    name TEXT PRIMARY KEY, legacy_write_fence BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows } = await pool.query(
    `SELECT
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('characters') AND attname = 'experience' AND NOT attisdropped) AS experience,
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('characters') AND attname = 'wild_shape' AND NOT attisdropped) AS "wildShape",
    EXISTS (SELECT 1 FROM character_feature_upgrades WHERE name = $1) AS complete`,
    [migration]
  );
  const provenance = { ...rows[0], fence: false } as Provenance;
  if (!provenance.complete) {
    const { rows: tables } = await pool.query(
      "SELECT to_regclass('character_feature_runtime') AS legacy"
    );
    if (tables[0].legacy) {
      // Even an empty table proves an older, legacy-capable application may
      // write its FIRST resource after this candidate starts.
      provenance.fence = true;
      if (process.env.ATLAS_LEGACY_FEATURE_CUTOVER !== 'quiesced-v1')
        throw new Error(
          'Legacy feature cutover required before main startup. Drain ALL old revisions, sockets and writers, preflight the migration, then explicitly set ATLAS_LEGACY_FEATURE_CUTOVER=quiesced-v1. A no-traffic candidate must not adopt live legacy state.'
        );
    }
  }
  return provenance;
}

function fail(id: unknown, reason: string): never {
  throw new Error(
    `Legacy feature upgrade blocked for character ${String(id)}: ${reason}. Reconcile before main cutover; no data was committed.`
  );
}

function classLevel(row: Record<string, unknown>, name: string): number {
  const value = String(row.class ?? '');
  const explicit = value.match(new RegExp(`(?:^|/)\\s*${name}(?:\\s*\\([^)]*\\))?\\s+(\\d+)`, 'i'));
  if (explicit) return Number(explicit[1]);
  return new RegExp(`^\\s*${name}(?:\\s*\\([^)]*\\))?\\s*$`, 'i').test(value)
    ? Number(row.level)
    : 0;
}

function adoptPool(
  features: Feature[],
  matches: (feature: Feature) => boolean,
  value: Feature,
  row: Record<string, unknown>,
  maximum: number
): void {
  const index = features.findIndex(matches);
  // Presence, not truthiness: even zero, NULL, or malformed canonical data must
  // not be replaced with stale legacy state. Its canonical reader owns repair.
  if (index >= 0 && Object.hasOwn(features[index], 'usesRemaining')) return;
  const remaining = Number(value.usesRemaining);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || remaining > maximum)
    fail(row.id, `${value.name} is incompatible with the current sheet`);
  if (index < 0) features.push(value);
  else features[index] = { ...features[index], ...value };
}

async function convertWildShape(
  row: Record<string, unknown>,
  features: Feature[],
  legacy: NonNullable<CharacterFeatureState['wildShape']>
): Promise<string | null> {
  if (legacy.beastHp === 0) return null;
  const { rows } = await pool.query(
    `SELECT slug, name, type, hit_points, armor_class, speed, cr_numeric
    FROM compendium_monsters WHERE LOWER(name) = LOWER($1) OR slug = $2 ORDER BY slug`,
    [legacy.beastName, legacy.beastName.toLowerCase().replace(/\s+/g, '-')]
  );
  if (rows.length !== 1) fail(row.id, 'active Wild Shape does not identify one trusted Beast');
  const beast = rows[0];
  let speed: Record<string, number>;
  try {
    speed = typeof beast.speed === 'string' ? JSON.parse(beast.speed) : beast.speed;
  } catch {
    fail(row.id, 'trusted Beast speed is invalid');
  }
  const level = druidLevel(String(row.class), Number(row.level));
  const moon = isMoonDruid(String(row.class), features);
  if (
    String(beast.type).toLowerCase() !== 'beast' ||
    legacy.beastMax !== Number(beast.hit_points) ||
    (legacy.beastAc !== null && legacy.beastAc !== Number(beast.armor_class)) ||
    (legacy.beastSpeed !== null && legacy.beastSpeed !== speed?.walk) ||
    level === null ||
    level < 2
  )
    fail(row.id, 'active Wild Shape stats do not match the trusted Beast/sheet');
  if (
    Number(beast.cr_numeric) > wildShapeCrCap(level, moon) ||
    ((speed?.fly ?? 0) > 0 && level < 8) ||
    ((speed?.swim ?? 0) > 0 && level < 4)
  )
    fail(row.id, 'active Wild Shape violates canonical CR or movement eligibility');
  const value = JSON.stringify({
    formSlug: beast.slug,
    formName: beast.name,
    formHp: legacy.beastHp,
    formMaxHp: legacy.beastMax,
    formAc: beast.armor_class,
    formSpeed: speed,
    formCr: Number(beast.cr_numeric),
    moon,
  });
  if (readWildShapeColumn(value).status !== 'active')
    fail(row.id, 'active Wild Shape cannot be represented safely');
  return value;
}

export async function completeLegacyFeatureUpgrade(provenance: Provenance): Promise<void> {
  if (provenance.complete) return;
  const { rows: tables } = await pool.query(
    "SELECT to_regclass('character_feature_runtime') AS legacy"
  );
  if (tables[0].legacy) {
    // Startup has not exposed handlers yet. The character table DDL lock plus
    // this legacy lock makes the handoff atomic against old in-flight writers.
    await pool.query('LOCK TABLE character_feature_runtime IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await pool.query(`SELECT c.*, r.state AS legacy_state FROM characters c
      LEFT JOIN character_feature_runtime r ON r.character_id = c.id ORDER BY c.id FOR UPDATE OF c`);
    for (const row of rows) {
      let legacy: CharacterFeatureState;
      try {
        legacy = parseCharacterFeatureState(row.legacy_state ?? { version: 1, namespaces: {} });
      } catch {
        fail(row.id, 'legacy state is malformed');
      }
      let features: Feature[];
      try {
        features = JSON.parse(String(row.features));
      } catch {
        fail(row.id, 'features are malformed');
      }
      if (!Array.isArray(features) || features.some((f) => !f || typeof f.name !== 'string'))
        fail(row.id, 'features are malformed');
      const original = JSON.stringify(features);
      let xp = row.experience;
      if (!provenance.experience && legacy.xp !== undefined) {
        if (legacy.xp > 2_000_000_000) fail(row.id, 'XP exceeds the canonical supported total');
        xp = legacy.xp;
      }
      let wildShape = row.wild_shape;
      if (!provenance.wildShape && legacy.wildShape !== undefined) {
        wildShape = await convertWildShape(row, features, legacy.wildShape);
      }
      if (!provenance.wildShape && (druidLevel(String(row.class), Number(row.level)) ?? 0) >= 2) {
        // The old implementation recorded no charge history. Never invent fresh
        // uses even after revert/depletion removed the active-form namespace.
        // A normal rest is the explicit recovery boundary.
        adoptPool(
          features,
          (f) => /^wild\s*shape$/i.test(f.name.trim()),
          {
            name: 'Wild Shape',
            source: 'Druid',
            sourceType: 'class',
            usesTotal: 2,
            usesRemaining: 0,
            resetOn: 'short',
          },
          row,
          2
        );
      }
      if (legacy.luckPoints !== undefined) {
        const isLucky = (f: Feature) => f.sourceType === 'feat' && /^lucky$/i.test(f.name.trim());
        if (!features.some(isLucky))
          fail(row.id, 'legacy Lucky points have no canonical Lucky feat');
        adoptPool(
          features,
          isLucky,
          {
            name: 'Lucky',
            sourceType: 'feat',
            usesTotal: 3,
            usesRemaining: legacy.luckPoints,
            resetOn: 'long',
          },
          row,
          3
        );
      }
      for (const [key, value] of Object.entries(legacy.pointPools ?? {})) {
        if (key === 'ki' || key === 'sp') {
          const ki = key === 'ki';
          const level = classLevel(row, ki ? 'monk' : 'sorcerer');
          const matches = (f: Feature) =>
            (ki ? /^ki(?:\s+points?)?$/i : /^(?:font\s+of\s+magic|sorcery\s+points?)$/i).test(
              f.name.trim()
            );
          adoptPool(
            features,
            matches,
            {
              name: ki ? 'Ki Points' : 'Font of Magic',
              sourceType: 'class',
              usesTotal: level,
              usesRemaining: value.remaining,
              resetOn: ki ? 'short' : 'long',
            },
            row,
            level >= 2 ? level : 0
          );
        } else if (key.startsWith('racial:')) {
          const name = `Racial Spell: ${key.slice(7)}`;
          const matches = (f: Feature) => f.name.trim().toLowerCase() === name.toLowerCase();
          if (features.some((f) => matches(f) && Object.hasOwn(f, 'usesRemaining'))) continue;
          const spell = traitsForRace(String(row.race))?.innateSpells?.find(
            (s) =>
              `racial:${s.name.toLowerCase()}` === key &&
              s.uses !== 'at-will' &&
              (s.availableFromCharLevel ?? 1) <= Number(row.level)
          );
          if (!spell) fail(row.id, `legacy ${key} is not a current racial spell`);
          adoptPool(
            features,
            matches,
            {
              name: `Racial Spell: ${spell.name}`,
              sourceType: 'race',
              source: String(row.race),
              usesTotal: 1,
              usesRemaining: value.remaining,
              resetOn: spell.uses === 'per-short' ? 'short' : 'long',
            },
            row,
            1
          );
        }
      }
      if (
        xp !== row.experience ||
        wildShape !== row.wild_shape ||
        JSON.stringify(features) !== original
      )
        await pool.query(
          'UPDATE characters SET experience = $2, wild_shape = $3, features = $4 WHERE id = $1',
          [row.id, xp, wildShape, JSON.stringify(features)]
        );
    }
  }
  // Keep the original legacy JSON intact for audit/rollback reconciliation, but
  // never read it again after this marker, even if canonical state is cleared.
  await pool.query(
    'INSERT INTO character_feature_upgrades (name, legacy_write_fence) VALUES ($1,$2)',
    [migration, provenance.fence]
  );
  if (provenance.fence) await installLegacyWriteFence();
}

/** Old revisions may still connect after cutover. They must fail, not report
 * successful writes to resources that canonical main will no longer consume. */
async function installLegacyWriteFence(): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION retired_feature_values(value JSONB) RETURNS JSONB
    LANGUAGE SQL IMMUTABLE AS $$
      SELECT jsonb_build_array(value #> '{namespaces,xp}', value #> '{namespaces,wildShape}',
        value #> '{namespaces,luckPoints}', COALESCE((SELECT jsonb_object_agg(key, v)
          FROM jsonb_each(COALESCE(value #> '{namespaces,pointPools}', '{}'::jsonb)) p(key,v)
          WHERE key IN ('ki','sp') OR key LIKE 'racial:%'), '{}'::jsonb))
    $$;
    CREATE OR REPLACE FUNCTION reject_retired_feature_writes() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF retired_feature_values(NEW.state) IS DISTINCT FROM retired_feature_values(
        CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE OLD.state END) THEN
        RAISE EXCEPTION 'Legacy resource writer fenced after canonical cutover; reconnect to main';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER canonical_feature_write_fence BEFORE INSERT OR UPDATE ON character_feature_runtime
      FOR EACH ROW EXECUTE FUNCTION reject_retired_feature_writes();
  `);
}
