import { rows } from './db.js';

/** Double-quote an identifier for interpolation into DDL/DML. */
export const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const qualify = (schema, name) => `${ident(schema)}.${ident(name)}`;
export const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema','pg_toast')`;

export function listSchemas(cfg) {
  return rows(
    cfg,
    `select n.nspname                                        as schema,
            pg_get_userbyid(n.nspowner)                      as owner,
            count(c.oid) filter (where c.relkind in ('r','p'))::int as tables,
            count(c.oid) filter (where c.relkind in ('v','m'))::int as views,
            coalesce(sum(pg_total_relation_size(c.oid))
                     filter (where c.relkind in ('r','p','m')), 0)::bigint as bytes
       from pg_namespace n
       left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r','p','v','m')
      where n.nspname not in ${SYSTEM_SCHEMAS}
        and n.nspname not like 'pg\\_temp%'
        and n.nspname not like 'pg\\_toast%'
      group by 1, 2
      order by 1`,
  );
}

/** Tables, partitioned tables, views and materialised views in one list. */
export function listRelations(cfg, schema) {
  return rows(
    cfg,
    `select c.relname                             as name,
            c.relkind                             as kind,
            greatest(c.reltuples, 0)::bigint      as estimated_rows,
            pg_total_relation_size(c.oid)::bigint as bytes,
            obj_description(c.oid, 'pg_class')    as comment,
            (select count(*)::int from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
        and c.relkind in ('r','p','v','m')
      order by c.relkind, c.relname`,
    [schema],
  );
}

export function listColumns(cfg, schema, table) {
  return rows(
    cfg,
    `select a.attname                             as name,
            a.attnum                              as position,
            format_type(a.atttypid, a.atttypmod)  as type,
            t.typname                             as base_type,
            t.typtype                             as type_kind,
            tn.nspname                            as type_schema,
            a.attnotnull                          as not_null,
            pg_get_expr(d.adbin, d.adrelid)       as default_expr,
            a.attidentity                         as identity,
            a.attgenerated                        as generated,
            col_description(a.attrelid, a.attnum) as comment,
            coalesce(pk.is_pk, false)             as is_primary_key
       from pg_attribute a
       join pg_class c      on c.oid = a.attrelid
       join pg_namespace n  on n.oid = c.relnamespace
       join pg_type t       on t.oid = a.atttypid
       join pg_namespace tn on tn.oid = t.typnamespace
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       left join lateral (
            select true as is_pk
              from pg_index i
             where i.indrelid = a.attrelid and i.indisprimary
               and a.attnum = any (i.indkey)
             limit 1
       ) pk on true
      where n.nspname = $1 and c.relname = $2
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [schema, table],
  );
}

export function listIndexes(cfg, schema, table) {
  return rows(
    cfg,
    `select i.relname                       as name,
            pg_get_indexdef(x.indexrelid)   as definition,
            x.indisunique                   as is_unique,
            x.indisprimary                  as is_primary,
            pg_relation_size(i.oid)::bigint as bytes
       from pg_index x
       join pg_class i     on i.oid = x.indexrelid
       join pg_class c     on c.oid = x.indrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2
      order by x.indisprimary desc, i.relname`,
    [schema, table],
  );
}

/**
 * Constraints on a table. `type` is p(rimary) u(nique) c(heck) f(oreign) x(exclusion).
 * Foreign keys carry the referenced relation so the UI can link across tables.
 */
export function listConstraints(cfg, schema, table) {
  return rows(
    cfg,
    `select con.conname                   as name,
            con.contype::text             as type,
            pg_get_constraintdef(con.oid) as definition,
            rn.nspname                    as references_schema,
            rc.relname                    as references_table
       from pg_constraint con
       join pg_class c     on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_class rc     on rc.oid = con.confrelid
       left join pg_namespace rn on rn.oid = rc.relnamespace
      where n.nspname = $1 and c.relname = $2
      order by array_position(array['p','u','f','c','x'], con.contype::text), con.conname`,
    [schema, table],
  );
}

/** Foreign keys pointing *at* this table - the other half of the relationship view. */
export function listReferencedBy(cfg, schema, table) {
  return rows(
    cfg,
    `select con.conname                   as name,
            n.nspname                     as schema,
            c.relname                     as "table",
            pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class c      on c.oid = con.conrelid
       join pg_namespace n  on n.oid = c.relnamespace
       join pg_class rc     on rc.oid = con.confrelid
       join pg_namespace rn on rn.oid = rc.relnamespace
      where con.contype = 'f' and rn.nspname = $1 and rc.relname = $2
      order by n.nspname, c.relname`,
    [schema, table],
  );
}

export function listEnums(cfg, schema) {
  return rows(
    cfg,
    `select t.typname as name,
            array_agg(e.enumlabel::text order by e.enumsortorder) as labels
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       join pg_enum e      on e.enumtypid = t.oid
      where n.nspname = $1
      group by t.typname
      order by t.typname`,
    [schema],
  );
}

/**
 * Sequences with the column that owns them. Serial columns default to nextval(...),
 * so every sequence has to exist on the target before its table is created.
 */
export function listSequences(cfg, schema) {
  return rows(
    cfg,
    `select c.relname                    as name,
            s.seqtypid::regtype::text    as data_type,
            s.seqstart::text             as start,
            s.seqincrement::text         as increment,
            s.seqmin::text               as min_value,
            s.seqmax::text               as max_value,
            s.seqcache::text             as cache,
            s.seqcycle                   as cycle,
            owner.relname                as owned_by_table,
            a.attname                    as owned_by_column
       from pg_sequence s
       join pg_class c     on c.oid = s.seqrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_depend d
              on d.objid = c.oid and d.classid = 'pg_class'::regclass
             and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i')
       left join pg_class owner on owner.oid = d.refobjid
       left join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
      where n.nspname = $1
      order by c.relname`,
    [schema],
  );
}

export function listViews(cfg, schema) {
  return rows(
    cfg,
    `select c.relname                   as name,
            c.relkind                   as kind,
            pg_get_viewdef(c.oid, true) as definition
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('v','m')
      order by c.relkind, c.relname`,
    [schema],
  );
}

export function listExtensions(cfg) {
  return rows(
    cfg,
    `select e.extname as name, e.extversion as version, n.nspname as schema
       from pg_extension e
       join pg_namespace n on n.oid = e.extnamespace
      where e.extname <> 'plpgsql'
      order by e.extname`,
  );
}

export async function serverInfo(cfg) {
  const [info] = await rows(
    cfg,
    `select version()                                    as version,
            current_database()                           as database,
            current_user                                 as "user",
            pg_database_size(current_database())::bigint as bytes,
            current_setting('server_version_num')::int   as version_num`,
  );
  return info;
}

/**
 * Everything the replicator needs about one schema.
 *
 * Deliberately one query per object kind rather than per table: over a remote link a
 * 70-table schema is 200-odd round trips the other way, which is most of a minute
 * before a single row moves.
 */
export async function snapshot(cfg, schema) {
  const [enums, sequences, relations, views, columns, indexes, constraints] = await Promise.all([
    listEnums(cfg, schema),
    listSequences(cfg, schema),
    listRelations(cfg, schema),
    listViews(cfg, schema),
    schemaColumns(cfg, schema),
    schemaIndexes(cfg, schema),
    schemaConstraints(cfg, schema),
  ]);

  const byTable = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const { table, ...rest } = row;
      if (!map.has(table)) map.set(table, []);
      map.get(table).push(rest);
    }
    return map;
  };

  const cols = byTable(columns);
  const idx = byTable(indexes);
  const cons = byTable(constraints);

  const tables = relations
    .filter((r) => r.kind === 'r' || r.kind === 'p')
    .map((t) => ({
      ...t,
      // Carried so DDL lifted from pg_get_*def can be re-pointed at another schema.
      schema_source: schema,
      columns: cols.get(t.name) ?? [],
      indexes: idx.get(t.name) ?? [],
      constraints: cons.get(t.name) ?? [],
    }));

  return { schema, enums, sequences, tables, views };
}

function schemaColumns(cfg, schema) {
  return rows(
    cfg,
    `select c.relname                             as "table",
            a.attname                             as name,
            a.attnum                              as position,
            format_type(a.atttypid, a.atttypmod)  as type,
            t.typname                             as base_type,
            a.attnotnull                          as not_null,
            pg_get_expr(d.adbin, d.adrelid)       as default_expr,
            a.attidentity                         as identity,
            a.attgenerated                        as generated,
            col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a
       join pg_class c     on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t      on t.oid = a.atttypid
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = $1 and c.relkind in ('r','p')
        and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`,
    [schema],
  );
}

function schemaIndexes(cfg, schema) {
  return rows(
    cfg,
    `select c.relname                     as "table",
            i.relname                     as name,
            pg_get_indexdef(x.indexrelid) as definition,
            x.indisunique                 as is_unique,
            x.indisprimary                as is_primary
       from pg_index x
       join pg_class i     on i.oid = x.indexrelid
       join pg_class c     on c.oid = x.indrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p')
      order by c.relname, x.indisprimary desc, i.relname`,
    [schema],
  );
}

function schemaConstraints(cfg, schema) {
  return rows(
    cfg,
    `select c.relname                     as "table",
            con.conname                   as name,
            con.contype::text             as type,
            pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class c     on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p')
      order by c.relname, array_position(array['p','u','f','c','x'], con.contype::text), con.conname`,
    [schema],
  );
}
