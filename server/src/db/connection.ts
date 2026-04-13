import { Pool } from 'pg';

// Cloud Run connects to Cloud SQL via Unix socket:
//   /cloudsql/PROJECT:REGION:INSTANCE
// Local dev uses a standard TCP connection string.
const CLOUD_SQL_SOCKET = process.env.CLOUD_SQL_CONNECTION_NAME
  ? `/cloudsql/${process.env.CLOUD_SQL_CONNECTION_NAME}`
  : undefined;

const pool = CLOUD_SQL_SOCKET
  ? new Pool({
      user: 'postgres',
      password: process.env.PGPASSWORD || 'AtlasBound2026!',
      database: 'atlas_bound',
      host: CLOUD_SQL_SOCKET,
      max: 20,
      idleTimeoutMillis: 30000,
    })
  : new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://postgres:AtlasBound2026!@localhost:5432/atlas_bound',
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
