import type {
  CapabilityManifest,
  Money,
  PropertyPolicy,
  RiskTier,
  Scope,
  TurnContext,
} from '@woohoo/contracts';

/**
 * PDP contract — architecture doc §44 and principle P1.
 *
 * The PDP is deliberately a separate, small, readable service. It reads the TurnContext and
 * the proposed tool call — structured data — and NEVER the prompt, the model's reasoning, or
 * the conversation. An injection can change what the model PROPOSES; it cannot change what
 * is PERMITTED, because the component deciding never read the attacker's text (§46, layer 2).
 */

export type VerdictKind = 'ALLOW' | 'CONFIRM' | 'DENY' | 'ESCALATE';

export interface Verdict {
  kind: VerdictKind;
  tier: RiskTier;
  /** Which rule decided. Emitted on policy.denied events and used by the eval suites. */
  ruleId: string;
  reason: string;
  /** Extra instructions for the executor, e.g. { dispatchAt: "08:00" } (§7). */
  annotations?: Record<string, unknown>;
  /** Present on CONFIRM: the single-use token the next turn must present. */
  confirmation?: PendingConfirmation;
}

export interface PendingConfirmation {
  token: string;
  tool: string;
  /** Frozen, canonical arguments. The action executed on "yes" is this, byte for byte. */
  args: Record<string, unknown>;
  scope: Scope;
  expiresAt: number;
  singleUse: true;
  /** Values the spoken confirmation must contain, e.g. total and currency. */
  mustInclude: Record<string, unknown>;
}

/** Everything the PDP needs that is not in the TurnContext. Supplied by the caller, not the model. */
export interface PolicyInputs {
  ctx: TurnContext;
  manifest: CapabilityManifest;
  policy: PropertyPolicy;
  /** Open service requests for this room, for duplicate suppression. */
  openRequests: Array<{ id: string; category: string; createdAt: number }>;
  /** Money already committed this stay, for the spend cap. */
  stableSpend: Money;
  /** Recent actuations for the rate limit, newest first. */
  recentActuations: Array<{ tool: string; at: number }>;
  /** Turn count for this device in the trailing hour. */
  turnsThisHour: number;
}

export interface Proposal {
  tool: string;
  /** Post-validation arguments. Scope fields have already been stripped by the gateway. */
  args: Record<string, unknown>;
  /** Estimated monetary effect, computed by the domain module — never by the model. */
  estimatedCharge?: Money;
}

export interface PolicyClock {
  now(): number;
}

export const systemClock: PolicyClock = { now: () => Date.now() };
