#!/usr/bin/env node
import { resolve } from 'node:path';
import express from 'express';

import { api } from './api.js';
import { assertConfigured, ROOT, redact, server as serverCfg, source } from './config.js';
import { closeAll } from './db.js';

try {
  assertConfigured();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/api', api);
app.use(express.static(resolve(ROOT, 'public'), { extensions: ['html'] }));

// Errors from any route land here so the browser always gets JSON, never HTML.
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(`[api] ${err.stack ?? err.message}`);
  res.status(status).json({ error: err.message, code: err.code ?? null });
});

const httpServer = app.listen(serverCfg.port, serverCfg.host, () => {
  const { host, port } = serverCfg;
  const s = redact(source);
  console.log(`\n  woohoo db viewer`);
  console.log(`  browsing  ${s.user}@${s.host}:${s.port}/${s.database}`);
  console.log(`  open      http://${host}:${port}\n`);
});

// Long-running replications hold sockets open; give them a moment, then let go.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nshutting down…');
    httpServer.close();
    await closeAll();
    process.exit(0);
  });
}
