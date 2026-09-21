import pg from 'pg';
import {
  type AdapterHealth,
  type AutomationAdapter,
  type CapabilityOperation,
  type CapabilityResult,
  type CapabilityState,
  type ConformanceTest,
  type ConnectionHandle,
  type PropertyBinding,
  type StateChange,
  type Unsubscribe,
  type VendorRoomRef,
  type Zone,
} from '@woohoo/contracts';
import { recordVendorCall } from '@woohoo/otel';

import {
  mapRoom,
  renderBody,
  resolve,
  type RawCommand,
  type RoomMapping,
} from './mapping.js';

/**
 * AutomationAdapter over the V1 masterdb catalogue - architecture doc §39.1.
 *
 * The other adapters speak a protocol. This one speaks a *table*: roomAutomationServices
 * holds, per room, the literal HTTP request for every state a device can be put into, for
 * whichever of interel / AMX / schneider / tis that property runs. So one adapter covers
 * every V1 property, and the vendor vocabulary still stops here.
 *
 * What it cannot do is read anything back. The catalogue is 100% write commands - not one
 * row in 14,312 asks a device its state - so `readRoomState` returns nothing and a
 * successful write is `pending`, never `applied`. Echoing the requested value back as an
 * observation is exactly the false confirmation §39 exists to prevent.
 */

export interface MasterDbAdapterOptions {
  connection?: pg.PoolConfig;
  /** Refuse to send anywhere that is not localhost. On by default; the rows are production. */
  localOnly?: boolean;
  timeoutMs?: number;
}

export class RoomNotProvisioned extends Error {}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class MasterDbAdapter implements AutomationAdapter {
  readonly vendor = 'masterdb-catalogue';

  private readonly pool: pg.Pool;
  private readonly localOnly: boolean;
  private readonly timeoutMs: number;
  /** Per-room mapping is derived once; the catalogue changes at onboarding speed, not turn speed. */
  private readonly mappings = new Map<string, RoomMapping>();
  /**
   * vendorRoomId -> capability+zone -> what was last asked for. Bounded by the number of
   * capabilities a room has, so it cannot grow without limit.
   */
  private readonly commanded = new Map<
    string,
    Map<string, { capability: string; zone?: Zone; value: number | string | boolean; at: number }>
  >();
  private readonly subs = new Map<string, Array<(c: StateChange) => void>>();

  constructor(opts: MasterDbAdapterOptions = {}) {
    this.pool = new pg.Pool({
      host: process.env.TARGET_DB_HOST ?? 'localhost',
      port: Number(process.env.TARGET_DB_PORT ?? 5433),
      database: process.env.TARGET_DB_NAME ?? 'masterdb',
      user: process.env.TARGET_DB_USER ?? 'postgres',
      password: process.env.TARGET_DB_PASSWORD ?? 'postgres',
      max: 4,
      application_name: 'adapter-masterdb',
      ...opts.connection,
    });
    this.pool.on('error', (err) => console.error(`[adapter-masterdb] ${err.message}`));
    this.localOnly = opts.localOnly ?? true;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async connect(binding: PropertyBinding): Promise<ConnectionHandle> {
    await this.pool.query('select 1');
    return {
      propertyId: binding.propertyId,
      connectedAt: Date.now(),
      close: async () => {
        await this.pool.end();
      },
    };
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      await this.pool.query('select 1');
      return { reachable: true, latencyMs: Date.now() - started };
    } catch {
      return { reachable: false, latencyMs: Date.now() - started };
    }
  }

  /**
   * Where each command originally pointed, before sanitise rewrote it - vendor URL and
   * header names only, never a header value. Empty when archive-origins has not been run.
   */
  async originsFor(ids: number[]): Promise<Map<number, { apiUrl: string; apiMethod: string | null; host: string | null; headerNames: string[] }>> {
    if (!ids.length) return new Map();
    try {
      const { rows } = await this.pool.query<{
        id: number; apiUrl: string; apiMethod: string | null; host: string | null; headerNames: string[];
      }>(
        `select id, "apiUrl", "apiMethod", host, "headerNames"
           from "roomAutomationServiceOrigins" where id = any($1::int[])`,
        [ids],
      );
      return new Map(rows.map((r) => [r.id, r]));
    } catch {
      // The table is optional; a copy without it simply shows no original.
      return new Map();
    }
  }

  /** The room's whole command catalogue, translated into capabilities. */
  async mappingFor(room: VendorRoomRef): Promise<RoomMapping> {
    const cached = this.mappings.get(room.vendorRoomId);
    if (cached) return cached;

    const { rows } = await this.pool.query<RawCommand>(
      `select s.id, s."roomId", s."serviceName", s."itemName", s."stateName",
              s."stateType", s."stateValue", s."apiMethod", s."apiUrl",
              s."apiHeaders", s."apiBody"
         from "roomAutomationServices" s
        where s."roomId" = $1 and s."deletedAt" is null
        order by s.sequence nulls last, s.id`,
      [Number(room.vendorRoomId)],
    );
    if (!rows.length) {
      throw new RoomNotProvisioned(`room ${room.vendorRoomId} has no automation commands`);
    }

    const mapping = mapRoom(Number(room.vendorRoomId), rows);
    this.mappings.set(room.vendorRoomId, mapping);
    return mapping;
  }

  /**
   * What this room was last told to do - not what it is doing.
   *
   * The catalogue holds no read commands, so there is nothing to observe. Returning an
   * empty list was truthful but left the agent blind: "turn them off" after "turn them on"
   * had no state to reason about, and "make it warmer" had no starting point.
   *
   * So the adapter remembers what it commanded and reports that. Two things keep it honest:
   * a write still returns `pending`, never `applied`, and device-state refuses to upgrade a
   * non-applied result whatever a read says - so this feeds the agent's context without ever
   * becoming a confirmation. It is a belief, and it is wrong the moment a guest touches a
   * wall switch. That is the cost of a catalogue with no read path.
   */
  async readRoomState(room: VendorRoomRef): Promise<CapabilityState[]> {
    const remembered = this.commanded.get(room.vendorRoomId);
    if (!remembered) return [];
    return [...remembered.values()].map((e) => ({
      capability: e.capability,
      ...(e.zone ? { zone: e.zone } : {}),
      value: e.value,
      available: true,
    }));
  }

  /** Forget a room's commanded state - a new stay starts with no assumptions. */
  forget(room: VendorRoomRef): void {
    this.commanded.delete(room.vendorRoomId);
  }

  /** No vendor callback exists in this data, so nothing will ever fire. Said plainly. */
  subscribe(room: VendorRoomRef, cb: (change: StateChange) => void): Unsubscribe {
    const list = this.subs.get(room.vendorRoomId) ?? [];
    list.push(cb);
    this.subs.set(room.vendorRoomId, list);
    return () => {
      const current = this.subs.get(room.vendorRoomId) ?? [];
      this.subs.set(
        room.vendorRoomId,
        current.filter((f) => f !== cb),
      );
    };
  }

  async applyCapability(
    room: VendorRoomRef,
    op: CapabilityOperation,
    idempotencyKey: string,
  ): Promise<CapabilityResult> {
    const mapping = await this.mappingFor(room);
    const command = resolve(mapping, op);

    if (!command) {
      return {
        status: 'rejected',
        message: `room ${room.vendorRoomId} has no command for ${op.capability}${
          op.zone ? ` in ${op.zone}` : ''
        } = ${String(op.value)}`,
      };
    }

    const { row } = command;
    if (!row.apiUrl) {
      return { status: 'rejected', message: `command ${row.id} has no url` };
    }

    if (this.localOnly) {
      const host = safeHost(row.apiUrl);
      if (!host || !LOCAL_HOSTS.has(host)) {
        return {
          status: 'rejected',
          message: `refusing to send to ${host ?? row.apiUrl} - run sanitise-local.sql`,
        };
      }
    }

    const method = (row.apiMethod ?? 'GET').toUpperCase();
    const body =
      command.value === null ? renderBody(row.apiBody, op.value) : row.apiBody;
    const sendsBody = body != null && method !== 'GET' && method !== 'HEAD';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(row.apiUrl, {
        method,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          ...(row.apiHeaders ?? {}),
        },
        body: sendsBody ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const ms = Date.now() - started;
      let responseBody: string | undefined;
      try {
        responseBody = (await res.text()).slice(0, 2000);
      } catch {
        /* body already consumed or empty */
      }

      // The turn's own record of what left the building. Without this the console's
      // Room API tab is blank for every masterdb room and the vendor call is invisible.
      recordVendorCall({
        vendor: `${this.vendor}/${row.serviceName}`,
        method,
        url: row.apiUrl,
        objectId: objectIdOf(row.apiUrl),
        capability: op.capability,
        ...(op.zone ? { zone: op.zone } : {}),
        requested: sendsBody ? body : op.value,
        observed: responseBody,
        status: res.status,
        ok: res.ok,
        ms,
        note: `row ${row.id} - ${row.stateName}${
          /\/v\d+\/ping$/.test(row.apiUrl) ? ' - health-check endpoint, controls nothing' : ''
        }`,
      });

      const message = `${row.serviceName} ${row.stateName} (row ${row.id}) → ${res.status} in ${ms}ms`;
      // The head-end accepted it. Whether the device moved is unknowable from this data,
      // so 'applied' would be a claim the adapter cannot support.
      if (res.ok) {
        // Remember only what the head-end accepted. A rejected write leaves the previous
        // belief in place rather than replacing it with something that never happened.
        const key = `${op.capability}${op.zone ? `/${op.zone}` : ''}`;
        let room_ = this.commanded.get(room.vendorRoomId);
        if (!room_) {
          room_ = new Map();
          this.commanded.set(room.vendorRoomId, room_);
        }
        room_.set(key, {
          capability: op.capability,
          ...(op.zone ? { zone: op.zone } : {}),
          value: op.value,
          at: Date.now(),
        });
      }
      return res.ok ? { status: 'pending', message } : { status: 'rejected', message };
    } catch (err) {
      recordVendorCall({
        vendor: `${this.vendor}/${row.serviceName}`,
        method,
        url: row.apiUrl,
        objectId: objectIdOf(row.apiUrl),
        capability: op.capability,
        ...(op.zone ? { zone: op.zone } : {}),
        requested: sendsBody ? body : op.value,
        status: 0,
        ok: false,
        ms: Date.now() - started,
        note: `row ${row.id} - ${(err as Error).message}`,
      });
      return {
        status: 'rejected',
        message: `${row.serviceName} ${row.stateName} (row ${row.id}) failed: ${
          (err as Error).message
        }`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Onboarding check. Not "does the light turn on" - nothing here can answer that - but
   * "is this room's catalogue complete enough to serve a guest".
   */
  conformanceSuite(): ConformanceTest[] {
    return [
      {
        name: 'every command maps to a capability',
        capability: '*',
        run: async (adapter, room) => {
          const mapping = await (adapter as MasterDbAdapter).mappingFor(room);
          return {
            pass: mapping.unmapped.length === 0,
            detail: mapping.unmapped.length
              ? `${mapping.unmapped.length} unmapped: ${mapping.unmapped
                  .map((u) => `${u.row.itemName}/${u.row.stateName}`)
                  .join(', ')}`
              : `${mapping.commands.length} commands mapped`,
          };
        },
      },
      {
        name: 'commands address a device rather than a health check',
        capability: '*',
        run: async (adapter, room) => {
          const mapping = await (adapter as MasterDbAdapter).mappingFor(room);
          const pings = mapping.commands.filter((c) => /\/v\d+\/ping$/.test(c.row.apiUrl ?? ''));
          return {
            pass: pings.length === 0,
            detail: pings.length
              ? `${pings.length} of ${mapping.commands.length} commands point at a ping endpoint and control nothing`
              : 'no ping-only commands',
          };
        },
      },
      {
        name: 'state can be read back',
        capability: '*',
        run: async (adapter, room) => {
          const states = await adapter.readRoomState(room);
          const readable = states.filter((s) => s.available);
          return {
            pass: readable.length > 0,
            detail: readable.length
              ? `${readable.length} readable capabilities`
              : 'the catalogue holds no read commands - writes stay pending and cannot be confirmed',
          };
        },
      },
    ];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** BACnet and IoT paths carry the point address; surfacing it is the §39.2 discipline. */
function objectIdOf(url: string): string | undefined {
  const object = /\/objects\/([^/]+)/.exec(url)?.[1];
  if (object) return object;
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean);
    return path[path.length - 1];
  } catch {
    return undefined;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export * from './mapping.js';
export * from './import.js';
