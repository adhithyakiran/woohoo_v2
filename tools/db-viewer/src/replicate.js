import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import copyStreams from 'pg-copy-streams';

import * as ddl from './ddl.js';
import { ident, literal, qualify, snapshot } from './introspect.js';
import { rawClient } from './db.js';

const { to: copyTo, from: copyFrom } = copyStreams;

const jobs = new Map();

export const getJob = (id) => jobs.get(id);
export const listJobs = () =>
  [...jobs.values()].map((j) => j.summary()).sort((a, b) => b.startedAt - a.startedAt);

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * One replication run: remote schema in, local schema out.
 *
 * Progress is pushed as events rather than polled so the browser can render a live
 * log; the same events are replayed from `this.log` when a client connects late.
 */
class Job extends EventEmitter {
  constructor(options) {
    super();
    this.id = randomUUID().slice(0, 8);
    this.options = options;
    this.status = 'pending';
    this.phase = 'queued';
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.error = null;
    this.cancelRequested = false;
    this.log = [];
    this.tables = new Map();
    this.warnings = [];
    this.totals = { tables: 0, rows: 0, expectedRows: 0, bytes: 0 };
    this.setMaxListeners(0);
  }

  emitEvent(type, data = {}) {
    const event = { type, at: Date.now(), ...data };
    // The log is what a late-joining browser replays, so cap it rather than let a
    // long run grow without bound. Table progress lives in `this.tables` anyway.
    this.log.push(event);
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
    this.emit('event', event);
  }

  say(level, message, extra = {}) {
    this.emitEvent('log', { level, message, ...extra });
  }

  setPhase(phase, message) {
    this.phase = phase;
    this.emitEvent('phase', { phase, message });
  }

  checkCancelled() {
    if (this.cancelRequested) throw new Cancelled();
  }

  cancel() {
    if (this.status !== 'running') return false;
    this.cancelRequested = true;
    this.say('warn', 'Cancellation requested - stopping after the current statement.');
    for (const stream of this.activeStreams ?? []) stream.destroy(new Cancelled());
    return true;
  }

  tableState(name) {
    let t = this.tables.get(name);
    if (!t) {
      t = { name, status: 'pending', rows: 0, expected: 0, bytes: 0, ms: 0 };
      this.tables.set(name, t);
    }
    return t;
  }

  summary() {
    return {
      id: this.id,
      status: this.status,
      phase: this.phase,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      warnings: this.warnings,
      totals: this.totals,
      // Neither password goes back to the browser.
      options: {
        ...this.options,
        source: { ...this.options.source, password: undefined },
        target: { ...this.options.target, password: undefined },
      },
      tables: [...this.tables.values()],
    };
  }
}

/** Counts rows as the COPY stream passes through. */
function rowCounter(onChunk) {
  let rows = 0;
  let bytes = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      // COPY TEXT escapes newlines inside values, so one \n really is one row.
      for (let i = 0; i < chunk.length; i += 1) if (chunk[i] === 0x0a) rows += 1;
      onChunk(rows, bytes);
      cb(null, chunk);
    },
  });
}

async function ensureDatabase(target, say) {
  // CREATE DATABASE cannot run inside the database it creates, so this connects to
  // the maintenance database first.
  const admin = await rawClient({ ...target, database: 'postgres' });
  try {
    const { rows } = await admin.query('select 1 from pg_database where datname = $1', [
      target.database,
    ]);
    if (rows.length) {
      say('info', `Database ${target.database} already exists on the target.`);
      return false;
    }
    await admin.query(`CREATE DATABASE ${ident(target.database)}`);
    say('ok', `Created database ${target.database}.`);
    return true;
  } finally {
    await admin.end().catch(() => {});
  }
}

async function run(job) {
  const { source: sourceCfg, target, schema, targetSchema, mode, tables: selected } = job.options;
  const wantsData = mode !== 'schema-only';
  const wantsSchema = mode !== 'data-only';
  job.activeStreams = new Set();

  let src = null;
  let dst = null;

  try {
    job.status = 'running';
    job.setPhase('connect', 'Connecting to both databases');

    if (job.options.createDatabase) await ensureDatabase(target, (l, m) => job.say(l, m));

    src = await rawClient(sourceCfg);
    dst = await rawClient(target);
    job.say('ok', `Connected to source ${sourceCfg.host}/${sourceCfg.database}.`);
    job.say('ok', `Connected to target ${target.host}:${target.port}/${target.database}.`);
    job.checkCancelled();

    job.setPhase('inspect', `Reading the ${schema} schema`);
    const snap = await snapshot(sourceCfg, schema);
    const wanted = selected?.length ? new Set(selected) : null;
    snap.tables = snap.tables.filter((t) => !wanted || wanted.has(t.name));
    const keptTables = new Set(snap.tables.map((t) => t.name));
    snap.sequences = snap.sequences.filter(
      (s) => !s.owned_by_table || keptTables.has(s.owned_by_table),
    );
    if (!snap.tables.length) throw new Error('No tables matched the selection.');

    job.totals.tables = snap.tables.length;
    for (const t of snap.tables) {
      const state = job.tableState(t.name);
      state.expected = Number(t.estimated_rows) || 0;
      job.totals.expectedRows += state.expected;
    }
    job.emitEvent('plan', {
      tables: [...job.tables.values()],
      enums: snap.enums.length,
      sequences: snap.sequences.length,
      views: snap.views.length,
    });
    job.say(
      'info',
      `Plan: ${snap.tables.length} tables, ${snap.enums.length} enum types, ` +
        `${snap.sequences.length} sequences, ~${job.totals.expectedRows.toLocaleString()} rows.`,
    );

    const exec = async (sql, label, { fatal = true } = {}) => {
      job.checkCancelled();
      try {
        await dst.query(sql);
        if (label) job.say('ok', label);
      } catch (err) {
        if (fatal) throw new Error(`${label ?? 'statement'} failed: ${err.message}`);
        job.warnings.push(`${label ?? 'statement'}: ${err.message}`);
        job.say('warn', `${label ?? 'statement'} skipped - ${err.message}`);
      }
    };

    if (wantsSchema) {
      job.setPhase('schema', 'Creating types, sequences and tables');
      if (job.options.dropExisting) {
        await exec(ddl.dropSchema(targetSchema), `Dropped existing schema ${targetSchema}.`);
      }
      await exec(ddl.createSchema(targetSchema), `Schema ${targetSchema} ready.`);
      await dst.query(`SET search_path TO ${ident(targetSchema)}, public`);

      for (const e of snap.enums) {
        await exec(ddl.createEnum(targetSchema, e), null, { fatal: false });
      }
      if (snap.enums.length) job.say('ok', `Created ${snap.enums.length} enum types.`);

      for (const s of snap.sequences) await exec(ddl.createSequence(targetSchema, s), null);
      if (snap.sequences.length) job.say('ok', `Created ${snap.sequences.length} sequences.`);

      for (const t of snap.tables) {
        await exec(ddl.createTable(targetSchema, t), null);
        job.tableState(t.name).status = 'created';
        job.emitEvent('table', job.tableState(t.name));
      }
      job.say('ok', `Created ${snap.tables.length} tables.`);

      for (const s of snap.sequences) {
        const own = ddl.ownSequence(targetSchema, s);
        if (own) await exec(own, null, { fatal: false });
      }
    } else {
      await dst.query(`SET search_path TO ${ident(targetSchema)}, public`);
    }

    if (wantsData) {
      job.setPhase('data', 'Copying rows');
      // Triggers and FK checks during a bulk load are pure overhead: the source is
      // already consistent and the constraints go on afterwards.
      await exec(`SET session_replication_role = replica`, null, { fatal: false });

      for (const t of snap.tables) {
        job.checkCancelled();
        await copyTable(job, src, dst, schema, targetSchema, t);
      }
      await exec(`SET session_replication_role = origin`, null, { fatal: false });

      job.setPhase('sequences', 'Restoring sequence positions');
      for (const s of snap.sequences) {
        try {
          const { rows } = await src.query(
            `select last_value, is_called from ${qualify(schema, s.name)}`,
          );
          const { last_value: last, is_called: called } = rows[0];
          await dst.query(
            // regclass parses its argument as an identifier, so a camelCase sequence
            // name has to arrive already quoted or Postgres folds it to lower case.
            `select setval(${literal(qualify(targetSchema, s.name))}::regclass, $1::bigint, $2)`,
            [String(last), called],
          );
        } catch (err) {
          job.warnings.push(`sequence ${s.name}: ${err.message}`);
        }
      }
      job.say('ok', `Restored ${snap.sequences.length} sequence positions.`);
    }

    if (wantsSchema) {
      job.setPhase('constraints', 'Adding keys, checks and indexes');
      let added = 0;
      for (const t of snap.tables) {
        for (const c of ddl.constraintStatements(targetSchema, t, ['p', 'u', 'c', 'x'])) {
          await exec(c.sql, null, { fatal: false });
          added += 1;
        }
        for (const i of ddl.standaloneIndexes(targetSchema, t)) {
          await exec(i.sql, null, { fatal: false });
          added += 1;
        }
        job.emitEvent('table', { ...job.tableState(t.name), status: 'indexed' });
      }
      job.say('ok', `Added ${added} keys and indexes.`);

      job.setPhase('foreign-keys', 'Adding foreign keys');
      // A partial copy cannot satisfy every reference, so those keys go on unvalidated
      // rather than failing the run.
      const notValid = Boolean(job.options.rowLimit);
      let fks = 0;
      for (const t of snap.tables) {
        for (const c of ddl.constraintStatements(targetSchema, t, ['f'])) {
          await exec(notValid ? `${c.sql} NOT VALID` : c.sql, null, { fatal: false });
          fks += 1;
        }
      }
      job.say('ok', `Added ${fks} foreign keys${notValid ? ' (unvalidated - row limit in use)' : ''}.`);

      for (const t of snap.tables) {
        for (const c of ddl.comments(targetSchema, t)) await exec(c, null, { fatal: false });
      }

      if (job.options.includeViews && snap.views.length) {
        job.setPhase('views', 'Recreating views');
        for (const v of snap.views) {
          await exec(ddl.createView(targetSchema, v), null, { fatal: false });
        }
        job.say('ok', `Recreated ${snap.views.length} views.`);
      }
    }

    job.setPhase('analyze', 'Updating planner statistics');
    await exec('ANALYZE', 'Ran ANALYZE on the target.', { fatal: false });

    job.status = 'succeeded';
    job.setPhase('done', 'Replication complete');
    job.say(
      'ok',
      `Done in ${((Date.now() - job.startedAt) / 1000).toFixed(1)}s - ` +
        `${job.totals.rows.toLocaleString()} rows across ${job.totals.tables} tables.`,
    );
  } catch (err) {
    if (err instanceof Cancelled || job.cancelRequested) {
      job.status = 'cancelled';
      job.setPhase('cancelled', 'Replication cancelled');
      job.say('warn', 'Replication cancelled. The target is left as-is.');
    } else {
      job.status = 'failed';
      job.error = err.message;
      job.setPhase('failed', 'Replication failed');
      job.say('error', err.message);
    }
  } finally {
    job.finishedAt = Date.now();
    await src?.end().catch(() => {});
    await dst?.end().catch(() => {});
    job.emitEvent('done', job.summary());
  }
}

async function copyTable(job, src, dst, schema, targetSchema, table) {
  const state = job.tableState(table.name);
  const started = Date.now();
  state.status = 'copying';
  state.rows = 0;
  job.emitEvent('table', state);

  // Generated columns are recomputed by the target and cannot be written to.
  const cols = table.columns.filter((c) => c.generated !== 's').map((c) => ident(c.name));
  if (!cols.length) {
    state.status = 'skipped';
    job.emitEvent('table', state);
    return;
  }

  const limit = job.options.rowLimit ? ` LIMIT ${Number(job.options.rowLimit)}` : '';
  const selectSql = `COPY (SELECT ${cols.join(', ')} FROM ${qualify(schema, table.name)}${limit}) TO STDOUT`;
  const insertSql = `COPY ${qualify(targetSchema, table.name)} (${cols.join(', ')}) FROM STDIN`;

  if (job.options.truncateFirst) {
    await dst.query(`TRUNCATE ${qualify(targetSchema, table.name)} CASCADE`).catch(() => {});
  }

  const reader = src.query(copyTo(selectSql));
  const writer = dst.query(copyFrom(insertSql));
  job.activeStreams.add(reader);
  job.activeStreams.add(writer);

  let lastEmit = 0;
  const counter = rowCounter((rows, bytes) => {
    state.rows = rows;
    state.bytes = bytes;
    const now = Date.now();
    if (now - lastEmit > 250) {
      lastEmit = now;
      job.emitEvent('table', state);
    }
  });

  try {
    await pipeline(reader, counter, writer);
    state.status = 'copied';
  } catch (err) {
    state.status = 'failed';
    state.error = err.message;
    job.emitEvent('table', state);
    if (err instanceof Cancelled || job.cancelRequested) throw new Cancelled();
    throw new Error(`copying ${table.name}: ${err.message}`);
  } finally {
    job.activeStreams.delete(reader);
    job.activeStreams.delete(writer);
  }

  state.ms = Date.now() - started;
  job.totals.rows += state.rows;
  job.totals.bytes += state.bytes;
  job.emitEvent('table', state);
  job.say(
    'ok',
    `${table.name}: ${state.rows.toLocaleString()} rows in ${(state.ms / 1000).toFixed(1)}s`,
  );
}

export function startReplication(options) {
  const job = new Job(options);
  jobs.set(job.id, job);
  // Older runs are kept so their log can still be read, but not forever.
  if (jobs.size > 20) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest.status !== 'running') jobs.delete(oldest.id);
  }
  run(job);
  return job;
}
