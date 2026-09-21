#!/usr/bin/env node
import pg from 'pg';

/**
 * Run the room-automation commands that live in the local masterdb copy.
 *
 * roomAutomationServices is not a description of what a room can do - it is the request
 * itself: method, url, headers, body, one row per state a device can be put into. This
 * reads a room's rows and fires them, so "did the command for room 549 reach the device"
 * becomes a thing you can watch rather than infer.
 *
 *   npm run room -- rooms                       rooms that have commands
 *   npm run room -- show 2389                   the catalog for one room
 *   npm run room -- fire 2389 "Master On"       fire matching commands
 *   npm run room -- test 2389                   fire everything, summarise
 *
 * Points at the LOCAL copy by default and refuses anything that is not local, because
 * these rows address real head-ends when they have not been sanitised.
 */

const cfg = {
  host: process.env.TARGET_DB_HOST ?? 'localhost',
  port: Number(process.env.TARGET_DB_PORT ?? 5433),
  database: process.env.TARGET_DB_NAME ?? 'masterdb',
  user: process.env.TARGET_DB_USER ?? 'postgres',
  password: process.env.TARGET_DB_PASSWORD ?? 'postgres',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOW_REMOTE = process.env.ROOM_RUNNER_ALLOW_REMOTE === 'yes';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const pool = new pg.Pool({ ...cfg, max: 4, application_name: 'room-runner' });
const q = async (text, params = []) => (await pool.query(text, params)).rows;

/** A command whose URL still points off-box would reach a real hotel. */
function assertSafe(command) {
  let host;
  try {
    host = new URL(command.apiUrl).hostname;
  } catch {
    return { safe: false, reason: `unparseable url: ${command.apiUrl}` };
  }
  if (LOCAL_HOSTS.has(host) || ALLOW_REMOTE) return { safe: true };
  return {
    safe: false,
    reason: `${host} is not local - run tools/db-viewer/sql/sanitise-local.sql first`,
  };
}

async function listRooms(args) {
  const property = args.property ? Number(args.property) : null;
  const rows = await q(
    `select r.id, r."roomNo", r."propertyId", p.name as property, r."hubId",
            h."connectionStatus" as hub_status,
            count(s.id)::int as commands,
            string_agg(distinct s."serviceName", ', ') as vendors
       from rooms r
       join "roomAutomationServices" s on s."roomId" = r.id and s."deletedAt" is null
       left join "propertyDetails" p on p.id = r."propertyId"
       left join hubs h on h.id = r."hubId"
      where ($1::int is null or r."propertyId" = $1)
      group by 1,2,3,4,5,6
      order by commands desc, r.id
      limit $2`,
    [property, Number(args.limit ?? 25)],
  );

  console.log(
    c.bold('\n  room  roomNo  property                              hub          cmds  vendors'),
  );
  for (const r of rows) {
    const hub = r.hub_status === 'online' ? c.green('online ') : c.dim(r.hub_status ?? 'no hub ');
    console.log(
      `  ${String(r.id).padEnd(5)} ${String(r.roomNo).padEnd(7)} ` +
        `${(r.property ?? '-').slice(0, 36).padEnd(37)} ${hub} ` +
        `${String(r.commands).padStart(4)}  ${r.vendors}`,
    );
  }
  console.log(c.dim(`\n  ${rows.length} rooms. npm run room -- show <room>\n`));
}

async function commandsFor(roomId) {
  return q(
    `select s.id, s.sequence, s."serviceName", s."itemName", s."itemDesc", s."stateName",
            s."stateType", s."stateValue", s."currentState",
            s."apiMethod", s."apiUrl", s."apiHeaders", s."apiBody",
            r."roomNo", r."hubId", p.name as property
       from "roomAutomationServices" s
       join rooms r on r.id = s."roomId"
       left join "propertyDetails" p on p.id = r."propertyId"
      where s."roomId" = $1 and s."deletedAt" is null
      order by s.sequence nulls last, s.id`,
    [roomId],
  );
}

async function show(roomId) {
  const rows = await commandsFor(roomId);
  if (!rows.length) return console.log(c.yellow(`\n  room ${roomId} has no automation commands\n`));

  const [first] = rows;
  console.log(
    `\n  ${c.bold(`room ${roomId}`)}  ·  no. ${first.roomNo}  ·  ${first.property ?? '-'}  ·  hub ${first.hubId ?? '-'}`,
  );
  console.log(c.dim(`  ${rows.length} commands\n`));

  let vendor = null;
  for (const r of rows) {
    if (r.serviceName !== vendor) {
      vendor = r.serviceName;
      console.log(`  ${c.cyan(vendor)}`);
    }
    const url = r.apiUrl ? new URL(r.apiUrl).pathname : '-';
    console.log(
      `    ${String(r.id).padStart(6)}  ${(r.itemName ?? '').padEnd(24)} ` +
        `${(r.stateName ?? '').padEnd(26)} ${(r.stateType ?? '').padEnd(12)} ` +
        `${(r.apiMethod ?? '').padEnd(5)} ${c.dim(url)}`,
    );
  }
  console.log(c.dim(`\n  npm run room -- fire ${roomId} "<state or item name>"\n`));
}

/** Fires one row exactly as stored and reports what crossed the wire. */
async function fireOne(cmd, { verbose = true, timeoutMs = 10_000 } = {}) {
  const safety = assertSafe(cmd);
  if (!safety.safe) {
    console.log(`  ${c.red('REFUSED')} ${cmd.stateName} - ${safety.reason}`);
    return { ok: false, refused: true };
  }

  const headers = { 'content-type': 'application/json', ...(cmd.apiHeaders ?? {}) };
  const method = (cmd.apiMethod ?? 'GET').toUpperCase();
  const hasBody = cmd.apiBody != null && method !== 'GET' && method !== 'HEAD';

  if (verbose) {
    console.log(`\n  ${c.bold('→')} ${method} ${cmd.apiUrl}`);
    for (const [k, v] of Object.entries(headers)) {
      console.log(c.dim(`      ${k}: ${String(v).slice(0, 70)}`));
    }
    if (hasBody) console.log(c.dim(`      ${JSON.stringify(cmd.apiBody)}`));
  }

  const started = Date.now();
  const control = AbortController ? new AbortController() : null;
  const timer = control ? setTimeout(() => control.abort(), timeoutMs) : null;

  try {
    const res = await fetch(cmd.apiUrl, {
      method,
      headers,
      body: hasBody ? JSON.stringify(cmd.apiBody) : undefined,
      signal: control?.signal,
    });
    const ms = Date.now() - started;
    const text = await res.text();
    const ok = res.ok;
    if (verbose) {
      const mark = ok ? c.green(`← ${res.status}`) : c.red(`← ${res.status}`);
      console.log(`  ${mark} in ${ms}ms  ${c.dim(text.slice(0, 200))}`);
    }
    return { ok, status: res.status, ms, body: text };
  } catch (err) {
    const ms = Date.now() - started;
    if (verbose) console.log(`  ${c.red('← failed')} in ${ms}ms  ${err.message}`);
    return { ok: false, ms, error: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fire(roomId, match) {
  const rows = await commandsFor(roomId);
  const needle = (match ?? '').toLowerCase();
  const chosen = needle
    ? rows.filter(
        (r) =>
          String(r.id) === needle ||
          r.stateName?.toLowerCase().includes(needle) ||
          r.itemName?.toLowerCase().includes(needle),
      )
    : [];

  if (!needle) return console.log(c.yellow('\n  give something to match: npm run room -- fire 2389 "Master On"\n'));
  if (!chosen.length) {
    console.log(c.yellow(`\n  nothing in room ${roomId} matches "${match}"`));
    console.log(c.dim(`  npm run room -- show ${roomId}\n`));
    return;
  }

  console.log(`\n  firing ${chosen.length} command(s) for room ${roomId}`);
  for (const cmd of chosen) {
    console.log(`\n  ${c.bold(cmd.stateName)}  ${c.dim(`${cmd.serviceName} · ${cmd.itemName} · id ${cmd.id}`)}`);
    await fireOne(cmd);
  }
  console.log('');
}

async function test(roomId) {
  const rows = await commandsFor(roomId);
  if (!rows.length) return console.log(c.yellow(`\n  room ${roomId} has no automation commands\n`));

  console.log(`\n  firing all ${rows.length} commands for room ${roomId}\n`);
  const results = [];
  for (const cmd of rows) {
    const r = await fireOne(cmd, { verbose: false });
    results.push({ cmd, r });
    const mark = r.refused ? c.yellow('SKIP') : r.ok ? c.green(' ok ') : c.red('FAIL');
    console.log(
      `  ${mark} ${(cmd.serviceName ?? '').padEnd(14)} ${(cmd.stateName ?? '').padEnd(28)} ` +
        `${r.status ?? r.error ?? ''} ${r.ms != null ? c.dim(`${r.ms}ms`) : ''}`,
    );
  }

  const ok = results.filter((x) => x.r.ok).length;
  const failed = results.filter((x) => !x.r.ok && !x.r.refused).length;
  const skipped = results.filter((x) => x.r.refused).length;
  const times = results.map((x) => x.r.ms).filter(Boolean).sort((a, b) => a - b);
  console.log(
    `\n  ${ok} reached the head-end · ${failed} failed · ${skipped} refused` +
      (times.length ? ` · median ${times[Math.floor(times.length / 2)]}ms` : ''),
  );
  console.log(c.dim('  check what arrived: curl -s localhost:8092/_captured | jq\n'));
  return failed === 0 ? 0 : 1;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? argv[++i] ?? true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

try {
  switch (command) {
    case 'rooms':
      await listRooms(flags);
      break;
    case 'show':
      await show(Number(rest[0]));
      break;
    case 'fire':
      await fire(Number(rest[0]), rest.slice(1).join(' '));
      break;
    case 'test':
      process.exitCode = (await test(Number(rest[0]))) ?? 0;
      break;
    default:
      console.log(`
  ${c.bold('room-runner')} - fire the automation commands held in the local masterdb copy

    npm run room -- rooms [--property 167] [--limit 25]
    npm run room -- show 2389
    npm run room -- fire 2389 "Master On"
    npm run room -- test 2389

  Start the catch-all head-end first:  npm run head-end
`);
  }
} finally {
  await pool.end();
}
