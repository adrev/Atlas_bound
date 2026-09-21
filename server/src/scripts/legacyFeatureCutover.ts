import pool, { rawPool, transportPool } from '../db/connection.js';
import { inTransaction } from '../db/transactionContext.js';
import { initDatabase } from '../db/schema.js';
import { initRuntimeSchema } from '../db/runtimeSchema.js';

const mode = process.argv[2];
const rollback = new Error('Preflight rollback');
try {
  if (mode !== '--preflight' && mode !== '--apply')
    throw new Error(
      'Use --preflight (always rolls back) or --apply (requires ATLAS_LEGACY_FEATURE_CUTOVER=quiesced-v1).'
    );
  if (mode === '--apply' && process.env.ATLAS_LEGACY_FEATURE_CUTOVER !== 'quiesced-v1')
    throw new Error(
      'Stop all legacy revisions/sockets/writers before explicitly enabling quiesced-v1.'
    );
  if (mode === '--preflight') process.env.ATLAS_LEGACY_FEATURE_CUTOVER = 'quiesced-v1';
  try {
    await inTransaction(rawPool, async () => {
      await initDatabase();
      await initRuntimeSchema();
      const { rows } = await pool.query(
        'SELECT name, legacy_write_fence FROM character_feature_upgrades'
      );
      console.log(JSON.stringify({ mode, migrations: rows }));
      if (mode === '--preflight') throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
    console.log(
      'Preflight passed; all schema/data changes rolled back. This does not certify that legacy writers are drained.'
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rawPool.end();
  await transportPool.end();
}
