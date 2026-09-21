# db-viewer

Browse a remote Postgres in the browser, and pull a working copy of it onto this
machine when you need one. Built for the `masterdb` RDS instance, but it reads
everything it needs from `pg_catalog`, so it works against any Postgres 10+.

```bash
cp tools/db-viewer/.env.example tools/db-viewer/.env   # fill in SOURCE_DB_*
npm run db-viewer                                      # http://127.0.0.1:4180
```

## What it does

**Browse.** Schemas, tables, views and materialised views in the sidebar with row
estimates and on-disk sizes. Pick one and you get:

- **Data** - a paged, sortable grid; free-text search across every non-JSON column;
  per-column filters (`=`, `≠`, contains, starts with, `<`/`>`, is null); CSV export
  streamed straight from the server; and a click-to-expand drawer that pretty-prints
  JSON values. Column names and operators are validated against the catalog on the
  server, so the browser can name a column but never send a fragment of SQL.
- **Structure** - columns with types, nullability, defaults, identity and generated
  markers; indexes with their definitions and sizes; check constraints.
- **Relations** - foreign keys out of the table and into it, each one a link that
  jumps you there.
- **SQL** - an ad-hoc console. Statements run inside a `BEGIN READ ONLY`
  transaction with a statement timeout, so the server rejects writes rather than
  trusting the client not to send them.

The URL tracks where you are (`#source/public/rooms/data`), so reloads and shared
links land in the same place.

**Replicate.** The *Replicate to local* button copies the remote schema into a local
Postgres:

1. Starts a throwaway Postgres in Docker if you do not already have one
   (`postgres:16-alpine` on port 5433), or point it at any server you like.
2. Creates the database, then the enum types, sequences and tables.
3. Streams every row with `COPY … TO STDOUT` piped into `COPY … FROM STDIN` - no
   `pg_dump` binary needed, and nothing buffers in Node.
4. Restores sequence positions, then adds primary keys, unique and check
   constraints, indexes and foreign keys - after the data, because a bulk load into
   an unindexed table is several times faster.
5. Runs `ANALYZE`.

Progress streams to the browser over SSE: per-table row counts as they land, a live
log, and a cancel button. When it finishes, the **Local copy** tab in the header
switches the whole UI over to the copy you just made, so the same screens work
against both.

A full run of the 70-table `masterdb` (1.05M rows, 280 MB) takes about 90 seconds.

### Options

| Option | Effect |
| --- | --- |
| Mode | Schema and data, schema only, or data into an existing schema |
| Rows per table | Copy the first N rows instead of everything - foreign keys are then added `NOT VALID`, since a partial copy cannot satisfy them |
| Create the database | `CREATE DATABASE` on the target if it is missing |
| Drop the target schema first | `DROP SCHEMA … CASCADE` for a clean rebuild |
| Recreate views | Replays view and materialised-view definitions |
| Table picker | Copy a subset; sequences follow the tables that own them |

`GET /api/schemas/:schema/script.sql` returns the whole thing as a plain SQL file if
you would rather run it yourself.

## Notes

- **The remote database is only ever read.** Browsing runs in read-only
  transactions and replication issues nothing but `COPY … TO STDOUT` against the
  source. Every write goes to the target.
- **A copy is a point-in-time snapshot, not a replica.** Each table is copied in its
  own `COPY`, so a table still taking writes can land a row or two behind a table
  copied a minute earlier. Re-run it when you want fresh data.
- **What is not copied:** functions, triggers, row-level security policies, roles and
  grants, extensions, and large objects. Tables, columns, defaults, identity and
  generated columns, enum types, sequences, indexes, all constraints, comments and
  views are.
- Credentials live in `.env`, which is gitignored. Nothing in `src/` has a password
  in it, and neither password is ever sent to the browser.

## Layout

| File | Role |
| --- | --- |
| `src/config.js` | `.env` loading, connection defaults, redaction |
| `src/db.js` | Connection pools, read-only transactions, COPY clients |
| `src/introspect.js` | Every `pg_catalog` query, plus the whole-schema snapshot |
| `src/ddl.js` | Snapshot → `CREATE`/`ALTER` statements, in dependency order |
| `src/browse.js` | Paging, filtering, the SQL console, CSV streaming |
| `src/replicate.js` | The job engine: phases, COPY streams, progress events |
| `src/docker.js` | Starting and checking the local Postgres container |
| `src/api.js` | HTTP surface, including the SSE progress stream |
| `public/` | The UI - no build step, no framework |
