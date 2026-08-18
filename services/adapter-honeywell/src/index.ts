import {
  CapabilityId,
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
} from '@woohoo/contracts';
import { recordVendorCall } from '@woohoo/otel';

/**
 * Honeywell INNCOM adapter over HTTP — architecture doc §39.
 *
 * Talks to a head-end over the network rather than to an in-process fake. That distinction is
 * the point: connection handling, timeouts, partial failures and read-back are the code paths
 * an in-process stub never exercises, and they are where hotel deployments actually break.
 *
 * Vendor vocabulary stops at this file. Nothing above it knows what an object id is.
 */

/** INNCOM addresses points by object id; capabilities map onto point kinds. */
const KIND_FOR_CAPABILITY: Record<string, string> = {
  [CapabilityId.LightingOnOff]: 'light',
  [CapabilityId.LightingBrightness]: 'dimmer',
  [CapabilityId.ClimateSetpoint]: 'setpoint',
  [CapabilityId.ClimateMode]: 'mode',
  [CapabilityId.CurtainsPosition]: 'curtain',
  [CapabilityId.CurtainsOpenClose]: 'curtain',
  [CapabilityId.Dnd]: 'dnd',
  [CapabilityId.TvControl]: 'tv',
};

const CAPABILITY_FOR_KIND: Record<string, string> = {
  light: CapabilityId.LightingOnOff,
  dimmer: CapabilityId.LightingBrightness,
  setpoint: CapabilityId.ClimateSetpoint,
  mode: CapabilityId.ClimateMode,
  curtain: CapabilityId.CurtainsPosition,
  dnd: CapabilityId.Dnd,
  tv: CapabilityId.TvControl,
};

interface VendorPoint {
  objectId: string;
  kind: string;
  zone: string;
  value: number | string | boolean;
  binary?: boolean;
}

export class HeadEndUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadEndUnreachable';
  }
}

export interface HoneywellOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class HoneywellHttpAdapter implements AutomationAdapter {
  readonly vendor = 'honeywell-inncom';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** objectId lookup per room, refreshed on every read so drift cannot strand it. */
  private readonly points = new Map<string, Map<string, VendorPoint>>();
  private readonly seen = new Map<string, CapabilityResult>();
  private readonly subs = new Map<string, Array<(c: StateChange) => void>>();

  constructor(opts: HoneywellOptions = {}) {
    const base = opts.baseUrl ?? process.env.HONEYWELL_URL ?? 'http://localhost:8091';
    this.baseUrl = base.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.HONEYWELL_TIMEOUT_MS ?? 4000);
  }

  /**
   * Connect, tolerating a head-end that is still coming up.
   *
   * Property controllers boot slowly, and under compose this service frequently starts before
   * the one it depends on. Failing on the first probe turns a five-second startup skew into a
   * crash loop, so the first connection is retried briefly before giving up.
   */
  async connect(binding: PropertyBinding): Promise<ConnectionHandle> {
    let health = await this.health();
    for (let attempt = 1; attempt < 10 && !health.reachable; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      health = await this.health();
    }
    if (!health.reachable) {
      throw new HeadEndUnreachable(
        'head-end at ' + this.baseUrl + ' not reachable: ' + health.lastError,
      );
    }
    return {
      propertyId: binding.propertyId,
      connectedAt: Date.now(),
      close: async () => undefined,
    };
  }

  async health(): Promise<AdapterHealth> {
    const t0 = Date.now();
    try {
      const res = await this.fetchJson('GET', '/health');
      return { reachable: res.status === 200, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { reachable: false, latencyMs: Date.now() - t0, lastError: String(err) };
    }
  }

  async readRoomState(room: VendorRoomRef): Promise<CapabilityState[]> {
    const res = await this.fetchJson(
      'GET',
      '/api/v1/rooms/' + room.vendorRoomId + '/objects',
      undefined,
      { capability: 'read.state' },
    );

    if (res.status !== 200) {
      throw new HeadEndUnreachable('read failed (' + res.status + ') for ' + room.vendorRoomId);
    }

    const objects = (res.body as { objects?: VendorPoint[] }).objects ?? [];
    const byId = new Map<string, VendorPoint>();
    for (const p of objects) byId.set(p.objectId, p);
    this.points.set(room.vendorRoomId, byId);

    const out: CapabilityState[] = [];
    for (const p of objects) {
      const capability = CAPABILITY_FOR_KIND[p.kind];
      if (!capability) continue;
      out.push({
        capability,
        zone: p.zone === 'room' ? undefined : (p.zone as CapabilityState['zone']),
        value: p.value,
        available: true,
      });
    }
    return out;
  }

  async applyCapability(
    room: VendorRoomRef,
    op: CapabilityOperation,
    idempotencyKey: string,
  ): Promise<CapabilityResult> {
    // Replaying a key returns the original result rather than acting on the room twice (§34.3).
    const dedupeKey = room.propertyId + ':' + room.vendorRoomId + ':' + idempotencyKey;
    const prior = this.seen.get(dedupeKey);
    if (prior) return prior;

    const point = await this.resolvePoint(room, op);
    if (!point) {
      return {
        status: 'rejected',
        message: 'no object for ' + op.capability + ' in ' + (op.zone ?? 'bedroom'),
      };
    }

    // A binary curtain motor cannot hold an intermediate position. Degrading here, rather than
    // in the model's reasoning, is what keeps the capability abstraction honest (§33).
    let requested = op.value;
    let note: string | undefined;
    if (point.kind === 'curtain' && point.binary && typeof requested === 'number') {
      const snapped = requested >= 50 ? 100 : 0;
      if (snapped !== requested) note = 'binary motor: ' + requested + ' snapped to ' + snapped;
      requested = snapped;
    }

    const res = await this.fetchJson(
      'PUT',
      '/api/v1/rooms/' + room.vendorRoomId + '/objects/' + point.objectId,
      { value: requested },
      { capability: op.capability, zone: op.zone, objectId: point.objectId, requested, note },
    );

    if (res.status !== 200) {
      const body = res.body as { message?: string };
      return { status: 'rejected', message: body.message ?? 'head-end returned ' + res.status };
    }

    // The head-end reports the value it actually holds. A write that acknowledges but does not
    // take effect appears here as observed !== requested — precisely the trap the verify-read
    // in §37 exists to catch. Never report "applied" on the strength of a 200.
    const observedValue = (res.body as { value: number | string | boolean }).value;
    point.value = observedValue;

    const applied = String(observedValue) === String(requested);
    const result: CapabilityResult = {
      status: applied ? 'applied' : 'pending',
      observed: { capability: op.capability, zone: op.zone, value: observedValue, available: true },
      message: applied ? note : 'head-end acknowledged but still reports ' + String(observedValue),
    };

    this.seen.set(dedupeKey, result);
    for (const cb of this.subs.get(room.vendorRoomId) ?? []) {
      cb({ roomRef: room, state: result.observed!, at: Date.now() });
    }
    return result;
  }

  subscribe(room: VendorRoomRef, cb: (change: StateChange) => void): Unsubscribe {
    const list = this.subs.get(room.vendorRoomId) ?? [];
    list.push(cb);
    this.subs.set(room.vendorRoomId, list);
    return () => {
      const cur = this.subs.get(room.vendorRoomId) ?? [];
      this.subs.set(
        room.vendorRoomId,
        cur.filter((f) => f !== cb),
      );
    };
  }

  /**
   * Onboarding and nightly checks against a designated test room (§39.4).
   *
   * These assert what is OBSERVED, not what was acknowledged. A head-end that returns 200 and
   * changes nothing passes a naive check and fails these, which is the entire point: it is the
   * failure that otherwise reaches a guest as a confident, false confirmation.
   */
  conformanceSuite(): ConformanceTest[] {
    return [
      {
        name: 'HW-01 head-end reachable',
        capability: 'read.state',
        run: async (adapter) => {
          const h = await adapter.health();
          return {
            pass: h.reachable,
            detail: h.reachable ? 'reachable in ' + h.latencyMs + 'ms' : (h.lastError ?? 'unreachable'),
          };
        },
      },
      {
        name: 'HW-02 setpoint write is observed',
        capability: CapabilityId.ClimateSetpoint,
        run: async (adapter, room) => {
          const key = 'conformance-setpoint-' + Date.now();
          const res = await adapter.applyCapability(
            room,
            { capability: CapabilityId.ClimateSetpoint, zone: 'bedroom', value: 22 },
            key,
          );
          const observed = res.observed?.value;
          return {
            pass: res.status === 'applied' && Number(observed) === 22,
            detail: 'status=' + res.status + ' observed=' + String(observed),
          };
        },
      },
      {
        name: 'HW-03 light write is observed',
        capability: CapabilityId.LightingOnOff,
        run: async (adapter, room) => {
          const key = 'conformance-light-' + Date.now();
          const res = await adapter.applyCapability(
            room,
            { capability: CapabilityId.LightingOnOff, zone: 'bedroom', value: true },
            key,
          );
          return {
            pass: res.status === 'applied' && res.observed?.value === true,
            detail: 'status=' + res.status + ' observed=' + String(res.observed?.value),
          };
        },
      },
      {
        name: 'HW-04 room reference maps to the intended room',
        capability: 'read.state',
        run: async (adapter, room) => {
          // The classic onboarding failure is a vendor room id that resolves to someone
          // else's room. This cannot verify the mapping is CORRECT — only a human standing
          // in the room can — but it does prove the reference resolves at all.
          try {
            const states = await adapter.readRoomState(room);
            return {
              pass: states.length > 0,
              detail: room.vendorRoomId + ' resolved to ' + states.length + ' capabilities',
            };
          } catch (err) {
            return { pass: false, detail: String(err) };
          }
        },
      },
    ];
  }

  /** Find the object for a capability and zone, reading the room if the map is cold. */
  private async resolvePoint(
    room: VendorRoomRef,
    op: CapabilityOperation,
  ): Promise<VendorPoint | undefined> {
    if (!this.points.has(room.vendorRoomId)) await this.readRoomState(room);
    const byId = this.points.get(room.vendorRoomId);
    if (!byId) return undefined;

    const kind = KIND_FOR_CAPABILITY[op.capability];
    if (!kind) return undefined;
    const zone = op.zone ?? 'bedroom';

    for (const p of byId.values()) {
      if (p.kind !== kind) continue;
      // dnd and tv are room-wide rather than zoned.
      if (p.zone === 'room' || p.zone === zone) return p;
    }
    return undefined;
  }

  /** One HTTP call, recorded into the turn's vendor log whatever the outcome. */
  private async fetchJson(
    method: string,
    path: string,
    body?: unknown,
    meta: {
      capability?: string;
      zone?: string;
      objectId?: string;
      requested?: unknown;
      note?: string;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const url = this.baseUrl + path;
    const t0 = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const parsed = await res.json().catch(() => ({}));

      recordVendorCall({
        vendor: this.vendor,
        method,
        url,
        objectId: meta.objectId,
        capability: meta.capability,
        zone: meta.zone,
        requested: meta.requested,
        observed: (parsed as { value?: unknown }).value,
        status: res.status,
        ok: res.ok,
        ms: Date.now() - t0,
        note: meta.note,
      });

      return { status: res.status, body: parsed };
    } catch (err) {
      recordVendorCall({
        vendor: this.vendor,
        method,
        url,
        objectId: meta.objectId,
        capability: meta.capability,
        zone: meta.zone,
        requested: meta.requested,
        status: 0,
        ok: false,
        ms: Date.now() - t0,
        note: String(err),
      });
      throw new HeadEndUnreachable(method + ' ' + url + ' failed: ' + String(err));
    }
  }
}
