import {
  CapabilityId,
  ToolErrorCode,
  toolError,
  type AutomationAdapter,
  type CapabilityOperation,
  type CapabilityState,
  type Freshness,
  type ToolError,
  type VendorRoomRef,
  type Zone,
} from '@woohoo/contracts';

/**
 * Device state — architecture doc §37, "cache, twin and truth".
 *
 * The BMS is the source of truth, but reading it on every turn is too slow and too fragile.
 * This holds the shadow, enforces the freshness contract, and performs the verify-read that
 * makes the difference between "done" and "I've asked for that".
 */

const FRESH_MS = 10_000;
const STALE_MS = 120_000;

export interface RoomStateSnapshot {
  zones: Array<{
    zone: Zone;
    lighting?: { on: boolean; brightness: number; available: boolean };
    climate?: {
      currentC?: number;
      setpointC: number;
      mode: string;
      minC: number;
      maxC: number;
      available: boolean;
    };
    curtains?: { position: number; supportsPosition: boolean; available: boolean };
  }>;
  dnd: string;
  freshness: Freshness;
  asOf: string;
}

interface ShadowEntry {
  states: CapabilityState[];
  at: number;
}

/**
 * Circuit breaker per (property, vendor) — §69, the single most important resilience control.
 * One hotel's hung head-end must never consume the adapter's capacity for every other property.
 */
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly windowMs = 30_000,
    private readonly cooldownMs = 60_000,
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === 0) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.openedAt = 0;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(now = Date.now()): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = now;
    setTimeout(() => void (this.failures = Math.max(0, this.failures - 1)), this.windowMs).unref?.();
  }
}

export interface ApplyOutcome {
  status: 'applied' | 'pending' | 'failed';
  observed?: CapabilityState;
  error?: ToolError;
}

export class DeviceStateService {
  private readonly shadow = new Map<string, ShadowEntry>();
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly adapter: AutomationAdapter) {}

  private key(room: VendorRoomRef): string {
    return `${room.propertyId}/${room.vendorRoomId}`;
  }

  private breaker(room: VendorRoomRef): CircuitBreaker {
    const k = `${room.propertyId}/${this.adapter.vendor}`;
    let b = this.breakers.get(k);
    if (!b) {
      b = new CircuitBreaker();
      this.breakers.set(k, b);
    }
    return b;
  }

  freshnessOf(room: VendorRoomRef, now = Date.now()): Freshness {
    const e = this.shadow.get(this.key(room));
    if (!e) return 'unknown';
    const age = now - e.at;
    if (age < FRESH_MS) return 'fresh';
    if (age < STALE_MS) return 'stale';
    return 'unknown';
  }

  /**
   * Read room state, honouring the §37 freshness contract:
   *   fresh (<10s)   → serve from shadow
   *   stale (10–120s) → serve from shadow, but any subsequent write gets a verify-read
   *   expired        → force a synchronous read; if that fails the caller is told UNKNOWN
   *                    rather than being handed a confident lie
   */
  async readState(
    room: VendorRoomRef,
    opts: { minC: number; maxC: number; supportsCurtainPosition: boolean },
    now = Date.now(),
  ): Promise<RoomStateSnapshot> {
    const freshness = this.freshnessOf(room, now);
    let entry = this.shadow.get(this.key(room));

    if (freshness === 'unknown' || !entry) {
      if (this.breaker(room).isOpen) {
        return this.snapshotFrom(entry?.states ?? [], 'unknown', opts, now);
      }
      try {
        const states = await this.adapter.readRoomState(room);
        entry = { states, at: now };
        this.shadow.set(this.key(room), entry);
        this.breaker(room).recordSuccess();
        return this.snapshotFrom(states, 'fresh', opts, now);
      } catch {
        this.breaker(room).recordFailure(now);
        return this.snapshotFrom(entry?.states ?? [], 'unknown', opts, now);
      }
    }

    return this.snapshotFrom(entry.states, freshness, opts, now);
  }

  /**
   * Apply an operation and verify it. "I set it" must mean "I observed it set" — an
   * unverified write is reported as pending, never as done (§37).
   */
  async apply(
    room: VendorRoomRef,
    op: CapabilityOperation,
    idempotencyKey: string,
    opts: { verifyRead: boolean; timeoutMs: number } = { verifyRead: true, timeoutMs: 2500 },
    now = Date.now(),
  ): Promise<ApplyOutcome> {
    const breaker = this.breaker(room);
    if (breaker.isOpen) {
      return {
        status: 'failed',
        error: toolError(
          ToolErrorCode.TemporarilyUnreachable,
          'The room automation system is not responding right now.',
          'Tell the guest you cannot reach the room systems and offer to connect them to the front desk.',
          true,
        ),
      };
    }

    try {
      const result = await withTimeout(
        this.adapter.applyCapability(room, op, idempotencyKey),
        opts.timeoutMs,
      );
      breaker.recordSuccess();

      if (result.status === 'rejected') {
        return {
          status: 'failed',
          error: toolError(
            ToolErrorCode.NotAvailable,
            result.message ?? 'The room system rejected that.',
            'Tell the guest this is not available in their room.',
          ),
        };
      }

      // Verify-read: re-read the shadow so a silent failure (acknowledged but not applied)
      // downgrades the outcome to pending instead of producing a confident false confirmation.
      if (opts.verifyRead) {
        try {
          const states = await this.adapter.readRoomState(room);
          this.shadow.set(this.key(room), { states, at: now });
          const observed = states.find(
            (s) => s.capability === op.capability && (op.zone === undefined || s.zone === op.zone),
          );
          if (observed && String(observed.value) === String(result.observed?.value)) {
            return { status: 'applied', observed };
          }
          return { status: 'pending', observed: observed ?? result.observed };
        } catch {
          return { status: 'pending', observed: result.observed };
        }
      }

      this.invalidate(room);
      return { status: result.status === 'applied' ? 'applied' : 'pending', observed: result.observed };
    } catch (err) {
      breaker.recordFailure(now);
      const timedOut = err instanceof TimeoutError;
      return {
        status: timedOut ? 'pending' : 'failed',
        error: toolError(
          ToolErrorCode.TemporarilyUnreachable,
          timedOut
            ? 'The room system did not confirm in time.'
            : 'The room automation system is unreachable.',
          timedOut
            ? 'Say you have asked for the change and it may take a moment. Do NOT say it is done.'
            : 'Tell the guest you cannot reach the room systems and offer the front desk.',
          true,
        ),
      };
    }
  }

  invalidate(room: VendorRoomRef): void {
    this.shadow.delete(this.key(room));
  }

  /** Push-driven update from the edge gateway's subscription. */
  ingest(room: VendorRoomRef, state: CapabilityState, now = Date.now()): void {
    const k = this.key(room);
    const entry = this.shadow.get(k) ?? { states: [], at: now };
    const i = entry.states.findIndex(
      (s) => s.capability === state.capability && s.zone === state.zone,
    );
    if (i >= 0) entry.states[i] = state;
    else entry.states.push(state);
    entry.at = now;
    this.shadow.set(k, entry);
  }

  private snapshotFrom(
    states: CapabilityState[],
    freshness: Freshness,
    opts: { minC: number; maxC: number; supportsCurtainPosition: boolean },
    now: number,
  ): RoomStateSnapshot {
    const byZone = new Map<Zone, RoomStateSnapshot['zones'][number]>();
    const zoneOf = (z: Zone) => {
      let e = byZone.get(z);
      if (!e) {
        e = { zone: z };
        byZone.set(z, e);
      }
      return e;
    };

    let dnd = 'off';
    for (const s of states) {
      const z = (s.zone ?? 'bedroom') as Zone;
      switch (s.capability) {
        case CapabilityId.LightingOnOff: {
          const e = zoneOf(z);
          e.lighting = { on: Boolean(s.value), brightness: e.lighting?.brightness ?? 0, available: s.available };
          break;
        }
        case CapabilityId.LightingBrightness: {
          const e = zoneOf(z);
          e.lighting = { on: e.lighting?.on ?? Number(s.value) > 0, brightness: Number(s.value), available: s.available };
          break;
        }
        case CapabilityId.ClimateSetpoint: {
          const e = zoneOf(z);
          e.climate = {
            ...(e.climate ?? { mode: 'auto', available: true }),
            setpointC: Number(s.value),
            minC: opts.minC,
            maxC: opts.maxC,
            available: s.available,
            mode: e.climate?.mode ?? 'auto',
          };
          break;
        }
        case 'climate.current': {
          const e = zoneOf(z);
          if (e.climate) e.climate.currentC = Number(s.value);
          break;
        }
        case CapabilityId.ClimateMode: {
          const e = zoneOf(z);
          if (e.climate) e.climate.mode = String(s.value);
          break;
        }
        case CapabilityId.CurtainsPosition: {
          zoneOf(z).curtains = {
            position: Number(s.value),
            supportsPosition: opts.supportsCurtainPosition,
            available: s.available,
          };
          break;
        }
        case CapabilityId.Dnd:
          dnd = String(s.value);
          break;
      }
    }

    return {
      zones: [...byZone.values()],
      dnd,
      freshness,
      asOf: new Date(now).toISOString(),
    };
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
