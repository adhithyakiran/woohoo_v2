import { ident, listColumns, qualify } from './introspect.js';
import { pool, readOnly } from './db.js';

const MAX_PAGE = 500;

/**
 * Reading table data. Every identifier that reaches SQL is checked against the real
 * column list first - the browser can ask for a column, never for a fragment of SQL.
 */
export async function fetchRows(cfg, params) {
  const { schema, table } = params;
  const columns = await listColumns(cfg, schema, table);
  if (!columns.length) throw Object.assign(new Error('No such table'), { status: 404 });

  const known = new Map(columns.map((c) => [c.name, c]));
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), MAX_PAGE);
  const offset = Math.max(Number(params.offset) || 0, 0);

  const where = [];
  const values = [];

  // Free-text search across the columns it makes sense on. Casting every column to
  // text would work but turns a wide table scan into a slow one for no gain.
  const search = (params.search ?? '').trim();
  if (search) {
    const searchable = columns.filter((c) => !/^(json|bytea)/.test(c.base_type));
    if (searchable.length) {
      values.push(`%${search}%`);
      const idx = values.length;
      where.push(
        `(${searchable.map((c) => `${ident(c.name)}::text ILIKE $${idx}`).join(' OR ')})`,
      );
    }
  }

  for (const f of params.filters ?? []) {
    const col = known.get(f.column);
    if (!col) continue;
    const op = FILTER_OPS[f.op];
    if (!op) continue;
    if (op.unary) {
      where.push(`${ident(col.name)} ${op.sql}`);
    } else {
      values.push(op.value ? op.value(f.value) : f.value);
      where.push(`${ident(col.name)}::text ${op.sql} $${values.length}`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let orderSql = '';
  if (params.orderBy && known.has(params.orderBy)) {
    const dir = String(params.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderSql = `ORDER BY ${ident(params.orderBy)} ${dir} NULLS LAST`;
  }

  const relation = qualify(schema, table);
  const sql = `SELECT * FROM ${relation} ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`;

  return readOnly(cfg, async (client) => {
    const result = await client.query(sql, values);

    // An exact count over a million-row table is a scan, so it is opt-in; otherwise
    // the planner's estimate is shown and labelled as such.
    let count = null;
    let counted = 'estimated';
    if (params.exactCount || where.length) {
      const c = await client.query(`SELECT count(*)::bigint AS n FROM ${relation} ${whereSql}`, values);
      count = Number(c.rows[0].n);
      counted = 'exact';
    } else {
      const c = await client.query(
        `SELECT greatest(reltuples, 0)::bigint AS n FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = $1 AND c.relname = $2`,
        [schema, table],
      );
      count = Number(c.rows[0]?.n ?? 0);
    }

    return {
      columns: result.fields.map((f) => {
        const col = known.get(f.name);
        return { name: f.name, type: col?.type ?? null, primaryKey: col?.is_primary_key ?? false };
      }),
      rows: result.rows.map((r) => result.fields.map((f) => serialise(r[f.name]))),
      limit,
      offset,
      count,
      counted,
      sql,
    };
  });
}

const FILTER_OPS = {
  eq: { sql: '=' },
  neq: { sql: '<>' },
  contains: { sql: 'ILIKE', value: (v) => `%${v}%` },
  starts: { sql: 'ILIKE', value: (v) => `${v}%` },
  gt: { sql: '>' },
  lt: { sql: '<' },
  gte: { sql: '>=' },
  lte: { sql: '<=' },
  null: { sql: 'IS NULL', unary: true },
  notnull: { sql: 'IS NOT NULL', unary: true },
};

/** JSON, dates and buffers all have to survive the trip to the browser as strings. */
function serialise(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** Ad-hoc SQL from the console. The transaction is READ ONLY, so the server enforces it. */
export async function runQuery(cfg, sql, limit = 200) {
  const started = Date.now();
  return readOnly(cfg, async (client) => {
    const result = await client.query({ text: sql, rowMode: 'array' });
    const results = Array.isArray(result) ? result : [result];
    const last = results[results.length - 1];
    return {
      ms: Date.now() - started,
      command: last.command,
      rowCount: last.rowCount,
      columns: (last.fields ?? []).map((f) => ({ name: f.name })),
      rows: (last.rows ?? []).slice(0, limit).map((row) => row.map(serialise)),
      truncated: (last.rows ?? []).length > limit,
    };
  });
}

/** Streams a table straight out as CSV without buffering it in the server. */
export async function streamCsv(cfg, schema, table, res, { limit } = {}) {
  const copyStreams = (await import('pg-copy-streams')).default;
  const client = await pool(cfg).connect();
  try {
    const relation = qualify(schema, table);
    const inner = limit ? `SELECT * FROM ${relation} LIMIT ${Number(limit)}` : `SELECT * FROM ${relation}`;
    const stream = client.query(copyStreams.to(`COPY (${inner}) TO STDOUT WITH (FORMAT csv, HEADER)`));
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  } finally {
    client.release();
  }
}
