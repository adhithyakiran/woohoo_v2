import { z } from 'zod';
import { RiskTier } from './tiers.js';
import { CapabilityId, type CapabilityManifest, hasCapability, zonesFor } from './capabilities.js';

/**
 * The tool surface — architecture doc §32.
 *
 * Design rules encoded here:
 *  - No tool takes a room or property identifier. Scope is ambient (P2).
 *  - Under 25 tools; a property typically sees 12–18 after capability filtering.
 *  - `.strict()` on every schema so model-invented fields are rejected, not ignored.
 *  - Every mutating tool declares its tier, and the PDP — not the prompt — enforces it.
 */

export interface ToolMeta {
  tier: RiskTier;
  idempotent: boolean;
  /** Read the resulting state back before confirming to the guest (§37). */
  verifyRead: boolean;
  /** T3: must be confirmed in a separate turn against a frozen pending action (§44.1). */
  requiresConfirmation: boolean;
  /** Fields the spoken confirmation must contain before the platform will accept a "yes". */
  confirmationMustInclude?: string[];
  spendCapApplies: boolean;
  timeoutMs: number;
  /** Capability this tool requires. Absent ⇒ always present regardless of manifest. */
  requiresCapability?: string;
  /** Tool result is authored by staff or a vendor ⇒ fence it as untrusted content (§46). */
  untrustedResult: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  meta: ToolMeta;
}

const meta = (m: Partial<ToolMeta> & { tier: RiskTier }): ToolMeta => ({
  idempotent: true,
  verifyRead: false,
  requiresConfirmation: false,
  spendCapApplies: false,
  timeoutMs: 2500,
  untrustedResult: false,
  ...m,
});

const ZONES = ['bedroom', 'living', 'bathroom', 'entrance'] as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'room.get_state',
    description:
      'Current state of every controllable device in the guest\'s room. Call before any relative ' +
      'adjustment (warmer, dimmer, brighter). Usually already provided in context.',
    input: z.object({}).strict(),
    meta: meta({ tier: RiskTier.T0, timeoutMs: 1200 }),
  },
  {
    name: 'lighting.set',
    description: 'Turn lights on or off, or set brightness, for one zone of the room.',
    input: z
      .object({
        zone: z.enum(ZONES),
        on: z.boolean().optional(),
        brightness: z.number().int().min(0).max(100).optional(),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1, verifyRead: true, requiresCapability: CapabilityId.LightingOnOff }),
  },
  {
    name: 'climate.set_temperature',
    description:
      'Set the target temperature for a zone. Use room.get_state first for relative requests. ' +
      'Bounds are set by the property; a value outside them is rejected with the permitted range.',
    input: z
      .object({
        zone: z.enum(ZONES),
        targetC: z.number().min(10).max(35),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1, verifyRead: true, requiresCapability: CapabilityId.ClimateSetpoint }),
  },
  {
    name: 'climate.set_mode',
    description: 'Set the HVAC mode for a zone.',
    input: z
      .object({
        zone: z.enum(ZONES),
        mode: z.enum(['auto', 'cool', 'heat', 'fan', 'off']),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1, verifyRead: true, requiresCapability: CapabilityId.ClimateMode }),
  },
  {
    name: 'curtains.set',
    description:
      'Open or close the curtains, or set a position from 0 (closed) to 100 (open). In rooms that ' +
      'only support open/close the adapter maps any position under 50 to closed.',
    input: z
      .object({
        zone: z.enum(ZONES),
        position: z.number().int().min(0).max(100),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1, verifyRead: true, requiresCapability: CapabilityId.CurtainsPosition }),
  },
  {
    name: 'dnd.set',
    description: 'Set do-not-disturb, request make-up-room, or clear both.',
    input: z.object({ state: z.enum(['off', 'dnd', 'make_up_room']) }).strict(),
    meta: meta({ tier: RiskTier.T1, verifyRead: true, requiresCapability: CapabilityId.Dnd }),
  },
  {
    name: 'tv.control',
    description: 'Control the in-room television.',
    input: z
      .object({
        power: z.enum(['on', 'off']).optional(),
        volume: z.number().int().min(0).max(100).optional(),
        input: z.string().max(32).optional(),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1, requiresCapability: CapabilityId.TvControl }),
  },
  {
    name: 'scene.apply',
    description: 'Apply a named room scene defined by the property, such as sleep, work or movie.',
    input: z.object({ scene: z.string().min(1).max(32) }).strict(),
    meta: meta({ tier: RiskTier.T1, verifyRead: true, requiresCapability: CapabilityId.LightingScene }),
  },
  {
    name: 'media.control',
    description: 'Control music playback in the room.',
    input: z
      .object({
        action: z.enum(['play', 'pause', 'next', 'previous']),
        query: z.string().max(120).optional(),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1, requiresCapability: CapabilityId.MediaPlayback }),
  },
  {
    name: 'service.create_request',
    description:
      'Raise a housekeeping, maintenance or amenity request for this room. Describe the problem in ' +
      'the guest\'s own terms — a technician reads this. Check service.get_status first.',
    input: z
      .object({
        category: z.enum(['housekeeping', 'maintenance', 'amenity']),
        subcategory: z.string().max(48).optional(),
        description: z.string().min(3).max(400),
        priority: z.enum(['low', 'normal', 'urgent']).default('normal'),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T2, idempotent: false, timeoutMs: 3000 }),
  },
  {
    name: 'service.get_status',
    description: 'Open service requests for this room, with status and expected time.',
    input: z.object({}).strict(),
    meta: meta({ tier: RiskTier.T0, timeoutMs: 1200 }),
  },
  {
    name: 'service.cancel_request',
    description: 'Cancel an open service request raised from this room.',
    input: z.object({ requestId: z.string().min(1) }).strict(),
    meta: meta({ tier: RiskTier.T2 }),
  },
  {
    name: 'fnb.get_menu',
    description: 'The food and beverage menu available to this room right now, with prices.',
    input: z.object({ category: z.string().max(48).optional() }).strict(),
    meta: meta({ tier: RiskTier.T0, untrustedResult: true, timeoutMs: 1500 }),
  },
  {
    name: 'fnb.place_order',
    description:
      'Place a food and beverage order charged to the room folio. ALWAYS state the full total aloud ' +
      'and obtain explicit confirmation. Never place an order in the same turn it is first proposed. ' +
      'Item ids must come from fnb.get_menu — never invent one.',
    input: z
      .object({
        items: z
          .array(
            z
              .object({
                menuItemId: z.string().min(1),
                quantity: z.number().int().min(1).max(10),
                notes: z.string().max(200).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(15),
        deliveryNote: z.string().max(200).optional(),
      })
      .strict(),
    meta: meta({
      tier: RiskTier.T3,
      idempotent: true,
      requiresConfirmation: true,
      confirmationMustInclude: ['totalAmount', 'currency', 'itemCount'],
      spendCapApplies: true,
      timeoutMs: 4000,
    }),
  },
  {
    name: 'fnb.get_order_status',
    description: 'Status of food and beverage orders placed from this room.',
    input: z.object({}).strict(),
    meta: meta({ tier: RiskTier.T0, timeoutMs: 1200 }),
  },
  {
    name: 'stay.get_info',
    description:
      'Facts about this room\'s current stay: checkout time, wifi details, room type, folio total. ' +
      'Only ever resolves the stay bound to this room.',
    input: z.object({}).strict(),
    meta: meta({ tier: RiskTier.T0, timeoutMs: 1500 }),
  },
  {
    name: 'stay.request_late_checkout',
    description: 'Request (not grant) a later checkout time. The front desk decides.',
    input: z.object({ requestedTime: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
    meta: meta({ tier: RiskTier.T2 }),
  },
  {
    name: 'stay.set_wakeup_call',
    description: 'Set or cancel a wake-up call. Always read the time back to the guest.',
    input: z
      .object({
        action: z.enum(['set', 'cancel']),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T2 }),
  },
  {
    name: 'property.search_knowledge',
    description:
      'Search property information: amenity hours, policies, wifi, directions, recommendations. ' +
      'Answer property questions ONLY from this tool, never from your own knowledge. If it returns ' +
      'nothing, say you do not know and offer staff.connect.',
    input: z.object({ query: z.string().min(2).max(200) }).strict(),
    meta: meta({ tier: RiskTier.T0, untrustedResult: true, timeoutMs: 1500 }),
  },
  {
    name: 'staff.connect',
    description:
      'Connect the guest to the front desk or concierge. Always available, at every degradation level. ' +
      'Use this whenever you cannot help.',
    input: z
      .object({
        department: z.enum(['front_desk', 'concierge', 'housekeeping']).default('front_desk'),
        reason: z.string().max(200).optional(),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T2 }),
  },
  {
    name: 'staff.escalate_urgent',
    description:
      'Raise an urgent human escalation with context. Use for medical, fire, security or welfare ' +
      'concerns. You do not resolve these — you gather context and hand off fast.',
    input: z
      .object({
        category: z.enum(['medical', 'fire', 'security', 'welfare', 'other']),
        summary: z.string().min(3).max(400),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T4, idempotent: false, timeoutMs: 2000 }),
  },
  {
    name: 'preferences.set',
    description: 'Remember a preference for the rest of this stay. Requires the guest to have opted in.',
    input: z
      .object({
        key: z.enum(['preferred_temperature_c', 'preferred_wake_time', 'dietary_note']),
        value: z.string().max(120),
      })
      .strict(),
    meta: meta({ tier: RiskTier.T1 }),
  },
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_BY_NAME.get(name);
}

/**
 * Generate the tool surface for one room from its capability manifest (§33).
 *
 * A capability the room does not have produces NO tool, so the model cannot propose it —
 * no runtime check is needed and no apology is ever generated for an impossible action.
 * Zone enums are narrowed to the zones that actually exist, which keeps the model inside
 * validity rather than relying on it to guess.
 */
export function toolSurfaceFor(
  manifest: CapabilityManifest,
  opts: { consentPreferences: boolean } = { consentPreferences: false },
): ToolDefinition[] {
  return TOOLS.filter((t) => {
    if (t.name === 'preferences.set' && !opts.consentPreferences) return false;
    const cap = t.meta.requiresCapability;
    if (!cap) return true;
    if (cap === CapabilityId.CurtainsPosition) {
      // Either curtain capability level exposes the same tool; the adapter degrades position
      // onto open/close so the model never learns the difference.
      return hasCapability(manifest, CapabilityId.CurtainsPosition) ||
        hasCapability(manifest, CapabilityId.CurtainsOpenClose);
    }
    return hasCapability(manifest, cap);
  }).map((t) => narrowZones(t, manifest));
}

function narrowZones(t: ToolDefinition, manifest: CapabilityManifest): ToolDefinition {
  const cap = t.meta.requiresCapability;
  if (!cap) return t;
  const zones = zonesFor(manifest, cap);
  if (!zones.length) return t;
  // Rebuilding the schema keeps the advertised enum honest — the model sees only real zones.
  const shape = (t.input as z.ZodObject<z.ZodRawShape>).shape;
  if (!shape || !('zone' in shape)) return t;
  const next = z.object({ ...shape, zone: z.enum(zones as [string, ...string[]]) }).strict();
  return { ...t, input: next };
}
