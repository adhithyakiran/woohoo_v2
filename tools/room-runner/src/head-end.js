#!/usr/bin/env node
import { createServer } from 'node:http';

/**
 * Catch-all vendor head-end.
 *
 * The commands in masterdb address four different vendors - interel, AMX over AWS IoT,
 * schneider over BACnet, tis - each with its own paths and payloads. mock-honeywell
 * speaks one protocol properly, which is the right thing for adapter development and
 * the wrong thing here: this stands in for whatever the row happens to address, so a
 * command taken from production data can be fired and observed end to end.
 *
 * It answers anything, records everything, and can be told to misbehave:
 *
 *   PORT=8092 npm run head-end
 *   GET http://localhost:8092/_captured     what has been received, newest first
 *   DELETE http://localhost:8092/_captured  clear the log
 *
 *   HEAD_END_LATENCY_MS   artificial delay, default 40
 *   HEAD_END_FAILURE_RATE fraction of requests answered 503, default 0
 */

const PORT = Number(process.env.PORT ?? 8092);
const LATENCY_MS = Number(process.env.HEAD_END_LATENCY_MS ?? 40);
const FAILURE_RATE = Number(process.env.HEAD_END_FAILURE_RATE ?? 0);
const KEEP = Number(process.env.HEAD_END_KEEP ?? 500);

const captured = [];
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 262_144) break;
  }
  return raw;
}

/**
 * Shape the reply like the vendor the path belongs to. A runner that only ever sees
 * `{"ok":true}` cannot tell a working integration from a broken one.
 */
function vendorReply(pathname, body) {
  if (pathname.includes('/interelrestapi') || pathname.includes('/roomcontrol')) {
    return { Result: 'Success', ResultCode: 0, Message: 'Command accepted' };
  }
  if (pathname.includes('/control/devices')) {
    return { status: 'success', code: 200, data: { accepted: true, echo: body ?? null } };
  }
  if (pathname.includes('/bacnet/')) {
    // Schneider EcoStruxure answers a property write with the property document.
    const id = pathname.split('/objects/')[1]?.split('/')[0] ?? 'unknown';
    return { id, property: '85', value: body?.value ?? body ?? null, written: true };
  }
  if (pathname.includes('/topics')) {
    // AWS IoT Core HTTP publish returns an empty 200 with a message id.
    return { messageId: `mock-${++seq}` };
  }
  if (pathname.endsWith('/token')) {
    return { access_token: 'mock-local-token', token: 'mock-local-token', expires_in: 3600 };
  }
  return { accepted: true, path: pathname };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/_captured') {
    if (req.method === 'DELETE') {
      captured.length = 0;
      return send(res, 200, { cleared: true });
    }
    return send(res, 200, { count: captured.length, requests: captured.slice(0, 100) });
  }
  if (url.pathname === '/health') {
    return send(res, 200, { status: 'ok', vendor: 'catch-all', captured: captured.length });
  }

  const raw = await readBody(req);
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw || null;
  }

  const record = {
    n: ++seq,
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: parsed,
  };
  captured.unshift(record);
  if (captured.length > KEEP) captured.length = KEEP;

  console.log(
    `${String(record.n).padStart(4)} ${req.method?.padEnd(6)} ${url.pathname}` +
      (parsed ? `  ${JSON.stringify(parsed).slice(0, 120)}` : ''),
  );

  if (LATENCY_MS) await sleep(Math.round(LATENCY_MS * (0.6 + Math.random() * 0.8)));
  if (Math.random() < FAILURE_RATE) {
    return send(res, 503, { error: 'HEAD_END_BUSY', message: 'Simulated head-end failure' });
  }

  send(res, 200, vendorReply(url.pathname, parsed));
});

server.listen(PORT, () => {
  console.log(`catch-all head-end on http://localhost:${PORT}`);
  console.log(`  latency ${LATENCY_MS}ms · failure rate ${FAILURE_RATE}`);
  console.log(`  GET /_captured to see what arrived\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
