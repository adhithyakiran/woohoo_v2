import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';

import {
  MasterDbAdapter,
  collisions,
  importProperty,
  mapRoom,
  renderBody,
  type MappedCommand,
  type RawCommand,
} from '@woohoo/adapter-masterdb';

/**
 * Room console - the same rooms, devices and commands the CLI drives, with buttons.
 *
 * Two views of one room, deliberately side by side:
 *   · capabilities - what the AGENT can ask for, after translation. This is the path a
 *     guest utterance takes, so pressing a button here exercises what a turn exercises.
 *   · commands - the raw V1 rows underneath. Useful when a capability is missing and you
 *     need to see whether the row exists at all.
 *
 *   npm run room-console        → http://127.0.0.1:4181
 */

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ROOM_CONSOLE_PORT ?? 4181);
const HEAD_END = process.env.HEAD_END_URL ?? 'http://localhost:8092';

const db = new pg.Pool({
  host: process.env.TARGET_DB_HOST ?? 'localhost',
  port: Number(process.env.TARGET_DB_PORT ?? 5433),
  database: process.env.TARGET_DB_NAME ?? 'masterdb',
  user: process.env.TARGET_DB_USER ?? 'postgres',
  password: process.env.TARGET_DB_PASSWORD ?? 'postgres',
  max: 4,
  application_name: 'room-console',
});
db.on('error', (err) => console.error(`[room-console] ${err.message}`));

const adapter = new MasterDbAdapter();
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const wrap =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.get(
  '/api/properties',
  wrap(async (_req, res) => {
    const { rows } = await db.query(
      `select p.id, p.name,
              count(distinct r.id)::int as rooms,
              count(distinct r."hubId")::int as hubs,
              count(s.id)::int as commands,
              string_agg(distinct s."serviceName", ', ') as vendors
         from "propertyDetails" p
         left join rooms r on r."propertyId" = p.id
         left join "roomAutomationServices" s on s."roomId" = r.id and s."deletedAt" is null
        group by 1, 2
        order by commands desc, rooms desc, p.name`,
    );
    res.json({ properties: rows });
  }),
);

app.get(
  '/api/properties/:id/rooms',
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `select r.id, r."roomNo", r.type, r."hubId", r.status,
              h."connectionStatus" as hub_status, h.name as hub_name,
              count(s.id)::int as commands,
              count(s.id) filter (where s."apiUrl" ~ '/v[0-9]+/ping$')::int as inert,
              string_agg(distinct s."serviceName", ', ') as vendors
         from rooms r
         left join "roomAutomationServices" s on s."roomId" = r.id and s."deletedAt" is null
         left join hubs h on h.id = r."hubId"
        where r."propertyId" = $1
        group by 1, 2, 3, 4, 5, 6, 7
        order by r."roomNo" collate "C", r.id`,
      [Number(req.params.id)],
    );
    res.json({ rooms: rows });
  }),
);

app.get(
  '/api/properties/:id/devices',
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `select h.id as "hubId", h.name, h."macAddress", h."ipAddress",
              h."connectionStatus", h."wifiStatus", h.battery,
              h."appVersion", h."firmwareVersion", h."lastLogin",
              r.id as room_id, r."roomNo",
              count(s.id)::int as commands
         from hubs h
         join rooms r on r."hubId" = h.id
         left join "roomAutomationServices" s on s."roomId" = r.id and s."deletedAt" is null
        where r."propertyId" = $1 and h."deletedAt" is null
        group by h.id, h.name, h."macAddress", h."ipAddress", h."connectionStatus",
                 h."wifiStatus", h.battery, h."appVersion", h."firmwareVersion",
                 h."lastLogin", r.id, r."roomNo"
        order by r."roomNo" collate "C"`,
      [Number(req.params.id)],
    );
    res.json({ devices: rows });
  }),
);

/**
 * What is physically in a room.
 *
 * The hub is the voice unit; the "devices" a guest can see are the things it controls -
 * one per distinct itemName, with the states it can be put into. V1 has no device table,
 * so the inventory is derived from the command rows that address each one.
 */
app.get(
  '/api/rooms/:roomId/devices',
  wrap(async (req, res) => {
    const roomId = Number(req.params.roomId);
    const [{ rows: roomRows }, { rows: commandRows }] = await Promise.all([
      db.query(
        `select r.id, r."roomNo", r.type, r."hubId", r.status, r."propertyId",
                p.name as property,
                h.name as hub_name, h."connectionStatus", h."macAddress", h."ipAddress",
                h."wifiName", h."wifiStatus", h.battery, h."appVersion", h."firmwareVersion",
                h."lastLogin", h.locale, h."timeZone"
           from rooms r
           left join "propertyDetails" p on p.id = r."propertyId"
           left join hubs h on h.id = r."hubId"
          where r.id = $1`,
        [roomId],
      ),
      db.query<RawCommand>(
        `select s.id, s."roomId", s."serviceName", s."itemName", s."stateName",
                s."stateType", s."stateValue", s."apiMethod", s."apiUrl",
                s."apiHeaders", s."apiBody"
           from "roomAutomationServices" s
          where s."roomId" = $1 and s."deletedAt" is null
          order by s.sequence nulls last, s.id`,
        [roomId],
      ),
    ]);

    const room = roomRows[0];
    if (!room) return res.status(404).json({ error: `no room ${roomId}` });

    const mapping = mapRoom(roomId, commandRows);
    const capabilityOf = new Map(
      mapping.commands.map((c) => [c.row.id, `${c.capability}${c.zone ? `/${c.zone}` : ''}`]),
    );
    const reasonOf = new Map(mapping.unmapped.map((u) => [u.row.id, u.reason]));

    // Group the rows by the thing they address.
    const items = new Map<string, {
      item: string;
      vendors: Set<string>;
      kind: string;
      capability: string | null;
      unmappedReason: string | null;
      states: Array<{ id: number; stateName: string; stateValue: string | null; method: string | null; path: string | null; inert: boolean }>;
      inert: number;
    }>();

    for (const row of commandRows) {
      const key = row.itemName;
      if (!items.has(key)) {
        items.set(key, {
          item: key,
          vendors: new Set(),
          kind: row.stateType,
          capability: capabilityOf.get(row.id) ?? null,
          unmappedReason: reasonOf.get(row.id) ?? null,
          states: [],
          inert: 0,
        });
      }
      const entry = items.get(key)!;
      entry.vendors.add(row.serviceName);
      if (!entry.capability) entry.capability = capabilityOf.get(row.id) ?? null;
      if (!entry.unmappedReason) entry.unmappedReason = reasonOf.get(row.id) ?? null;
      const inert = /\/v\d+\/ping$/.test(row.apiUrl ?? '');
      if (inert) entry.inert += 1;
      entry.states.push({
        id: row.id,
        stateName: row.stateName,
        stateValue: row.stateValue,
        method: row.apiMethod,
        path: pathOf(row.apiUrl),
        inert,
      });
    }

    res.json({
      room,
      hub: room.hubId
        ? {
            hubId: room.hubId,
            name: room.hub_name,
            connectionStatus: room.connectionStatus,
            macAddress: room.macAddress,
            ipAddress: room.ipAddress,
            wifiName: room.wifiName,
            wifiStatus: room.wifiStatus,
            battery: room.battery,
            appVersion: room.appVersion,
            firmwareVersion: room.firmwareVersion,
            lastLogin: room.lastLogin,
            locale: room.locale,
            timeZone: room.timeZone,
          }
        : null,
      items: [...items.values()]
        .map((i) => ({ ...i, vendors: [...i.vendors] }))
        .sort((a, b) => a.item.localeCompare(b.item)),
    });
  }),
);

/**
 * Every stored API request, across the whole estate, searchable.
 *
 * This is the catalogue as an API catalogue rather than as a room: what requests exist,
 * where they go, and which of them are health checks wearing a device's name.
 */
app.get(
  '/api/commands',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const propertyId = req.query.property ? Number(req.query.property) : null;
    const vendor = String(req.query.vendor ?? '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const onlyInert = req.query.inert === 'true';

    const where: string[] = [`s."deletedAt" is null`];
    const values: unknown[] = [];
    if (propertyId) {
      values.push(propertyId);
      where.push(`r."propertyId" = $${values.length}`);
    }
    if (vendor) {
      values.push(vendor);
      where.push(`s."serviceName" = $${values.length}`);
    }
    if (onlyInert) where.push(`s."apiUrl" ~ '/v[0-9]+/ping$'`);
    if (q) {
      values.push(`%${q}%`);
      const i = values.length;
      where.push(
        `(s."itemName" ilike $${i} or s."stateName" ilike $${i} or s."apiUrl" ilike $${i}
          or s."serviceName" ilike $${i} or r."roomNo" ilike $${i} or p.name ilike $${i})`,
      );
    }
    const whereSql = `where ${where.join(' and ')}`;

    const [{ rows }, { rows: counts }] = await Promise.all([
      db.query(
        `select s.id, s."serviceName", s."itemName", s."stateName", s."stateType",
                s."stateValue", s."apiMethod", s."apiUrl", s."apiHeaders", s."apiBody",
                s."roomId", r."roomNo", r."propertyId", p.name as property
           from "roomAutomationServices" s
           join rooms r on r.id = s."roomId"
           left join "propertyDetails" p on p.id = r."propertyId"
           ${whereSql}
          order by p.name, r."roomNo" collate "C", s.sequence nulls last, s.id
          limit ${limit} offset ${offset}`,
        values,
      ),
      db.query<{ n: string }>(
        `select count(*)::bigint as n
           from "roomAutomationServices" s
           join rooms r on r.id = s."roomId"
           left join "propertyDetails" p on p.id = r."propertyId"
           ${whereSql}`,
        values,
      ),
    ]);

    res.json({
      total: Number(counts[0]?.n ?? 0),
      limit,
      offset,
      commands: rows.map((c) => ({
        ...c,
        inert: /\/v\d+\/ping$/.test(c.apiUrl ?? ''),
      })),
    });
  }),
);

/** The vendor list, for the filter. */
app.get(
  '/api/vendors',
  wrap(async (_req, res) => {
    const { rows } = await db.query(
      `select "serviceName" as vendor, count(*)::int as commands
         from "roomAutomationServices" where "deletedAt" is null
        group by 1 order by 2 desc`,
    );
    res.json({ vendors: rows });
  }),
);

/** Everything about one room: both views, plus what could not be translated. */
app.get(
  '/api/rooms/:roomId',
  wrap(async (req, res) => {
    const roomId = Number(req.params.roomId);
    const [{ rows: roomRows }, { rows: commandRows }] = await Promise.all([
      db.query(
        `select r.id, r."roomNo", r.type, r."hubId", r.status, r."propertyId",
                p.name as property, h."connectionStatus" as hub_status, h.name as hub_name,
                h."ipAddress", h."firmwareVersion"
           from rooms r
           left join "propertyDetails" p on p.id = r."propertyId"
           left join hubs h on h.id = r."hubId"
          where r.id = $1`,
        [roomId],
      ),
      db.query<RawCommand>(
        `select s.id, s."roomId", s."serviceName", s."itemName", s."stateName",
                s."stateType", s."stateValue", s."apiMethod", s."apiUrl",
                s."apiHeaders", s."apiBody"
           from "roomAutomationServices" s
          where s."roomId" = $1 and s."deletedAt" is null
          order by s.sequence nulls last, s.id`,
        [roomId],
      ),
    ]);

    const room = roomRows[0];
    if (!room) return res.status(404).json({ error: `no room ${roomId}` });

    const mapping = mapRoom(roomId, commandRows);

    // One control per capability+zone. A toggle carries both rows; a setpoint carries the
    // template row and takes its value from the UI.
    const controls = new Map<string, {
      key: string;
      capability: string;
      zone?: string;
      kind: 'toggle' | 'choice' | 'number';
      options: Array<{ label: string; value: string | boolean; rowId: number; item: string }>;
    }>();

    for (const cmd of mapping.commands) {
      const key = `${cmd.capability}${cmd.zone ? `/${cmd.zone}` : ''}`;
      const kind: 'toggle' | 'choice' | 'number' =
        cmd.value === null ? 'number' : typeof cmd.value === 'boolean' ? 'toggle' : 'choice';
      if (!controls.has(key)) {
        controls.set(key, {
          key,
          capability: cmd.capability,
          ...(cmd.zone ? { zone: cmd.zone } : {}),
          kind,
          options: [],
        });
      }
      const control = controls.get(key)!;
      if (cmd.value !== null) {
        control.options.push({
          label: labelFor(cmd),
          value: cmd.value,
          rowId: cmd.row.id,
          item: cmd.item,
        });
      }
    }

    res.json({
      room,
      controls: [...controls.values()].sort((a, b) => a.key.localeCompare(b.key)),
      // Two lamps that share one capability are two buttons the agent cannot choose between.
      collisions: collisions(mapping),
      commands: commandRows.map((c) => ({
        id: c.id,
        serviceName: c.serviceName,
        itemName: c.itemName,
        stateName: c.stateName,
        stateType: c.stateType,
        stateValue: c.stateValue,
        apiMethod: c.apiMethod,
        apiUrl: c.apiUrl,
        apiBody: c.apiBody,
        // A command whose URL is a health check controls nothing, however healthy it looks.
        inert: /\/v\d+\/ping$/.test(c.apiUrl ?? ''),
      })),
      unmapped: mapping.unmapped.map((u) => ({
        id: u.row.id,
        itemName: u.row.itemName,
        stateName: u.row.stateName,
        reason: u.reason,
      })),
    });
  }),
);

/** Press a capability button - the path a guest utterance takes. */
app.post(
  '/api/rooms/:roomId/capability',
  wrap(async (req, res) => {
    const roomId = String(Number(req.params.roomId));
    const { capability, zone, value } = req.body ?? {};
    if (!capability) return res.status(400).json({ error: 'capability is required' });

    const started = Date.now();
    const result = await adapter.applyCapability(
      { vendorRoomId: roomId, propertyId: String(req.body?.propertyId ?? '0') },
      { capability, ...(zone ? { zone } : {}), value },
      `console-${Date.now()}`,
    );
    res.json({ ...result, ms: Date.now() - started, asked: { capability, zone, value } });
  }),
);

/** Fire one raw row, unchanged. The escape hatch when a capability is missing. */
app.post(
  '/api/rooms/:roomId/command',
  wrap(async (req, res) => {
    const { rows } = await db.query<RawCommand>(
      `select s.id, s."roomId", s."serviceName", s."itemName", s."stateName",
              s."stateType", s."stateValue", s."apiMethod", s."apiUrl",
              s."apiHeaders", s."apiBody"
         from "roomAutomationServices" s
        where s.id = $1 and s."roomId" = $2`,
      [Number(req.body?.commandId), Number(req.params.roomId)],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'no such command in this room' });
    if (!row.apiUrl) return res.status(400).json({ error: 'command has no url' });

    let host: string | null = null;
    try {
      host = new URL(row.apiUrl).hostname;
    } catch {
      /* unparseable - refused below */
    }
    if (!host || !LOCAL_HOSTS.has(host)) {
      return res.status(403).json({
        error: `refusing to send to ${host ?? row.apiUrl} - run tools/db-viewer/sql/sanitise-local.sql`,
      });
    }

    const method = (row.apiMethod ?? 'GET').toUpperCase();
    const body =
      req.body?.value !== undefined ? renderBody(row.apiBody, req.body.value) : row.apiBody;
    const sendsBody = body != null && method !== 'GET' && method !== 'HEAD';
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': `console-${Date.now()}`,
      ...(row.apiHeaders ?? {}),
    };

    const started = Date.now();
    try {
      const upstream = await fetch(row.apiUrl, {
        method,
        headers,
        body: sendsBody ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await upstream.text();
      res.json({
        status: upstream.ok ? 'pending' : 'rejected',
        ms: Date.now() - started,
        request: { method, url: row.apiUrl, headers, body: sendsBody ? body : null },
        response: { status: upstream.status, body: text.slice(0, 2000) },
      });
    } catch (err) {
      res.json({
        status: 'rejected',
        ms: Date.now() - started,
        request: { method, url: row.apiUrl, headers, body: sendsBody ? body : null },
        error: (err as Error).message,
      });
    }
  }),
);

/** The V2 catalogue this property would import as - the same thing `npm run capability -- import` prints. */
app.get(
  '/api/properties/:id/catalogue',
  wrap(async (req, res) => {
    res.json(await importProperty(Number(req.params.id)));
  }),
);

/** What the head-end actually received, so the console never has to be believed. */
app.get(
  '/api/captured',
  wrap(async (_req, res) => {
    try {
      const upstream = await fetch(`${HEAD_END}/_captured`, { signal: AbortSignal.timeout(4000) });
      const body = (await upstream.json()) as { count?: number; requests?: unknown[] };
      res.json({ reachable: true, count: body.count ?? 0, requests: body.requests ?? [] });
    } catch (err) {
      res.json({ reachable: false, error: (err as Error).message, count: 0, requests: [] });
    }
  }),
);

app.delete(
  '/api/captured',
  wrap(async (_req, res) => {
    try {
      await fetch(`${HEAD_END}/_captured`, { method: 'DELETE', signal: AbortSignal.timeout(4000) });
    } catch {
      /* nothing to clear if it is not running */
    }
    res.json({ cleared: true });
  }),
);

app.use(express.static(resolvePath(ROOT, 'public'), { extensions: ['html'] }));

app.use(((err, _req, res, _next) => {
  console.error(`[room-console] ${err.stack ?? err.message}`);
  res.status(err.status ?? 500).json({ error: err.message });
}) as express.ErrorRequestHandler);

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function labelFor(cmd: MappedCommand): string {
  if (typeof cmd.value === 'boolean') return cmd.value ? 'On' : 'Off';
  return String(cmd.value);
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  woohoo room console`);
  console.log(`  rooms     ${process.env.TARGET_DB_NAME ?? 'masterdb'} on localhost:${process.env.TARGET_DB_PORT ?? 5433}`);
  console.log(`  head-end  ${HEAD_END}`);
  console.log(`  open      http://127.0.0.1:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    server.close();
    await Promise.allSettled([db.end(), adapter.close()]);
    process.exit(0);
  });
}
