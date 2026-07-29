import { z } from 'zod';

/**
 * Scope — architecture doc principle P2, "scope is ambient, never argued".
 *
 * Derived server-side from the authenticated device certificate. The agent is never
 * asked which room to act on and cannot supply one: no tool schema carries a room
 * identifier, and the MCP gateway strips any the model invents (§34.1).
 */
export const ScopeSchema = z.object({
  tenantId: z.string().min(1),
  propertyId: z.string().min(1),
  roomId: z.string().min(1),
  deviceId: z.string().min(1),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const ConsentSchema = z.object({
  /** Voice interaction itself. False ⇒ the assistant is disabled for this stay. */
  voice: z.boolean(),
  /** Cross-stay preference memory. Opt-in only, off by default (§55). */
  preferences: z.boolean(),
  /** Personalised greeting by name. Requires the PMS bridge and explicit opt-in. */
  personalisation: z.boolean(),
});
export type Consent = z.infer<typeof ConsentSchema>;

/** How stale the room-state snapshot is (§37 freshness contract). */
export type Freshness = 'fresh' | 'stale' | 'unknown';

/**
 * The immutable per-turn record that follows a turn through every component.
 * Anything derived from the guest's words belongs in the transcript, never in here.
 */
export interface TurnContext {
  readonly turnId: string;
  readonly traceId: string;
  readonly scope: Scope;
  readonly consent: Consent;
  /** IANA zone of the property, e.g. "Asia/Kolkata". */
  readonly timezone: string;
  /** Local wall-clock time at the property when the turn started. */
  readonly localTime: Date;
  readonly language: string;
  readonly capabilityManifestVersion: string;
  /** Degradation level 0–5 (§68). Set by the orchestrator, read by the router. */
  readonly degradationLevel: number;
  readonly startedAt: number;
}

export function scopeKey(s: Scope): string {
  return `${s.tenantId}/${s.propertyId}/${s.roomId}`;
}

/**
 * Structural guarantee behind principle P2: two scopes match only if every field matches.
 * Used by the PDP to reject any proposal whose resolved scope drifted from the TurnContext.
 */
export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.propertyId === b.propertyId &&
    a.roomId === b.roomId &&
    a.deviceId === b.deviceId
  );
}
