import type { CapabilityOperation, CapabilityResult, CapabilityState } from './capabilities.js';

/**
 * The automation adapter contract — architecture doc §39.1.
 *
 * Capability in, capability out. The vendor vocabulary never escapes the implementation:
 * nothing above this interface may mention INNCOM, Interel, BACnet objects or KNX group
 * addresses. That is what makes principle P4 enforceable and what lets a new property be
 * configuration rather than code.
 */

/** The vendor's own room identifier, which is NOT the hotel room number (§39.2). */
export interface VendorRoomRef {
  vendorRoomId: string;
  propertyId: string;
}

export interface PropertyBinding {
  propertyId: string;
  vendor: string;
  /** Reference into the secret store; never the credential itself. */
  secretRef?: string;
}

export interface ConnectionHandle {
  propertyId: string;
  connectedAt: number;
  close(): Promise<void>;
}

export interface AdapterHealth {
  reachable: boolean;
  latencyMs: number;
  lastError?: string;
}

export interface StateChange {
  roomRef: VendorRoomRef;
  state: CapabilityState;
  at: number;
}

export type Unsubscribe = () => void;

export interface ConformanceTest {
  name: string;
  capability: string;
  run(adapter: AutomationAdapter, room: VendorRoomRef): Promise<{ pass: boolean; detail: string }>;
}

export interface AutomationAdapter {
  readonly vendor: string;

  connect(binding: PropertyBinding): Promise<ConnectionHandle>;
  health(): Promise<AdapterHealth>;

  readRoomState(room: VendorRoomRef): Promise<CapabilityState[]>;
  subscribe(room: VendorRoomRef, cb: (change: StateChange) => void): Unsubscribe;

  /**
   * Apply one vendor-neutral operation. Implementations degrade gracefully between capability
   * levels — a position request against a binary curtain motor becomes open or close here, not
   * in the model's reasoning.
   */
  applyCapability(
    room: VendorRoomRef,
    op: CapabilityOperation,
    idempotencyKey: string,
  ): Promise<CapabilityResult>;

  /** Run at onboarding and nightly against a designated test room. */
  conformanceSuite(): ConformanceTest[];
}
