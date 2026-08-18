import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Mock Honeywell INNCOM head-end.
 *
 * A standalone HTTP service that behaves like a real property controller, so the INNCOM
 * adapter can be developed and tested against a network endpoint rather than an in-process
 * fake. The difference matters: connection handling, timeouts, retries and circuit breaking
 * are exactly the code paths an in-process stub never exercises.
 *
 * It deliberately models what actually goes wrong in hotels:
 *   · object/register addressing that is NOT the hotel room number
 *   · variable write latency
 *   · intermittent unreachability
 *   · writes that ACKNOWLEDGE but never take effect  ← the one that causes false confirmations
 *   · state drifting because a guest used a wall switch
 *
 *   PORT=8091 npm run mock-honeywell
 */

const PORT = Number(process.env.PORT ?? 8091);
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 120);
const FAILURE_RATE = Number(process.env.MOCK_FAILURE_RATE ?? 0);
const SILENT_FAILURE_RATE = Number(process.env.MOCK_SILENT_FAILURE_RATE ?? 0);
const DRIFT_RATE = Number(process.env.MOCK_DRIFT_RATE ?? 0);

/** INNCOM addresses objects by number, not by anything human-readable. */
interface ObjectPoint {
  objectId: string;
  kind: 'light' | 'dimmer' | 'setpoint' | 'mode' | 'curtain' | 'dnd' | 'tv';
  zone: string;
  value: number | string | boolean;
  /** Some curtain motors are binary; the adapter must cope, not the model. */
  binary?: boolean;
}

interface VendorRoom {
  vendorRoomId: string;
  /** The hotel's own room number. Present ONLY so the mock can be inspected by a human —
   *  the protocol never uses it, and neither should an adapter. */
  humanLabel: string;
  points: Map<string, ObjectPoint>;
}

const rooms = new Map<string, VendorRoom>();

function seedRoom(vendorRoomId: string, humanLabel: string, opts: { curtains?: 'position' | 'binary' | 'none'; zones?: string[] } = {}) {
  const zones = opts.zones ?? ['bedroom'];
  const points = new Map<string, ObjectPoint>();
  let n = 0x10;
  const add = (p: Omit<ObjectPoint, 'objectId'>) => {
    const objectId = '0x' + (n++).toString(16).toUpperCase().padStart(2, '0');
    points.set(objectId, { ...p, objectId });
  };
  for (const zone of zones) {
    add({ kind: 'light', zone, value: false });
    add({ kind: 'dimmer', zone, value: 0 });
    add({ kind: 'setpoint', zone, value: zone === 'bedroom' ? 19.5 : 22 });
    add({ kind: 'mode', zone, value: 'auto' });
    if (opts.curtains && opts.curtains !== 'none') {
      add({ kind: 'curtain', zone, value: 100, binary: opts.curtains === 'binary' });
    }
  }
  add({ kind: 'dnd', zone: 'room', value: 'off' });
  add({ kind: 'tv', zone: 'room', value: 'off' });
  rooms.set(vendorRoomId, { vendorRoomId, humanLabel, points });
}

// Vendor room ids deliberately do NOT match the hotel room numbers — assuming they do is a
// classic onboarding bug whose symptom is actions landing in the wrong room.
seedRoom('INN-0412', '412', { curtains: 'none', zones: ['bedroom', 'bathroom'] });
seedRoom('INN-0511', '511', { curtains: 'position', zones: ['bedroom', 'living', 'bathroom'] });
seedRoom('INN-0512', '512', { curtains: 'binary', zones: ['bedroom', 'living'] });
seedRoom('INN-0088', '88', { curtains: 'binary', zones: ['bedroom'] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.round(LATENCY_MS * (0.6 + Math.random() * 0.8));

/** A guest or housekeeper touching a wall switch. The adapter must tolerate this. */
function maybeDrift(room: VendorRoom) {
  if (Math.random() >= DRIFT_RATE) return;
  const lights = [...room.points.values()].filter((p) => p.kind === 'light');
  const p = lights[Math.floor(Math.random() * lights.length)];
  if (p) p.value = !p.value;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 65536) throw new Error('body too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // Health — no artificial latency or failure, so a circuit breaker can probe cheaply.
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { status: 'ok', vendor: 'inncom-mock', rooms: rooms.size });
  }

  // Human-readable dump. Not part of any vendor protocol — for debugging only.
  if (req.method === 'GET' && url.pathname === '/debug/rooms') {
    return send(res, 200, [...rooms.values()].map((r) => ({
      vendorRoomId: r.vendorRoomId,
      humanLabel: r.humanLabel,
      points: [...r.points.values()],
    })));
  }

  await sleep(jitter());

  if (Math.random() < FAILURE_RATE) {
    return send(res, 503, { error: 'ERR_0x8004', message: 'Head-end busy' });
  }

  // GET /api/v1/rooms/:vendorRoomId/objects
  if (req.method === 'GET' && parts[0] === 'api' && parts[2] === 'rooms' && parts[4] === 'objects') {
    const room = rooms.get(parts[3]!);
    if (!room) return send(res, 404, { error: 'ERR_0x2001', message: 'Unknown room reference' });
    maybeDrift(room);
    return send(res, 200, { room: room.vendorRoomId, objects: [...room.points.values()] });
  }

  // PUT /api/v1/rooms/:vendorRoomId/objects/:objectId   { value }
  if (req.method === 'PUT' && parts[0] === 'api' && parts[2] === 'rooms' && parts[4] === 'objects') {
    const room = rooms.get(parts[3]!);
    if (!room) return send(res, 404, { error: 'ERR_0x2001', message: 'Unknown room reference' });
    const point = room.points.get(parts[5]!);
    if (!point) return send(res, 404, { error: 'ERR_0x2002', message: 'Unknown object' });

    let body: Record<string, unknown>;
    try { body = await readBody(req); }
    catch { return send(res, 400, { error: 'ERR_0x1001', message: 'Malformed request' }); }

    let value = body.value as number | string | boolean;

    // Binary curtain motors cannot hold an intermediate position. Real hardware silently
    // snaps; the adapter must report what was OBSERVED, not what was requested.
    if (point.kind === 'curtain' && point.binary && typeof value === 'number') {
      value = value >= 50 ? 100 : 0;
    }

    // The nastiest real failure: 200 OK, nothing changed. Only a read-back catches it.
    const silent = Math.random() < SILENT_FAILURE_RATE;
    if (!silent) point.value = value;

    return send(res, 200, { object: point.objectId, accepted: true, value: point.value });
  }

  send(res, 404, { error: 'ERR_0x1000', message: 'No such endpoint' });
});

server.listen(PORT, () => {
  console.log(`mock-honeywell (INNCOM) on http://localhost:${PORT}`);
  console.log(`  rooms: ${[...rooms.keys()].join(', ')}`);
  console.log(`  latency ${LATENCY_MS}ms · failure ${FAILURE_RATE} · silent-failure ${SILENT_FAILURE_RATE} · drift ${DRIFT_RATE}`);
  console.log(`  GET  /api/v1/rooms/INN-0511/objects`);
  console.log(`  PUT  /api/v1/rooms/INN-0511/objects/0x10   {"value": true}`);
  console.log(`  GET  /debug/rooms`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
