import type { CapabilityManifest, PropertyPolicy, TurnContext } from '@woohoo/contracts';
import type { PolicyInputs } from './types.js';

/** Shared test/seed fixtures so the PDP suite and the eval harness describe the same property. */

export const SUITE_MANIFEST: CapabilityManifest = {
  version: '3',
  zones: ['bedroom', 'living', 'bathroom'],
  capabilities: [
    { capability: 'lighting.on_off', zones: ['bedroom', 'living', 'bathroom'] },
    { capability: 'lighting.brightness', zones: ['bedroom', 'living'] },
    { capability: 'lighting.scene', zones: ['living'] },
    { capability: 'climate.setpoint', zones: ['bedroom', 'living'], minC: 18, maxC: 26 },
    { capability: 'climate.mode', zones: ['bedroom', 'living'] },
    { capability: 'curtains.position', zones: ['bedroom', 'living'] },
    { capability: 'dnd' },
    { capability: 'tv.power_volume_input' },
    { capability: 'media.playback' },
  ],
  scenes: ['sleep', 'welcome', 'work', 'movie'],
};

/** A budget room type: no curtains, no scenes — used to prove capability filtering works. */
export const DELUXE_MANIFEST: CapabilityManifest = {
  version: '3',
  zones: ['bedroom', 'bathroom'],
  capabilities: [
    { capability: 'lighting.on_off', zones: ['bedroom', 'bathroom'] },
    { capability: 'lighting.brightness', zones: ['bedroom'] },
    { capability: 'climate.setpoint', zones: ['bedroom'], minC: 18, maxC: 26 },
    { capability: 'climate.mode', zones: ['bedroom'] },
    { capability: 'dnd' },
    { capability: 'tv.power_volume_input' },
  ],
  scenes: ['sleep', 'welcome', 'work'],
};

export const DEFAULT_POLICY: PropertyPolicy = {
  climate: { minC: 18, maxC: 26, maxChangesPerHour: 6 },
  quietHours: {
    start: '22:00',
    end: '07:00',
    deferNonUrgentDispatch: true,
    suppressUnattendedActuation: true,
  },
  spend: {
    perStayCap: { amount: 15000, currency: 'INR' },
    perOrderCap: { amount: 6000, currency: 'INR' },
    confirmationRequiredAbove: { amount: 0, currency: 'INR' },
  },
  serviceRequests: {
    maxOpen: 10,
    maxOpenPerCategory: 3,
    slaMinutes: { housekeeping: 20, maintenance: 45, amenity: 15 },
  },
  tierCeiling: 'T3',
  disabledTools: [],
};

export function makeCtx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 'turn_test',
    traceId: 'trace_test',
    scope: {
      tenantId: 't_demo',
      propertyId: 'p_blr_whitefield',
      roomId: 'r_412',
      deviceId: 'd_412a',
    },
    consent: { voice: true, preferences: false, personalisation: false },
    timezone: 'Asia/Kolkata',
    localTime: new Date('2026-07-29T14:00:00'),
    language: 'en-IN',
    capabilityManifestVersion: '3',
    degradationLevel: 0,
    startedAt: Date.now(),
    ...over,
  };
}

export function makeInputs(over: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    ctx: makeCtx(),
    manifest: SUITE_MANIFEST,
    policy: DEFAULT_POLICY,
    openRequests: [],
    stableSpend: { amount: 0, currency: 'INR' },
    recentActuations: [],
    turnsThisHour: 1,
    ...over,
  };
}
