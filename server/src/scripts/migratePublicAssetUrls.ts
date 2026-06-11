import type { Pool } from 'pg';
import {
  CURRENT_PUBLIC_ASSET_PREFIX,
  LEGACY_PUBLIC_ASSET_PREFIX,
  PUBLIC_ASSET_URL_MIGRATION_TARGETS,
  quoteSqlIdentifier,
  type PublicAssetUrlMigrationTarget,
} from '../utils/publicAssetUrlMigration.js';

interface CliOptions {
  apply: boolean;
  json: boolean;
}

interface MigrationResult {
  table: string;
  column: string;
  description: string;
  matches: number;
  updated: number;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false };

  for (const arg of args) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run public-assets:audit-urls --workspace=server -- [--json]
       npm run public-assets:migrate-urls --workspace=server

Audits or migrates persisted public asset URLs from:
  ${LEGACY_PUBLIC_ASSET_PREFIX}
to:
  ${CURRENT_PUBLIC_ASSET_PREFIX}

The default mode is dry-run. Use --apply to write changes.`);
}

function targetSql(target: PublicAssetUrlMigrationTarget): { table: string; column: string } {
  return {
    table: quoteSqlIdentifier(target.table),
    column: quoteSqlIdentifier(target.column),
  };
}

async function countMatches(pool: Pool, target: PublicAssetUrlMigrationTarget): Promise<number> {
  const { table, column } = targetSql(target);
  const result = await pool.query<{ matches: number }>(
    `SELECT COUNT(*)::int AS matches
       FROM ${table}
      WHERE ${column} IS NOT NULL
        AND POSITION($1 IN ${column}) > 0`,
    [LEGACY_PUBLIC_ASSET_PREFIX]
  );

  return Number(result.rows[0]?.matches ?? 0);
}

async function migrateTarget(pool: Pool, target: PublicAssetUrlMigrationTarget): Promise<number> {
  const { table, column } = targetSql(target);
  const result = await pool.query(
    `UPDATE ${table}
        SET ${column} = REPLACE(${column}, $1, $2)
      WHERE ${column} IS NOT NULL
        AND POSITION($1 IN ${column}) > 0`,
    [LEGACY_PUBLIC_ASSET_PREFIX, CURRENT_PUBLIC_ASSET_PREFIX]
  );

  return result.rowCount ?? 0;
}

function printTextReport(results: MigrationResult[], apply: boolean): void {
  const totalMatches = results.reduce((sum, result) => sum + result.matches, 0);
  const totalUpdated = results.reduce((sum, result) => sum + result.updated, 0);

  console.log(`Public asset URL migration (${apply ? 'apply' : 'dry-run'})`);
  console.log(`Legacy prefix: ${LEGACY_PUBLIC_ASSET_PREFIX}`);
  console.log(`Current prefix: ${CURRENT_PUBLIC_ASSET_PREFIX}`);
  console.log('');

  for (const result of results) {
    if (result.matches === 0) continue;
    console.log(
      `${result.table}.${result.column}: ${result.matches} matching rows` +
        (apply ? `, ${result.updated} updated` : '') +
        ` (${result.description})`
    );
  }

  if (totalMatches === 0) {
    console.log('No legacy public asset URLs found in the configured targets.');
  }

  console.log('');
  console.log(`Totals: ${totalMatches} matching rows${apply ? `, ${totalUpdated} updated` : ''}.`);
  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write changes.');
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results: MigrationResult[] = [];
  const { default: pool } = await import('../db/connection.js');

  try {
    if (options.apply) {
      await pool.query('BEGIN');
    }

    try {
      for (const target of PUBLIC_ASSET_URL_MIGRATION_TARGETS) {
        const matches = await countMatches(pool, target);
        const updated = options.apply && matches > 0 ? await migrateTarget(pool, target) : 0;
        results.push({ ...target, matches, updated });
      }

      if (options.apply) {
        await pool.query('COMMIT');
      }
    } catch (error) {
      if (options.apply) {
        await pool.query('ROLLBACK');
      }
      throw error;
    }

    if (options.json) {
      console.log(JSON.stringify({ apply: options.apply, results }, null, 2));
    } else {
      printTextReport(results, options.apply);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
