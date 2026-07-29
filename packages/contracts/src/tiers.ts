/**
 * Action risk tiers — architecture doc §44.
 *
 * The tier determines what the platform requires before an action reaches the world.
 * It is a property of the TOOL, not of the model's confidence, and it is evaluated by
 * the Policy Decision Point, which never reads the prompt or the model's reasoning.
 */
export const RiskTier = {
  /** Read-only, no side effects. Scope check only. */
  T0: 'T0',
  /** Reversible physical, low consequence. Scope + capability + bounds. */
  T1: 'T1',
  /** Involves a human or an external commitment. Scope + duplicate + rate limit. */
  T2: 'T2',
  /** Money, or hard to reverse. Mandatory explicit spoken confirmation in a separate turn. */
  T3: 'T3',
  /** Safety-critical or staff-authority. The agent may only raise these; a human acts. */
  T4: 'T4',
  /** Prohibited. No tool exists — absence is the control. */
  T5: 'T5',
} as const;

export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier];

const ORDER: RiskTier[] = [RiskTier.T0, RiskTier.T1, RiskTier.T2, RiskTier.T3, RiskTier.T4, RiskTier.T5];

export function tierRank(t: RiskTier): number {
  return ORDER.indexOf(t);
}

/** True when `tier` sits at or below `ceiling` — used by the kill-switch tier ceiling (§50). */
export function tierWithinCeiling(tier: RiskTier, ceiling: RiskTier): boolean {
  return tierRank(tier) <= tierRank(ceiling);
}

/**
 * Tiers the deterministic fast lane is permitted to serve (§24.2).
 * Anything at T3 or above always gets full reasoning plus explicit confirmation.
 */
export function fastLaneEligible(tier: RiskTier): boolean {
  return tierRank(tier) <= tierRank(RiskTier.T2);
}

/** Automatic retry is only ever safe for reads and reversible physical actions (§34.3). */
export function autoRetryable(tier: RiskTier): boolean {
  return tierRank(tier) <= tierRank(RiskTier.T1);
}
