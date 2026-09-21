import { Router } from 'express';

import * as browse from './browse.js';
import * as config from './config.js';
import * as docker from './docker.js';
import * as introspect from './introspect.js';
import { schemaScript } from './ddl.js';
import { getJob, listJobs, startReplication } from './replicate.js';

/**
 * The target connection is editable from the UI, so it lives here rather than in the
 * frozen config module. The password never travels back to the browser.
 */
const state = { target: { ...config.target } };

/** Every read endpoint takes ?conn=source|local so the same UI can browse the copy. */
function connectionFor(req) {
  const which = req.query.conn === 'local' || req.query.conn === 'target' ? 'local' : 'source';
  return { which, cfg: which === 'local' ? state.target : config.source };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const api = Router();

api.get('/config', (_req, res) => {
  res.json({
    source: config.redact(config.source),
    target: config.redact(state.target),
    docker: { container: config.docker.container, image: config.docker.image, port: config.docker.port },
  });
});

api.put('/config/target', (req, res) => {
  const b = req.body ?? {};
  state.target = {
    host: b.host || state.target.host,
    port: Number(b.port) || state.target.port,
    database: b.database || state.target.database,
    user: b.user || state.target.user,
    // An empty string is a legitimate password change; undefined means "leave it".
    password: b.password === undefined ? state.target.password : b.password,
    ssl: false,
  };
  res.json({ target: config.redact(state.target) });
});

api.get('/info', wrap(async (req, res) => {
  const { which, cfg } = connectionFor(req);
  const [info, schemas, extensions] = await Promise.all([
    introspect.serverInfo(cfg),
    introspect.listSchemas(cfg),
    introspect.listExtensions(cfg),
  ]);
  res.json({ connection: which, ...config.redact(cfg), info, schemas, extensions });
}));

api.get('/schemas', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  res.json({ schemas: await introspect.listSchemas(cfg) });
}));

api.get('/schemas/:schema/tables', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  res.json({ tables: await introspect.listRelations(cfg, req.params.schema) });
}));

api.get('/schemas/:schema/tables/:table', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  const { schema, table } = req.params;
  const [columns, indexes, constraints, referencedBy] = await Promise.all([
    introspect.listColumns(cfg, schema, table),
    introspect.listIndexes(cfg, schema, table),
    introspect.listConstraints(cfg, schema, table),
    introspect.listReferencedBy(cfg, schema, table),
  ]);
  if (!columns.length) return res.status(404).json({ error: `No table ${schema}.${table}` });
  res.json({ schema, table, columns, indexes, constraints, referencedBy });
}));

api.post('/schemas/:schema/tables/:table/rows', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  res.json(await browse.fetchRows(cfg, { ...req.body, schema: req.params.schema, table: req.params.table }));
}));

api.get('/schemas/:schema/tables/:table/export.csv', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  const { schema, table } = req.params;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
  await browse.streamCsv(cfg, schema, table, res, { limit: req.query.limit });
  res.end();
}));

api.get('/schemas/:schema/script.sql', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  const snapshot = await introspect.snapshot(cfg, req.params.schema);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.schema}.sql"`);
  res.send(schemaScript(snapshot));
}));

api.post('/query', wrap(async (req, res) => {
  const { cfg } = connectionFor(req);
  const sql = String(req.body?.sql ?? '').trim();
  if (!sql) return res.status(400).json({ error: 'No SQL supplied' });
  res.json(await browse.runQuery(cfg, sql, Number(req.body?.limit) || 200));
}));

api.post('/target/test', wrap(async (req, res) => {
  const cfg = { ...state.target, ...pickConnection(req.body) };
  try {
    const info = await introspect.serverInfo(cfg);
    const schemas = await introspect.listSchemas(cfg);
    res.json({ ok: true, info, schemas });
  } catch (err) {
    res.json({ ok: false, error: err.message, code: err.code ?? null });
  }
}));

api.get('/docker/status', wrap(async (_req, res) => {
  const engine = await docker.available();
  res.json({ engine, container: await docker.status(config.docker.container) });
}));

api.post('/docker/up', wrap(async (_req, res) => {
  const result = await docker.up({
    container: config.docker.container,
    image: config.docker.image,
    port: config.docker.port,
    password: config.docker.password,
  });
  res.json(result);
}));

api.post('/docker/stop', wrap(async (_req, res) => {
  res.json(await docker.stop(config.docker.container));
}));

api.post('/replicate', wrap(async (req, res) => {
  const b = req.body ?? {};
  const job = startReplication({
    source: config.source,
    target: { ...state.target, ...pickConnection(b.target) },
    schema: b.schema || 'public',
    targetSchema: b.targetSchema || b.schema || 'public',
    tables: Array.isArray(b.tables) ? b.tables : null,
    mode: ['full', 'schema-only', 'data-only'].includes(b.mode) ? b.mode : 'full',
    dropExisting: Boolean(b.dropExisting),
    truncateFirst: Boolean(b.truncateFirst),
    createDatabase: b.createDatabase !== false,
    includeViews: b.includeViews !== false,
    rowLimit: Number(b.rowLimit) > 0 ? Number(b.rowLimit) : null,
  });
  res.status(202).json({ id: job.id, ...job.summary() });
}));

api.get('/replicate', (_req, res) => res.json({ jobs: listJobs() }));

api.get('/replicate/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  res.json(job.summary());
});

api.post('/replicate/:id/cancel', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  res.json({ cancelled: job.cancel(), status: job.status });
});

/** Server-sent events: the backlog first, then everything as it happens. */
api.get('/replicate/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'snapshot', ...job.summary() });
  for (const event of job.log) send(event);

  const onEvent = (event) => send(event);
  job.on('event', onEvent);

  // Idle SSE connections get closed by proxies; a comment frame keeps them honest.
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    job.off('event', onEvent);
  });
});

function pickConnection(b) {
  if (!b) return {};
  const out = {};
  if (b.host) out.host = b.host;
  if (b.port) out.port = Number(b.port);
  if (b.database) out.database = b.database;
  if (b.user) out.user = b.user;
  if (b.password !== undefined) out.password = b.password;
  return out;
}
