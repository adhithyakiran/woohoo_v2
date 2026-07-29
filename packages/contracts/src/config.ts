import { z } from 'zod';
import { CapabilityManifestSchema } from './capabilities.js';

/**
 * Property configuration — architecture doc Appendix C.
 *
 * This is the artefact that makes onboarding a configuration exercise rather than an
 * engineering project (principle P5). It is authored during onboarding, versioned, and
 * validated by the conformance suite before go-live.
 */

export const MoneySchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof MoneySchema>;

export const PropertyPolicySchema = z.object({
  climate: z.object({
    minC: z.number().default(18),
    maxC: z.number().default(26),
    maxChangesPerHour: z.number().int().default(6),
  }),
  quietHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
    end: z.string().regex(/^\d{2}:\d{2}$/).default('07:00'),
    /** Non-urgent maintenance raised at night is queued for morning, not suppressed (§7). */
    deferNonUrgentDispatch: z.boolean().default(true),
    suppressUnattendedActuation: z.boolean().default(true),
  }),
  spend: z.object({
    perStayCap: MoneySchema,
    perOrderCap: MoneySchema,
    confirmationRequiredAbove: MoneySchema,
  }),
  serviceRequests: z.object({
    maxOpen: z.number().int().default(10),
    maxOpenPerCategory: z.number().int().default(3),
    slaMinutes: z.record(z.string(), z.number().int()).default({}),
  }),
  /** Kill-switch lever (§50). Set to "T0" for read-only mode. */
  tierCeiling: z.enum(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']).default('T3'),
  disabledTools: z.array(z.string()).default([]),
});
export type PropertyPolicy = z.infer<typeof PropertyPolicySchema>;

export const BrandSchema = z.object({
  voiceId: z.string().default('mock-voice'),
  tone: z.string().default('warm, concise, professional'),
  assistantName: z.string().default('Voice Genie'),
  wakeWordModel: z.string().default('hello_voice_genie_v3'),
});

export const EscalationSchema = z.object({
  frontDesk: z.object({ channel: z.string(), target: z.string() }),
  dutyManager: z.object({ channel: z.string(), target: z.string() }),
  welfareProtocolRef: z.string().optional(),
  /** Displayed and spoken when distress is detected — never dialled by the device (§48). */
  emergencyNumberDisplay: z.string(),
  crisisHelplineDisplay: z.string().optional(),
});

export const RoomTypeSchema = z.object({
  id: z.string(),
  count: z.number().int().nonnegative().default(0),
  capabilityManifest: CapabilityManifestSchema,
});

export const RoomOverrideSchema = z.object({
  roomRef: z.string(),
  /** Overrides can only REMOVE capabilities, never add them (see capabilities.applyOverrides). */
  disable: z.array(z.string()).default([]),
  reason: z.string().optional(),
});

export const PropertyConfigSchema = z.object({
  propertyId: z.string(),
  tenantId: z.string(),
  name: z.string(),
  cell: z.enum(['in', 'eu', 'me', 'us', 'apac']).default('in'),
  timezone: z.string().default('Asia/Kolkata'),
  languages: z.array(z.string()).min(1),
  defaultLanguage: z.string(),
  brand: BrandSchema.default({}),
  automation: z.object({
    vendor: z.enum(['inncom', 'interel', 'bacnet', 'knx', 'lutron', 'simulator']),
    /** Vendor room reference is NOT the hotel room number (§39.2). */
    roomRefMapping: z.string().default('vendor_room_id'),
  }),
  pms: z
    .object({
      type: z.enum(['opera_cloud', 'mews', 'cloudbeds', 'none']).default('none'),
      features: z.array(z.string()).default([]),
    })
    .default({ type: 'none', features: [] }),
  policy: PropertyPolicySchema,
  escalation: EscalationSchema,
  roomTypes: z.array(RoomTypeSchema).min(1),
  roomOverrides: z.array(RoomOverrideSchema).default([]),
  asr: z
    .object({ primary: z.string().default('mock'), fallback: z.string().default('mock') })
    .default({ primary: 'mock', fallback: 'mock' }),
  features: z
    .object({
      fnbOrdering: z.boolean().default(true),
      geminiLiveChatLane: z.boolean().default(false),
      crossStayPreferences: z.boolean().default(false),
      personalisedGreeting: z.boolean().default(false),
    })
    .default({}),
  compliance: z
    .object({
      controller: z.string(),
      transcriptRetentionDays: z.number().int().min(1).max(90).default(30),
      noticeVersion: z.string().default('v1'),
    })
    .optional(),
});
export type PropertyConfig = z.infer<typeof PropertyConfigSchema>;

/** "HH:MM" within a quiet-hours window that may wrap past midnight. */
export function isWithinQuietHours(localTime: Date, start: string, end: string): boolean {
  const mins = localTime.getHours() * 60 + localTime.getMinutes();
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}
