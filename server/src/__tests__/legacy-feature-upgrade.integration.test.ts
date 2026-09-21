import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { checkedDatabaseUrl, fixtureDatabaseUrl } from './fixtures/runtime-process.js';

const database = process.env.ATLAS_RUNTIME_TEST_DATABASE_URL;
if (database) checkedDatabaseUrl(database);
const exec = promisify(execFile);
const owned: { schema: string; pool: Pool }[] = [];
const admin = database ? new Pool({ connectionString: database }) : undefined;
const legacy = {
  version: 1,
  namespaces: {
    xp: 7123,
    luckPoints: 0,
    wildShape: { beastName: 'Wolf', beastHp: 3, beastMax: 11, beastAc: 13, beastSpeed: 40 },
    pointPools: {
      ki: { max: 5, remaining: 0 },
      sp: { max: 5, remaining: 1 },
      'racial:hellish rebuke': { max: 1, remaining: 0 },
      superiority: { max: 5, remaining: 2, die: 10 },
    },
  },
};

function run(
  schema: string,
  gate = false,
  mode: 'startup' | 'preflight' = 'startup',
  commands: string[] = []
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: fixtureDatabaseUrl(database!, schema, `upgrade-${randomUUID()}`),
    ATLAS_RUNTIME_TEST_SCHEMA: schema,
    ATLAS_RUNTIME_TEST_COMMANDS: JSON.stringify(commands),
  };
  delete env.CLOUD_SQL_CONNECTION_NAME;
  delete env.PGOPTIONS;
  delete env.ATLAS_LEGACY_FEATURE_CUTOVER;
  if (gate) env.ATLAS_LEGACY_FEATURE_CUTOVER = 'quiesced-v1';
  const path =
    mode === 'startup' ? './fixtures/upgrade-process.ts' : '../scripts/legacyFeatureCutover.ts';
  return exec(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL(path, import.meta.url)),
      ...(mode === 'preflight' ? ['--preflight'] : []),
    ],
    { env, timeout: 30_000 }
  );
}

async function fixture(canonical = false) {
  const schema = `atlas_runtime_it_${randomUUID().replaceAll('-', '')}`;
  await admin!.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: fixtureDatabaseUrl(database!, schema, 'upgrade-parent'),
  });
  owned.push({ schema, pool });
  await run(schema);
  await pool.query('DROP TABLE character_feature_upgrades');
  if (!canonical)
    await pool.query('ALTER TABLE characters DROP COLUMN experience, DROP COLUMN wild_shape');
  await pool.query("INSERT INTO users (id,display_name) VALUES ('u','Upgrade')");
  await pool.query(
    `INSERT INTO characters (id,user_id,name,class,level,race,features)
    VALUES ('c','u','Upgrade','Monk 5 / Sorcerer 5 / Druid 5',15,'Tiefling',$1)`,
    [JSON.stringify([{ name: 'Lucky', sourceType: 'feat' }])]
  );
  await pool.query(
    "INSERT INTO character_feature_runtime (character_id,state) VALUES ('c',$1::jsonb)",
    [JSON.stringify(legacy)]
  );
  await pool.query(`INSERT INTO compendium_monsters (slug,name,type,hit_points,armor_class,speed,cr_numeric)
    VALUES ('wolf','Wolf','beast',11,13,'{"walk":40}',0.25)`);
  await pool.query(`INSERT INTO sessions (id,name,room_code,dm_user_id,current_map_id,player_map_id)
    VALUES ('s','Upgrade','UPGRADE','u','m','m')`);
  await pool.query("INSERT INTO maps (id,session_id,name) VALUES ('m','s','Upgrade')");
  await pool.query(
    "INSERT INTO session_players (session_id,user_id,role,character_id) VALUES ('s','u','dm','c')"
  );
  await pool.query(
    "INSERT INTO tokens (id,map_id,character_id,owner_user_id,name,x,y) VALUES ('t','m','c','u','Upgrade',0,0)"
  );
  return { schema, pool };
}

describe.skipIf(!database)('REAL PostgreSQL production-to-main feature upgrade', () => {
  afterAll(async () => {
    for (const { schema, pool } of owned) {
      await pool.end();
      await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await admin?.end();
  }, 30_000);

  it('blocks normal no-traffic startup before adding defaults, and preflight always rolls back', async () => {
    const { schema, pool } = await fixture();
    await expect(run(schema)).rejects.toThrow('Legacy feature cutover required');
    const columns = async () =>
      (
        await pool.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='characters'::regclass AND attname IN ('experience','wild_shape') AND NOT attisdropped`)
      ).rows;
    expect(await columns()).toEqual([]);
    expect(
      (await pool.query("SELECT to_regclass('character_feature_upgrades') AS marker")).rows[0]
        .marker
    ).toBeNull();
    expect((await run(schema, false, 'preflight')).stdout).toContain(
      'all schema/data changes rolled back'
    );
    expect(await columns()).toEqual([]);
    expect((await pool.query('SELECT state FROM character_feature_runtime')).rows[0].state).toEqual(
      legacy
    );
  }, 30_000);

  it('adopts spent values once across concurrent cold startups, preserves dice, and fences late legacy writers', async () => {
    const { schema, pool } = await fixture();
    const a = run(schema, true);
    const b = run(schema, true);
    await a;
    await b;
    const row = (await pool.query("SELECT * FROM characters WHERE id='c'")).rows[0];
    expect(row.experience).toBe(7123);
    expect(JSON.parse(row.wild_shape)).toMatchObject({
      formSlug: 'wolf',
      formHp: 3,
      formMaxHp: 11,
      formAc: 13,
      formSpeed: { walk: 40 },
    });
    const features = JSON.parse(row.features) as Record<string, unknown>[];
    expect(Object.fromEntries(features.map((f) => [f.name, f.usesRemaining]))).toEqual({
      Lucky: 0,
      'Wild Shape': 0,
      'Ki Points': 0,
      'Font of Magic': 1,
      'Racial Spell: Hellish Rebuke': 0,
    });
    expect((await pool.query('SELECT state FROM character_feature_runtime')).rows[0].state).toEqual(
      legacy
    );
    await expect(
      pool.query(
        `UPDATE character_feature_runtime SET state = jsonb_set(state,'{namespaces,xp}','7124')`
      )
    ).rejects.toThrow('writer fenced');
    await expect(
      pool.query(
        `UPDATE character_feature_runtime SET state = jsonb_set(state,'{namespaces,pointPools,ki,remaining}','5')`
      )
    ).rejects.toThrow('writer fenced');
    await pool.query(
      `UPDATE character_feature_runtime SET state = jsonb_set(state,'{namespaces,pointPools,superiority,remaining}','1')`
    );
    await pool.query(
      "UPDATE characters SET experience=0, wild_shape=NULL, features='[]' WHERE id='c'"
    );
    await run(schema);
    const cleared = (
      await pool.query("SELECT experience,wild_shape,features FROM characters WHERE id='c'")
    ).rows[0];
    expect(cleared).toEqual({ experience: 0, wild_shape: null, features: '[]' });
  }, 30_000);

  it('requires cutover for an empty legacy table and fences its late first writer', async () => {
    const { schema, pool } = await fixture();
    await pool.query('DELETE FROM character_feature_runtime');
    await pool.query('DELETE FROM characters');
    await expect(run(schema)).rejects.toThrow('Legacy feature cutover required');
    await run(schema, true);
    await pool.query("INSERT INTO characters (id,user_id,name) VALUES ('late','u','Late writer')");
    await expect(
      pool.query(`INSERT INTO character_feature_runtime (character_id,state)
      VALUES ('late','{"version":1,"namespaces":{"xp":1}}')`)
    ).rejects.toThrow('writer fenced');
    await pool.query("INSERT INTO character_feature_runtime (character_id) VALUES ('late')");
    await expect(
      pool.query(`UPDATE character_feature_runtime SET state=
      '{"version":1,"namespaces":{"pointPools":{"ki":{"max":5,"remaining":4}}}}'`)
    ).rejects.toThrow('writer fenced');
  }, 30_000);

  it.each([{}, { pointPools: { superiority: { max: 5, remaining: 2, die: 10 } } }])(
    'fences first retired-key writes after retained-only state: %j',
    async (namespaces) => {
      const { schema, pool } = await fixture();
      await pool.query('UPDATE character_feature_runtime SET state=$1::jsonb', [
        JSON.stringify({ version: 1, namespaces }),
      ]);
      await expect(run(schema)).rejects.toThrow('Legacy feature cutover required');
      await run(schema, true);
      await run(schema);
      await expect(
        pool.query(
          `UPDATE character_feature_runtime SET state=jsonb_set(state,'{namespaces,xp}','1')`
        )
      ).rejects.toThrow('writer fenced');
    },
    30_000
  );

  it.each([
    { moon: true, cr: 1, speed: { walk: 40 }, passes: true },
    { moon: false, cr: 1, speed: { walk: 40 }, passes: false },
    { moon: true, cr: 8, speed: { walk: 40 }, passes: false },
    { moon: true, cr: 0.25, speed: { walk: 40, fly: 30 }, passes: false },
    { moon: true, cr: 0.25, speed: { walk: 40, swim: 30 }, passes: false },
  ])(
    'uses canonical Moon/CR/movement eligibility for legacy forms: %j',
    async ({ moon, cr, speed, passes }) => {
      const { schema, pool } = await fixture();
      await pool.query('UPDATE characters SET class=$1, features=$2', [
        `Monk 5 / Sorcerer 5 / Druid${moon ? ' (Circle of the Moon)' : ''} 2`,
        JSON.stringify([{ name: 'Lucky', sourceType: 'feat' }]),
      ]);
      await pool.query('UPDATE compendium_monsters SET cr_numeric=$1, speed=$2', [
        cr,
        JSON.stringify(speed),
      ]);
      if (passes) {
        await run(schema, true);
        expect(
          JSON.parse((await pool.query('SELECT wild_shape FROM characters')).rows[0].wild_shape)
        ).toMatchObject({ moon: true, formHp: 3, formCr: 1 });
      } else
        await expect(run(schema, true)).rejects.toThrow('canonical CR or movement eligibility');
    },
    30_000
  );

  it('preserves pre-existing canonical zero, inactive forms, exhausted charges, and unrelated feature fields', async () => {
    const { schema, pool } = await fixture(true);
    const features = [
      { name: 'Lucky', sourceType: 'feat', usesRemaining: 0, custom: 'keep' },
      { name: 'Ki Points', usesRemaining: 0 },
      { name: 'Font of Magic', usesRemaining: 0 },
      { name: 'Racial Spell: Hellish Rebuke', usesRemaining: 0 },
    ];
    await pool.query('UPDATE characters SET features=$1', [JSON.stringify(features)]);
    await run(schema, true);
    const row = (await pool.query('SELECT experience,wild_shape,features FROM characters')).rows[0];
    expect(row).toEqual({ experience: 0, wild_shape: null, features: JSON.stringify(features) });
  }, 30_000);

  it.each(['reverted', 'no-runtime-row'])(
    'does not refill unknown Wild Shape charges for %s legacy druids; actual rest unlocks the command',
    async (state) => {
      const { schema, pool } = await fixture();
      if (state === 'reverted')
        await pool.query(
          `UPDATE character_feature_runtime SET state='{"version":1,"namespaces":{}}'`
        );
      else await pool.query('DELETE FROM character_feature_runtime');
      await run(schema, true);
      const sheet = async () =>
        (await pool.query("SELECT wild_shape,features FROM characters WHERE id='c'")).rows[0];
      const migrated = await sheet();
      expect(
        JSON.parse(migrated.features).find((f: { name: string }) => f.name === 'Wild Shape')
          .usesRemaining
      ).toBe(0);
      expect((await run(schema, false, 'startup', ['!wildshape Wolf'])).stdout).toContain(
        'no uses remaining'
      );
      expect(await sheet()).toEqual(migrated);
      await run(schema, false, 'startup', ['!rest short', '!wildshape Wolf']);
      const rested = await sheet();
      expect(JSON.parse(rested.wild_shape)).toMatchObject({ formSlug: 'wolf', formHp: 11 });
      expect(
        JSON.parse(rested.features).find((f: { name: string }) => f.name === 'Wild Shape')
          .usesRemaining
      ).toBe(1);
    },
    30_000
  );

  it.each([0, 1])(
    'retains an explicit canonical Wild Shape remaining=%s even when its column is new',
    async (remaining) => {
      const { schema, pool } = await fixture();
      await pool.query(
        `UPDATE character_feature_runtime SET state='{"version":1,"namespaces":{}}'`
      );
      const value = JSON.stringify([
        {
          name: 'Wild Shape',
          sourceType: 'class',
          usesRemaining: remaining,
          usesTotal: 2,
          resetOn: 'short',
        },
      ]);
      await pool.query('UPDATE characters SET features=$1', [value]);
      await run(schema, true);
      expect((await pool.query('SELECT features FROM characters')).rows[0].features).toBe(value);
    },
    30_000
  );

  it.each(['untrusted form', 'overflow XP', 'malformed state'])(
    'rolls back the entire upgrade for %s',
    async (kind) => {
      const { schema, pool } = await fixture();
      const value = structuredClone(legacy);
      if (kind === 'untrusted form') value.namespaces.wildShape.beastMax = 999;
      if (kind === 'overflow XP') value.namespaces.xp = 2_000_000_001;
      if (kind === 'malformed state') value.namespaces.pointPools.superiority.die = 9;
      await pool.query('UPDATE character_feature_runtime SET state=$1::jsonb', [
        JSON.stringify(value),
      ]);
      await expect(run(schema, true)).rejects.toThrow('Legacy feature upgrade blocked');
      expect(
        (await pool.query('SELECT state FROM character_feature_runtime')).rows[0].state
      ).toEqual(value);
      expect(
        (await pool.query("SELECT to_regclass('character_feature_upgrades') AS marker")).rows[0]
          .marker
      ).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT attname FROM pg_attribute WHERE attrelid='characters'::regclass AND attname='experience' AND NOT attisdropped"
          )
        ).rows
      ).toEqual([]);
    },
    30_000
  );
});
