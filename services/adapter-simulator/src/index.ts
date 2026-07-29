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
  type Zone,
} from '@woohoo/contracts';

/**
 * High-fidelity BMS simulator — architecture doc §39.2 and the §74 note on building this
 * before the second real adapter.
 *
 * Access to real hotel hardware is the biggest velocity constraint on this project, and you
 * cannot ask a hotel to unplug its head-end to test the degradation ladder. So this models the
 * behaviours that actually bite: variable write latency, intermittent unreachability, slow
 * acknowledgements, capability-level degradation, and state that drifts because a housekeeper
 * touched a wall switch.
 */

export interface SimulatorOptions {
  /** Base write latency in ms; each call jitters ±40%. */
  latencyMs?: number;
  /** Probability [0,1] that any single call fails as unreachable. */
  failureRate?: number;
  /** Probability that a write acknowledges but does not take effect — the nastiest real bug. */
  silentFailureRate?: number;
  /** Probability per read that state has drifted since we last wrote it. */
  driftRate?: number;
  /** Rooms whose curtains are binary only, to exercise capability degradation. */
  binaryCurtainRooms?: string[];
  /** Deterministic seed so eval runs are reproducible. */
  seed?: number;
}

interface RoomState {
  lighting: Map<Zone, { on: boolean; brightness: number }>;
  climate: Map<Zone, { currentC: number; setpointC: number; mode: string }>;
  curtains: Map<Zone, { position: number }>;
  dnd: string;
  tv: { power: string; volume: number; input: string };
  media: { playing: boolean; track?: string };
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES: Zone[] = ['bedroom', 'living', 'bathroom', 'entrance'];

export class SimulatorAdapter implements AutomationAdapter {
  readonly vendor = 'simulator';

  private readonly rooms = new Map<string, RoomState>();
  private readonly subs = new Map<string, Array<(c: StateChange) => void>>();
  private readonly seen = new Map<string, CapabilityResult>();
  private readonly rand: () => number;
  private connected = false;

  constructor(private readonly opts: SimulatorOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 0x5eed);
  }

  async connect(binding: PropertyBinding): Promise<ConnectionHandle> {
    this.connected = true;
    return {
      propertyId: binding.propertyId,
      connectedAt: Date.now(),
      close: async () => void (this.connected = false),
    };
  }

  async health(): Promise<AdapterHealth> {
    const latency = this.nextLatency();
    return this.connected
      ? { reachable: true, latencyMs: latency }
      : { reachable: false, latencyMs: 0, lastError: 'not connected' };
  }

  async readRoomState(room: VendorRoomRef): Promise<CapabilityState[]> {
    await this.delay();
    this.maybeFail(room);
    const s = this.roomOf(room);
    this.maybeDrift(room, s);

    const out: CapabilityState[] = [];
    for (const [zone, l] of s.lighting) {
      out.push({ capability: CapabilityId.LightingOnOff, zone, value: l.on, available: true });
      out.push({
        capability: CapabilityId.LightingBrightness,
        zone,
        value: l.brightness,
        available: true,
      });
    }
    for (const [zone, c] of s.climate) {
      out.push({ capability: CapabilityId.ClimateSetpoint, zone, value: c.setpointC, available: true });
      out.push({ capability: CapabilityId.ClimateMode, zone, value: c.mode, available: true });
      out.push({ capability: 'climate.current', zone, value: c.currentC, available: true });
    }
    for (const [zone, c] of s.curtains) {
      out.push({ capability: CapabilityId.CurtainsPosition, zone, value: c.position, available: true });
    }
    out.push({ capability: CapabilityId.Dnd, value: s.dnd, available: true });
    out.push({ capability: CapabilityId.TvControl, value: s.tv.power, available: true });
    return out;
  }

  subscribe(room: VendorRoomRef, cb: (c: StateChange) => void): Unsubscribe {
    const k = this.key(room);
    if (!this.subs.has(k)) this.subs.set(k, []);
    this.subs.get(k)!.push(cb);
    return () => {
      const list = this.subs.get(k) ?? [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async applyCapability(
    room: VendorRoomRef,
    op: CapabilityOperation,
    idempotencyKey: string,
  ): Promise<CapabilityResult> {
    // Idempotency: replaying a key returns the original result rather than acting twice (§34.3).
    const dedupeKey = `${this.key(room)}:${idempotencyKey}`;
    const prior = this.seen.get(dedupeKey);
    if (prior) return prior;

    await this.delay();
    this.maybeFail(room);

    const s = this.roomOf(room);
    const zone = (op.zone ?? 'bedroom') as Zone;
    // A write that acknowledges but does not take effect. The verify-read in §37 is what
    // catches this — which is exactly why "done" must mean "observed done".
    const silent = this.rand() < (this.opts.silentFailureRate ?? 0);

    let observed: CapabilityState;
    switch (op.capability) {
      case CapabilityId.LightingOnOff: {
        const l = this.lightOf(s, zone);
        if (!silent) l.on = Boolean(op.value);
        observed = { capability: op.capability, zone, value: l.on, available: true };
        break;
      }
      case CapabilityId.LightingBrightness: {
        const l = this.lightOf(s, zone);
        if (!silent) {
          l.brightness = clamp(Number(op.value), 0, 100);
          l.on = l.brightness > 0;
        }
        observed = { capability: op.capability, zone, value: l.brightness, available: true };
        break;
      }
      case CapabilityId.ClimateSetpoint: {
        const c = this.climateOf(s, zone);
        if (!silent) c.setpointC = Number(op.value);
        observed = { capability: op.capability, zone, value: c.setpointC, available: true };
        break;
      }
      case CapabilityId.ClimateMode: {
        const c = this.climateOf(s, zone);
        if (!silent) c.mode = String(op.value);
        observed = { capability: op.capability, zone, value: c.mode, available: true };
        break;
      }
      case CapabilityId.CurtainsPosition: {
        const c = this.curtainOf(s, zone);
        const requested = clamp(Number(op.value), 0, 100);
        // Capability degradation: a binary motor snaps to fully open or fully closed. The model
        // asked for a position and gets a truthful observed value back — it never learns why.
        const binary = (this.opts.binaryCurtainRooms ?? []).includes(room.vendorRoomId);
        if (!silent) c.position = binary ? (requested >= 50 ? 100 : 0) : requested;
        observed = { capability: op.capability, zone, value: c.position, available: true };
        break;
      }
      case CapabilityId.Dnd: {
        if (!silent) s.dnd = String(op.value);
        observed = { capability: op.capability, value: s.dnd, available: true };
        break;
      }
      case CapabilityId.TvControl: {
        if (!silent) s.tv.power = String(op.value);
        observed = { capability: op.capability, value: s.tv.power, available: true };
        break;
      }
      case CapabilityId.MediaPlayback: {
        if (!silent) s.media.playing = op.value === 'play';
        observed = { capability: op.capability, value: s.media.playing, available: true };
        break;
      }
      case CapabilityId.LightingScene: {
        if (!silent) this.applyScene(s, String(op.value));
        observed = { capability: op.capability, zone, value: String(op.value), available: true };
        break;
      }
      default:
        return { status: 'rejected', message: `Unsupported capability ${op.capability}` };
    }

    const result: CapabilityResult = { status: 'applied', observed };
    this.seen.set(dedupeKey, result);
    this.emit(room, observed);
    return result;
  }

  conformanceSuite(): ConformanceTest[] {
    const check = (name: string, capability: string, value: number | string | boolean, zone?: Zone) => ({
      name,
      capability,
      async run(adapter: AutomationAdapter, room: VendorRoomRef) {
        const r = await adapter.applyCapability(room, { capability, zone, value }, `conf_${name}_${Date.now()}`);
        return r.status === 'applied'
          ? { pass: true, detail: `${capability} applied, observed ${String(r.observed?.value)}` }
          : { pass: false, detail: r.message ?? `${capability} returned ${r.status}` };
      },
    });
    return [
      check('lights on', CapabilityId.LightingOnOff, true, 'bedroom'),
      check('lights dim to 40', CapabilityId.LightingBrightness, 40, 'bedroom'),
      check('setpoint 23', CapabilityId.ClimateSetpoint, 23, 'bedroom'),
      check('mode cool', CapabilityId.ClimateMode, 'cool', 'bedroom'),
      check('curtains closed', CapabilityId.CurtainsPosition, 0, 'bedroom'),
      check('dnd on', CapabilityId.Dnd, 'dnd'),
    ];
  }

  /** Test hook: force state to drift as if a guest used a wall switch. */
  forceDrift(room: VendorRoomRef, zone: Zone, on: boolean): void {
    const s = this.roomOf(room);
    this.lightOf(s, zone).on = on;
  }

  private applyScene(s: RoomState, scene: string): void {
    const set = (zone: Zone, on: boolean, brightness: number) => {
      const l = this.lightOf(s, zone);
      l.on = on;
      l.brightness = brightness;
    };
    switch (scene) {
      case 'sleep':
        for (const z of ZONES) set(z, false, 0);
        s.dnd = 'dnd';
        break;
      case 'movie':
        set('living', true, 15);
        set('bedroom', false, 0);
        break;
      case 'work':
        set('living', true, 90);
        break;
      default:
        set('bedroom', true, 70);
        set('living', true, 70);
    }
  }

  private emit(room: VendorRoomRef, state: CapabilityState): void {
    for (const cb of this.subs.get(this.key(room)) ?? []) {
      cb({ roomRef: room, state, at: Date.now() });
    }
  }

  private maybeDrift(room: VendorRoomRef, s: RoomState): void {
    if (this.rand() >= (this.opts.driftRate ?? 0)) return;
    const zone = ZONES[Math.floor(this.rand() * ZONES.length)] ?? 'bedroom';
    const l = s.lighting.get(zone);
    if (l) {
      l.on = !l.on;
      this.emit(room, { capability: CapabilityId.LightingOnOff, zone, value: l.on, available: true });
    }
  }

  private maybeFail(room: VendorRoomRef): void {
    if (!this.connected) {
      throw new AdapterUnreachable(`Simulator not connected for ${room.propertyId}`);
    }
    if (this.rand() < (this.opts.failureRate ?? 0)) {
      throw new AdapterUnreachable(`Head-end timed out for room ${room.vendorRoomId}`);
    }
  }

  private nextLatency(): number {
    const base = this.opts.latencyMs ?? 120;
    return Math.round(base * (0.6 + this.rand() * 0.8));
  }

  private async delay(): Promise<void> {
    const ms = this.nextLatency();
    if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  }

  private key(room: VendorRoomRef): string {
    return `${room.propertyId}/${room.vendorRoomId}`;
  }

  private roomOf(room: VendorRoomRef): RoomState {
    const k = this.key(room);
    let s = this.rooms.get(k);
    if (!s) {
      s = {
        lighting: new Map(ZONES.map((z) => [z, { on: false, brightness: 0 }])),
        climate: new Map([
          ['bedroom' as Zone, { currentC: 24.5, setpointC: 19.5, mode: 'auto' }],
          ['living' as Zone, { currentC: 24.0, setpointC: 22.0, mode: 'auto' }],
        ]),
        curtains: new Map([
          ['bedroom' as Zone, { position: 100 }],
          ['living' as Zone, { position: 100 }],
        ]),
        dnd: 'off',
        tv: { power: 'off', volume: 20, input: 'hdmi1' },
        media: { playing: false },
      };
      this.rooms.set(k, s);
    }
    return s;
  }

  private lightOf(s: RoomState, zone: Zone) {
    let l = s.lighting.get(zone);
    if (!l) {
      l = { on: false, brightness: 0 };
      s.lighting.set(zone, l);
    }
    return l;
  }

  private climateOf(s: RoomState, zone: Zone) {
    let c = s.climate.get(zone);
    if (!c) {
      c = { currentC: 24, setpointC: 22, mode: 'auto' };
      s.climate.set(zone, c);
    }
    return c;
  }

  private curtainOf(s: RoomState, zone: Zone) {
    let c = s.curtains.get(zone);
    if (!c) {
      c = { position: 100 };
      s.curtains.set(zone, c);
    }
    return c;
  }
}

export class AdapterUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnreachable';
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}
