import { z } from 'zod';

/**
 * The capability model — architecture doc §33.
 *
 * A capability is an abstract, vendor-neutral ability with a typed contract. The agent
 * reasons about "a thermostat in the bedroom zone with a setpoint range"; it never learns
 * that the property runs INNCOM or Interel. Every vendor-specific fact lives in an adapter
 * and in the per-property manifest below.
 */
export const CapabilityId = {
  LightingOnOff: 'lighting.on_off',
  LightingBrightness: 'lighting.brightness',
  LightingScene: 'lighting.scene',
  ClimateSetpoint: 'climate.setpoint',
  ClimateMode: 'climate.mode',
  /** Continuous 0–100 position. */
  CurtainsPosition: 'curtains.position',
  /** Binary only — the adapter degrades position requests onto this (§33). */
  CurtainsOpenClose: 'curtains.open_close',
  Dnd: 'dnd',
  TvControl: 'tv.power_volume_input',
  MediaPlayback: 'media.playback',
} as const;
export type CapabilityId = (typeof CapabilityId)[keyof typeof CapabilityId];

export const ZoneSchema = z.enum(['bedroom', 'living', 'bathroom', 'entrance']);
export type Zone = z.infer<typeof ZoneSchema>;

export const CapabilityGrantSchema = z.object({
  capability: z.string(),
  zones: z.array(ZoneSchema).optional(),
  /** Property-policy bounds, surfaced to the model so it proposes a valid value first time. */
  minC: z.number().optional(),
  maxC: z.number().optional(),
});
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const CapabilityManifestSchema = z.object({
  version: z.string(),
  zones: z.array(ZoneSchema),
  capabilities: z.array(CapabilityGrantSchema),
  scenes: z.array(z.string()).default([]),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/** Does this room have the capability at all? Absence means no tool is generated for it. */
export function hasCapability(m: CapabilityManifest, cap: string): boolean {
  return m.capabilities.some((c) => c.capability === cap);
}

export function grantFor(m: CapabilityManifest, cap: string): CapabilityGrant | undefined {
  return m.capabilities.find((c) => c.capability === cap);
}

/** Zones this capability applies to in this room, for enum generation in the tool schema. */
export function zonesFor(m: CapabilityManifest, cap: string): Zone[] {
  const g = grantFor(m, cap);
  if (!g) return [];
  return g.zones && g.zones.length ? g.zones : m.zones;
}

/**
 * Applying a manifest's per-room overrides. An override can only ever REMOVE a capability
 * (e.g. "motor awaiting replacement"), never add one — adding would let a config edit widen
 * what the agent can do without a manifest version bump.
 */
export function applyOverrides(m: CapabilityManifest, disable: string[]): CapabilityManifest {
  if (!disable.length) return m;
  return {
    ...m,
    capabilities: m.capabilities.filter((c) => !disable.includes(c.capability)),
  };
}

/** A single vendor-neutral operation handed to an automation adapter. */
export interface CapabilityOperation {
  capability: string;
  zone?: Zone;
  value: number | string | boolean;
}

export interface CapabilityState {
  capability: string;
  zone?: Zone;
  value: number | string | boolean;
  available: boolean;
}

export interface CapabilityResult {
  status: 'applied' | 'pending' | 'rejected';
  observed?: CapabilityState;
  message?: string;
}
