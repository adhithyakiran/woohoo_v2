import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Node >= 20.12 can read a .env without a dependency. Missing file is not an error:
// every value below has a default, so the app boots with nothing configured.
for (const file of [resolve(ROOT, '.env'), resolve(ROOT, '..', '..', '.env')]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* malformed .env - fall through to defaults */
    }
  }
}

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/**
 * The database being browsed. Read-only as far as this app is concerned, and
 * configured entirely from .env - a production credential does not belong in a file
 * that gets committed.
 */
export const source = {
  host: env.SOURCE_DB_HOST || '',
  port: num(env.SOURCE_DB_PORT, 5432),
  database: env.SOURCE_DB_NAME || 'postgres',
  user: env.SOURCE_DB_USER || '',
  password: env.SOURCE_DB_PASSWORD || '',
  // RDS presents a certificate signed by the Amazon root CA. Without that bundle on
  // disk the only way through is to skip verification, which is what psql's
  // sslmode=require does too.
  ssl: env.SOURCE_DB_SSL === 'off' ? false : { rejectUnauthorized: false },
};

/** Called at startup so a missing .env reads as instructions rather than ECONNREFUSED. */
export function assertConfigured() {
  const missing = ['SOURCE_DB_HOST', 'SOURCE_DB_USER', 'SOURCE_DB_PASSWORD'].filter(
    (k) => !env[k],
  );
  if (!missing.length) return;
  throw new Error(
    `Missing ${missing.join(', ')}.\n` +
      `  Copy tools/db-viewer/.env.example to tools/db-viewer/.env and fill it in.`,
  );
}

/** Where "replicate to local" writes. Defaults to the Docker container this app can start. */
export const target = {
  host: env.TARGET_DB_HOST || 'localhost',
  port: num(env.TARGET_DB_PORT, 5433),
  database: env.TARGET_DB_NAME || 'masterdb',
  user: env.TARGET_DB_USER || 'postgres',
  password: env.TARGET_DB_PASSWORD || 'postgres',
  ssl: false,
};

export const server = {
  port: num(env.PORT, 4180),
  host: env.HOST || '127.0.0.1',
};

export const docker = {
  container: env.LOCAL_PG_CONTAINER || 'woohoo-db-local',
  image: env.LOCAL_PG_IMAGE || 'postgres:16-alpine',
  port: num(env.TARGET_DB_PORT, 5433),
  password: env.TARGET_DB_PASSWORD || 'postgres',
};

/** Statement timeout for anything the UI triggers, so a stray query cannot pin a connection. */
export const queryTimeoutMs = num(env.QUERY_TIMEOUT_MS, 30_000);

/** Never let the browser see a password. */
export const redact = (c) => ({
  host: c.host,
  port: c.port,
  database: c.database,
  user: c.user,
  ssl: Boolean(c.ssl),
});
