import type { Zone } from '@woohoo/contracts';
import { MasterDbAdapter } from './index.js';
import { importProperty } from './import.js';
import pg from 'pg';

/**
 * Drives the adapter the way the orchestrator will: in capabilities, never in vendor
 * words. If `apply 2389 lighting.on_off --zone bedroom --value true` reaches a BACnet
 * object, the dictionary works.
 *
 *   npm run capability -- report --property 167
 *   npm run capability -- apply 2389 lighting.on_off --zone bedroom --value true
 *   npm run capability -- conformance 2389
 */

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k!] = v ?? argv[++i] ?? 'true';
    } else positional.push(a);
  }
  return { positional, flags };
}

const dbConfig = {
  host: process.env.TARGET_DB_HOST ?? 'localhost',
  port: Number(process.env.TARGET_DB_PORT ?? 5433),
  database: process.env.TARGET_DB_NAME ?? 'masterdb',
  user: process.env.TARGET_DB_USER ?? 'postgres',
  password: process.env.TARGET_DB_PASSWORD ?? 'postgres',
};

async function roomsOfProperty(propertyId: number): Promise<number[]> {
  const pool = new pg.Pool({ ...dbConfig, max: 2 });
  try {
    const { rows } = await pool.query<{ id: number }>(
      `select distinct r.id
         from rooms r join "roomAutomationServices" s on s."roomId" = r.id
        where r."propertyId" = $1 and s."deletedAt" is null
        order by r.id`,
      [propertyId],
    );
    return rows.map((r) => r.id);
  } finally {
    await pool.end();
  }
}

async function report(propertyId: number) {
  const adapter = new MasterDbAdapter();
  const roomIds = await roomsOfProperty(propertyId);
  const allUnmapped: Array<{ room: number; item: string; state: string; reason: string }> = [];

  console.log(c.bold(`\n  mapping coverage - property ${propertyId}\n`));
  for (const roomId of roomIds) {
    const mapping = await adapter.mappingFor({ vendorRoomId: String(roomId), propertyId: String(propertyId) });
    const total = mapping.commands.length + mapping.unmapped.length;
    const pct = Math.round((mapping.commands.length / total) * 100);
    const mark = mapping.unmapped.length === 0 ? c.green('✓') : c.yellow('!');
    console.log(
      `  ${mark} room ${String(roomId).padEnd(6)} ${String(mapping.commands.length).padStart(3)}/${String(total).padEnd(3)} mapped ${c.dim(`${pct}%`)}`,
    );

    const byCapability = new Map<string, number>();
    for (const cmd of mapping.commands) {
      const key = `${cmd.capability}${cmd.zone ? `/${cmd.zone}` : ''}`;
      byCapability.set(key, (byCapability.get(key) ?? 0) + 1);
    }
    for (const [key, n] of [...byCapability].sort()) {
      console.log(c.dim(`        ${key.padEnd(34)} ${n}`));
    }
    for (const u of mapping.unmapped) {
      allUnmapped.push({ room: roomId, item: u.row.itemName, state: u.row.stateName, reason: u.reason });
    }
  }

  if (allUnmapped.length) {
    console.log(c.bold(c.yellow('\n  needs a human\n')));
    for (const u of allUnmapped) {
      console.log(`    room ${u.room}  ${c.cyan(`${u.item} / ${u.state}`)}`);
      console.log(c.dim(`      ${u.reason}`));
    }
  } else {
    console.log(c.green('\n  every command mapped'));
  }
  console.log('');
  await adapter.close();
}

async function apply(roomId: number, capability: string, flags: Record<string, string>) {
  const adapter = new MasterDbAdapter();
  const raw = flags.value ?? 'true';
  const value: number | string | boolean =
    raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;

  const op = {
    capability,
    ...(flags.zone ? { zone: flags.zone as Zone } : {}),
    value,
  };

  console.log(c.bold('\n  the agent asks for:'));
  console.log(`    ${JSON.stringify(op)}`);

  const mapping = await adapter.mappingFor({ vendorRoomId: String(roomId), propertyId: '0' });
  const { resolve } = await import('./mapping.js');
  const chosen = resolve(mapping, op);
  if (chosen) {
    console.log(c.bold('\n  the adapter picks:'));
    console.log(
      `    row ${chosen.row.id}  ${c.cyan(chosen.row.stateName)}  ${c.dim(
        `${chosen.row.serviceName} · ${chosen.row.apiMethod} ${new URL(chosen.row.apiUrl!).pathname}`,
      )}`,
    );
  }

  const result = await adapter.applyCapability(
    { vendorRoomId: String(roomId), propertyId: '0' },
    op,
    `cli-${Date.now()}`,
  );

  const colour = result.status === 'rejected' ? c.red : result.status === 'pending' ? c.green : c.yellow;
  console.log(c.bold('\n  result:'));
  console.log(`    ${colour(result.status)}  ${result.message ?? ''}\n`);
  await adapter.close();
}

async function importCmd(propertyId: number, flags: Record<string, string>) {
  const imported = await importProperty(propertyId);
  if (flags.json) {
    console.log(JSON.stringify(imported, null, 2));
    return;
  }

  const p = imported.property;
  console.log(c.bold(`\n  ${p.name}`));
  console.log(`    tenant      ${p.tenantId}`);
  console.log(`    property    ${p.propertyId}`);
  console.log(`    timezone    ${p.timezone}   adapter ${p.automation.vendor}`);

  console.log(c.bold('\n  room types (grouped by what the rooms can actually do)'));
  for (const rt of p.roomTypes) {
    console.log(`    ${c.cyan(rt.id)}  ${rt.count} room(s)`);
    for (const cap of rt.capabilityManifest.capabilities) {
      const zones = cap.zones?.length ? ` ${c.dim(cap.zones.join(', '))}` : '';
      console.log(`      ${cap.capability}${zones}`);
    }
    if (rt.capabilityManifest.scenes?.length) {
      console.log(c.dim(`      scenes: ${rt.capabilityManifest.scenes.join(', ')}`));
    }
  }

  console.log(c.bold('\n  rooms'));
  for (const r of imported.rooms) {
    const device = imported.devices.find((d) => d.roomId === r.roomId);
    console.log(
      `    ${r.roomId.padEnd(14)} no.${r.roomNumber.padEnd(6)} ${r.roomTypeId.padEnd(18)} ` +
        `${c.dim(`vendor ${r.vendorRoomId}`)}  ${device ? c.dim(device.deviceId) : c.yellow('no device')}`,
    );
  }

  if (imported.warnings.length) {
    console.log(c.bold(c.yellow('\n  onboarding warnings')));
    for (const w of imported.warnings) console.log(`    ${w}`);
  }
  console.log('');
}

async function conformance(roomId: number) {
  const adapter = new MasterDbAdapter();
  const room = { vendorRoomId: String(roomId), propertyId: '0' };
  console.log(c.bold(`\n  conformance - room ${roomId}\n`));
  for (const test of adapter.conformanceSuite()) {
    const r = await test.run(adapter, room);
    console.log(`  ${r.pass ? c.green('PASS') : c.red('FAIL')}  ${test.name}`);
    console.log(c.dim(`        ${r.detail}`));
  }
  console.log('');
  await adapter.close();
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

switch (command) {
  case 'report':
    await report(Number(flags.property ?? 167));
    break;
  case 'apply':
    await apply(Number(rest[0]), rest[1]!, flags);
    break;
  case 'import':
    await importCmd(Number(flags.property ?? 167), flags);
    break;
  case 'conformance':
    await conformance(Number(rest[0]));
    break;
  default:
    console.log(`
  ${c.bold('capability')} - drive the masterdb adapter in capability terms

    npm run capability -- report --property 167
    npm run capability -- apply 2389 lighting.on_off --zone bedroom --value true
    npm run capability -- apply 2389 climate.setpoint --value 21
    npm run capability -- conformance 2389
    npm run capability -- import --property 167 [--json]
`);
}
