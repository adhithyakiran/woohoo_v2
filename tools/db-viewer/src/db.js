import pg from 'pg';
import { queryTimeoutMs, source } from './config.js';

// Postgres hands back int8/numeric as strings to avoid precision loss. Counts and ids
// are the only place that matters here, and JSON.stringify of a BigInt throws, so
// int8 is parsed to Number (safe below 2^53) and numeric is left as a string.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pools = new Map();

function key(cfg) {
  return `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}${cfg.ssl ? '+ssl' : ''}`;
}

export function pool(cfg) {
  const k = key(cfg);
  let p = pools.get(k);
  if (!p) {
    p = new pg.Pool({
      ...cfg,
      max: 6,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      application_name: 'woohoo-db-viewer',
      statement_timeout: queryTimeoutMs,
    });
    // A pool with no error handler crashes the process when a backend drops.
    p.on('error', (err) => console.error(`[pool ${k}] ${err.message}`));
    pools.set(k, p);
  }
  return p;
}

export const sourcePool = () => pool(source);

export async function query(cfg, text, params = []) {
  return pool(cfg).query(text, params);
}

export async function rows(cfg, text, params = []) {
  return (await query(cfg, text, params)).rows;
}

/** Runs `fn` inside a transaction the server refuses to let write. */
export async function readOnly(cfg, fn) {
  const client = await pool(cfg).connect();
  try {
    await client.query('BEGIN READ ONLY');
    return await fn(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already gone */
    }
    client.release();
  }
}

/** A dedicated connection outside the pool - for COPY streams, which own their socket. */
export async function rawClient(cfg, overrides = {}) {
  const client = new pg.Client({
    ...cfg,
    ...overrides,
    application_name: 'woohoo-db-viewer/replicate',
    connectionTimeoutMillis: 20_000,
    // Bulk COPY of a large table legitimately runs longer than a UI query.
    statement_timeout: 0,
    query_timeout: 0,
  });
  await client.connect();
  return client;
}

export async function closeAll() {
  await Promise.allSettled([...pools.values()].map((p) => p.end()));
  pools.clear();
}
