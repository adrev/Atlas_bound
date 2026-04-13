import { Pool } from 'pg';

// Cloud Run connects to Cloud SQL via Unix socket:
//   /cloudsql/PROJECT:REGION:INSTANCE
// Local dev uses a standard TCP connection string.
const CLOUD_SQL_SOCKET = process.env.CLOUD_SQL_CONNECTION_NAME
  ? `/cloudsql/${process.env.CLOUD_SQL_CONNECTION_NAME}`
  : undefined;

if (CLOUD_SQL_SOCKET && !process.env.PGPASSWORD) {
  throw new Error('[DB] PGPASSWORD env var is required when connecting via Cloud SQL socket');
}
if (!CLOUD_SQL_SOCKET && !process.env.DATABASE_URL) {
  throw new Error('[DB] DATABASE_URL env var is required for local/dev database connections');
}

const pool = CLOUD_SQL_SOCKET
  ? new Pool({
      user: 'postgres',
      password: process.env.PGPASSWORD,
      database: 'atlas_bound',
      host: CLOUD_SQL_SOCKET,
      max: 20,
      idleTimeoutMillis: 30000,
    })
  : new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
    });

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err);
});

const connInfo = CLOUD_SQL_SOCKET
  ? `Cloud SQL socket → ${CLOUD_SQL_SOCKET}`
  : `${pool.options.host ?? 'localhost'}:${pool.options.port ?? 5432}`;
console.log(`[DB] PostgreSQL pool created → ${connInfo}`);

export default pool;
