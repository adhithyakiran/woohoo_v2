import {
  CapabilityId,
  type AutomationAdapter,
  type CapabilityOperation,
  type CapabilityState,
  type VendorRoomRef,
} from '@woohoo/contracts';

/**
 * Edge Gateway — architecture doc §40.
 *
 * Runs on an appliance inside the property. It exists because INNCOM and Interel head-ends are
 * LAN-resident behind the hotel firewall, hotel IT will not open inbound ports, and when the
 * property WAN drops — which is routine — the guest must still be able to turn on the lights.
 *
 * Everything here is OUTBOUND-ONLY by construction: there is no listening socket, no inbound
 * route, and the tunnel is initiated from inside the building (§9, X3).
 */

export type LinkState = 'connected' | 'reconnecting' | 'offline';

export interface EdgeOptions {
  propertyId: string;
  adapter: AutomationAdapter;
  /** Called to push state deltas upstream. Failure implies the WAN is down. */
  publish?: (event: OutboxEntry) => Promise<void>;
  /** Base reconnect delay; jitter is applied on top (§19 — a property-wide blip must not
   *  become a synchronised reconnect storm from 300 devices). */
  reconnectBaseMs?: number;
  maxOutbox?: number;
}

export interface OutboxEntry {
  id: string;
  kind: 'state_change' | 'service_request' | 'health';
  payload: unknown;
  queuedAt: number;
  attempts: number;
}

/**
 * Local fallback rules — the Level 4 rung of the degradation ladder (§68).
 * A tiny fixed vocabulary that maps directly onto capability operations, with no cloud, no
 * model and no network beyond the property LAN.
 */
export const FALLBACK_GRAMMAR: Array<{ test: RegExp; op: (zone: string) => CapabilityOperation }> = [
  { test: /lights? on|turn on the lights?/i, op: (zone) => ({ capability: CapabilityId.LightingOnOff, zone: zone as never, value: true }) },
  { test: /lights? off|turn off the lights?/i, op: (zone) => ({ capability: CapabilityId.LightingOnOff, zone: zone as never, value: false }) },
  { test: /warmer|heat up|too cold/i, op: (zone) => ({ capability: CapabilityId.ClimateSetpoint, zone: zone as never, value: 24 }) },
  { test: /cooler|colder|too hot|too warm/i, op: (zone) => ({ capability: CapabilityId.ClimateSetpoint, zone: zone as never, value: 21 }) },
  { test: /do not disturb|dnd/i, op: () => ({ capability: CapabilityId.Dnd, value: 'dnd' }) },
  { test: /make up (my |the )?room/i, op: () => ({ capability: CapabilityId.Dnd, value: 'make_up_room' }) },
  { test: /close the curtains?/i, op: (zone) => ({ capability: CapabilityId.CurtainsPosition, zone: zone as never, value: 0 }) },
  { test: /open the curtains?/i, op: (zone) => ({ capability: CapabilityId.CurtainsPosition, zone: zone as never, value: 100 }) },
];

export class EdgeGateway {
  private link: LinkState = 'offline';
  private readonly shadow = new Map<string, { states: CapabilityState[]; at: number }>();
  private readonly outbox: OutboxEntry[] = [];
  private reconnectAttempt = 0;
  private seq = 0;

  constructor(private readonly opts: EdgeOptions) {}

  get linkState(): LinkState {
    return this.link;
  }

  get outboxDepth(): number {
    return this.outbox.length;
  }

  async connect(): Promise<void> {
    await this.opts.adapter.connect({ propertyId: this.opts.propertyId, vendor: this.opts.adapter.vendor });
    this.link = 'connected';
    this.reconnectAttempt = 0;
  }

  /** Exponential backoff with FULL jitter — mandatory, not decorative (§19). */
  nextReconnectDelayMs(): number {
    const base = this.opts.reconnectBaseMs ?? 1000;
    const capped = Math.min(base * 2 ** this.reconnectAttempt, 60_000);
    this.reconnectAttempt++;
    return Math.floor(Math.random() * capped);
  }

  markOffline(): void {
    this.link = 'offline';
  }

  markConnected(): void {
    this.link = 'connected';
    this.reconnectAttempt = 0;
  }

  /** Refresh and cache room state locally so a cloud outage does not blind the property. */
  async refreshRoom(room: VendorRoomRef): Promise<CapabilityState[]> {
    const states = await this.opts.adapter.readRoomState(room);
    this.shadow.set(this.key(room), { states, at: Date.now() });
    return states;
  }

  localState(room: VendorRoomRef): CapabilityState[] | undefined {
    return this.shadow.get(this.key(room))?.states;
  }

  /**
   * Offline path: the device's on-board grammar reaches the edge over the LAN and actuates
   * directly. Anything outside the grammar gets an honest refusal rather than silence (§29 L4).
   */
  async handleOffline(
    room: VendorRoomRef,
    utterance: string,
    zone = 'bedroom',
  ): Promise<{ handled: boolean; speech: string }> {
    const rule = FALLBACK_GRAMMAR.find((r) => r.test.test(utterance));
    if (!rule) {
      return {
        handled: false,
        speech:
          "I'm offline right now — I can still do lights, temperature and do not disturb. " +
          'For anything else please use the room phone.',
      };
    }
    try {
      const op = rule.op(zone);
      const result = await this.opts.adapter.applyCapability(room, op, `offline_${this.seq++}`);
      if (result.observed) this.ingest(room, result.observed);
      // Queue for replay so the cloud sees what happened while it was unreachable.
      this.enqueue({ kind: 'state_change', payload: { room, op, result } });
      return { handled: true, speech: 'Done.' };
    } catch {
      return {
        handled: false,
        speech: "I can't reach the room systems right now. Please use the room phone.",
      };
    }
  }

  ingest(room: VendorRoomRef, state: CapabilityState): void {
    const k = this.key(room);
    const entry = this.shadow.get(k) ?? { states: [], at: Date.now() };
    const i = entry.states.findIndex((s) => s.capability === state.capability && s.zone === state.zone);
    if (i >= 0) entry.states[i] = state;
    else entry.states.push(state);
    entry.at = Date.now();
    this.shadow.set(k, entry);
  }

  /** Store-and-forward. Bounded, because an appliance with 8GB of RAM must not OOM in an outage. */
  enqueue(e: Omit<OutboxEntry, 'id' | 'queuedAt' | 'attempts'>): void {
    const max = this.opts.maxOutbox ?? 5000;
    if (this.outbox.length >= max) this.outbox.shift();
    this.outbox.push({
      ...e,
      id: `ob_${Date.now().toString(36)}_${this.seq++}`,
      queuedAt: Date.now(),
      attempts: 0,
    });
  }

  /** Drain on reconnect. Entries that keep failing stay queued rather than being dropped. */
  async flush(): Promise<{ sent: number; remaining: number }> {
    if (this.link !== 'connected' || !this.opts.publish) {
      return { sent: 0, remaining: this.outbox.length };
    }
    let sent = 0;
    while (this.outbox.length) {
      const entry = this.outbox[0]!;
      try {
        await this.opts.publish(entry);
        this.outbox.shift();
        sent++;
      } catch {
        entry.attempts++;
        break;
      }
    }
    return { sent, remaining: this.outbox.length };
  }

  private key(room: VendorRoomRef): string {
    return `${room.propertyId}/${room.vendorRoomId}`;
  }
}
