import { ident, literal, qualify } from './introspect.js';

/**
 * Turns a schema snapshot into the statements that rebuild it elsewhere.
 *
 * The order matters and is the reason this is split into phases rather than one list:
 * enums and sequences must exist before the tables that reference them, data loads
 * fastest into a table with no indexes, and foreign keys can only be trusted once
 * every table holds its rows.
 */

export function createSchema(schema) {
  return `CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`;
}

export function dropSchema(schema) {
  return `DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`;
}

export function createEnum(schema, e) {
  const labels = e.labels.map(literal).join(', ');
  return `CREATE TYPE ${qualify(schema, e.name)} AS ENUM (${labels})`;
}

export function createSequence(schema, s) {
  const parts = [`CREATE SEQUENCE IF NOT EXISTS ${qualify(schema, s.name)}`];
  if (s.data_type) parts.push(`AS ${s.data_type}`);
  parts.push(`INCREMENT BY ${s.increment}`);
  parts.push(`MINVALUE ${s.min_value}`);
  parts.push(`MAXVALUE ${s.max_value}`);
  parts.push(`START WITH ${s.start}`);
  parts.push(`CACHE ${s.cache}`);
  parts.push(s.cycle ? 'CYCLE' : 'NO CYCLE');
  return parts.join(' ');
}

export function ownSequence(schema, s) {
  if (!s.owned_by_table || !s.owned_by_column) return null;
  return `ALTER SEQUENCE ${qualify(schema, s.name)} OWNED BY ${qualify(
    schema,
    s.owned_by_table,
  )}.${ident(s.owned_by_column)}`;
}

function columnClause(col) {
  const parts = [ident(col.name), col.type];

  if (col.generated === 's') {
    // A stored generated column carries its expression instead of a default.
    parts.push(`GENERATED ALWAYS AS (${col.default_expr}) STORED`);
  } else if (col.identity === 'a' || col.identity === 'd') {
    parts.push(`GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
  } else if (col.default_expr) {
    parts.push(`DEFAULT ${col.default_expr}`);
  }

  if (col.not_null) parts.push('NOT NULL');
  return parts.join(' ');
}

/** Columns only. Keys and checks are added after the data lands. */
export function createTable(schema, table) {
  const cols = table.columns.map((c) => `  ${columnClause(c)}`).join(',\n');
  return `CREATE TABLE ${qualify(schema, table.name)} (\n${cols}\n)`;
}

export function comments(schema, table) {
  const out = [];
  if (table.comment) {
    out.push(`COMMENT ON TABLE ${qualify(schema, table.name)} IS ${literal(table.comment)}`);
  }
  for (const c of table.columns) {
    if (c.comment) {
      out.push(
        `COMMENT ON COLUMN ${qualify(schema, table.name)}.${ident(c.name)} IS ${literal(c.comment)}`,
      );
    }
  }
  return out;
}

/**
 * Indexes that exist in their own right. Postgres creates the index behind a primary
 * key or unique constraint automatically, so replaying those here would fail on a
 * duplicate name.
 */
export function standaloneIndexes(schema, table) {
  const constraintBacked = new Set(
    table.constraints.filter((c) => c.type === 'p' || c.type === 'u' || c.type === 'x').map((c) => c.name),
  );
  return table.indexes
    .filter((i) => !i.is_primary && !constraintBacked.has(i.name))
    .map((i) => ({ name: i.name, sql: retarget(i.definition, table.schema_source, schema) }));
}

export function constraintStatements(schema, table, types) {
  return table.constraints
    .filter((c) => types.includes(c.type))
    .map((c) => ({
      name: c.name,
      sql: `ALTER TABLE ${qualify(schema, table.name)} ADD CONSTRAINT ${ident(c.name)} ${retarget(
        c.definition,
        table.schema_source,
        schema,
      )}`,
    }));
}

export function createView(schema, view) {
  const kind = view.kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW';
  return `CREATE ${kind} ${qualify(schema, view.name)} AS\n${view.definition}`;
}

/**
 * pg_get_indexdef and pg_get_constraintdef bake in the source schema name. When the
 * copy lands in a schema of the same name - the default - there is nothing to do.
 */
function retarget(sql, from, to) {
  if (!from || from === to) return sql;
  return sql
    .replaceAll(`${ident(from)}.`, `${ident(to)}.`)
    .replaceAll(new RegExp(`\\b${from}\\.`, 'g'), `${ident(to)}.`);
}

/**
 * A full SQL script for the snapshot, schema only. This is what the "Download schema
 * SQL" button serves; the replicator runs the same statements straight over a socket.
 */
export function schemaScript(snapshot, targetSchema = snapshot.schema) {
  const s = targetSchema;
  const out = [
    `-- Schema ${snapshot.schema} captured ${new Date().toISOString()}`,
    `-- ${snapshot.tables.length} tables, ${snapshot.enums.length} enum types, ${snapshot.sequences.length} sequences`,
    '',
    `${createSchema(s)};`,
    '',
  ];

  if (snapshot.enums.length) {
    out.push('-- enum types');
    for (const e of snapshot.enums) out.push(`${createEnum(s, e)};`);
    out.push('');
  }

  if (snapshot.sequences.length) {
    out.push('-- sequences');
    for (const q of snapshot.sequences) out.push(`${createSequence(s, q)};`);
    out.push('');
  }

  out.push('-- tables');
  for (const t of snapshot.tables) out.push(`${createTable(s, t)};`, '');

  const owned = snapshot.sequences.map((q) => ownSequence(s, q)).filter(Boolean);
  if (owned.length) {
    out.push('-- sequence ownership');
    for (const o of owned) out.push(`${o};`);
    out.push('');
  }

  out.push('-- keys, checks and indexes');
  for (const t of snapshot.tables) {
    for (const c of constraintStatements(s, t, ['p', 'u', 'c', 'x'])) out.push(`${c.sql};`);
    for (const i of standaloneIndexes(s, t)) out.push(`${i.sql};`);
  }
  out.push('');

  out.push('-- foreign keys');
  for (const t of snapshot.tables) {
    for (const c of constraintStatements(s, t, ['f'])) out.push(`${c.sql};`);
  }

  const cmt = snapshot.tables.flatMap((t) => comments(s, t));
  if (cmt.length) {
    out.push('', '-- comments');
    for (const c of cmt) out.push(`${c};`);
  }

  if (snapshot.views.length) {
    out.push('', '-- views');
    for (const v of snapshot.views) out.push(`${createView(s, v)};`);
  }

  return `${out.join('\n')}\n`;
}
