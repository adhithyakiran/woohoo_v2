import {
  RiskTier,
  getTool,
  hasCapability,
  isWithinQuietHours,
  tierWithinCeiling,
  type Money,
  type Scope,
} from '@woohoo/contracts';
import {
  systemClock,
  type PendingConfirmation,
  type PolicyClock,
  type PolicyInputs,
  type Proposal,
  type Verdict,
} from './types.js';

const CONFIRMATION_TTL_MS = 90_000;

/**
 * Tools that must remain reachable at every degradation level and under every tier ceiling
 * (§29, §48, §68). A property can still disable them by name, but the read-only kill switch
 * must never take away the guest's route to a human.
 */
const ALWAYS_AVAILABLE = new Set(['staff.connect', 'staff.escalate_urgent']);

/**
 * The Policy Decision Point.
 *
 * Every rule below is a structural control, not advice to the model. Rules run in order and
 * the first non-ALLOW verdict wins, so the cheapest and most absolute checks come first.
 */
export class PolicyDecisionPoint {
  private readonly pending = new Map<string, PendingConfirmation>();
  private tokenSeq = 0;

  constructor(private readonly clock: PolicyClock = systemClock) {}

  decide(p: Proposal, inputs: PolicyInputs): Verdict {
    const def = getTool(p.tool);

    // R1 — the tool must exist. A model that invents a tool name gets a hard refusal, and a
    // T5 (prohibited) action has no definition at all, so absence is enforced here too.
    if (!def) {
      return deny('R1.unknown_tool', RiskTier.T5, `No such tool: ${p.tool}.`);
    }
    const tier = def.meta.tier;

    // R2 — kill switches (§50). Capability kill and tier ceiling propagate in seconds and must
    // be evaluated before anything else, because they exist for live incidents.
    if (inputs.policy.disabledTools.includes(p.tool)) {
      return deny('R2.tool_disabled', tier, `${p.tool} is currently disabled for this property.`);
    }

    // R3 — consent. Without voice consent the assistant should not be running at all; this is
    // the backstop if a stale session survives an opt-out.
    if (!inputs.ctx.consent.voice) {
      return deny('R3.no_voice_consent', tier, 'The assistant is disabled for this stay.');
    }
    if (p.tool === 'preferences.set' && !inputs.ctx.consent.preferences) {
      return deny(
        'R3.no_preference_consent',
        tier,
        'The guest has not opted in to preference memory.',
      );
    }

    // R4 — T4 is never executed by the agent. It may only be raised for a human to act on.
    // Deliberately ordered ABOVE the tier ceiling: a property in read-only mode must still be
    // able to summon help. A ceiling caps what the agent EXECUTES, not what it can raise.
    if (tier === RiskTier.T4) {
      return {
        kind: 'ESCALATE',
        tier,
        ruleId: 'R4.escalate_to_human',
        reason: 'Safety-critical or staff-authority action; handing off to a human.',
      };
    }

    // R2b — tier ceiling kill switch (§50), exempting the guest's route to a human.
    if (
      !ALWAYS_AVAILABLE.has(p.tool) &&
      !tierWithinCeiling(tier, inputs.policy.tierCeiling as RiskTier)
    ) {
      return deny(
        'R2.tier_ceiling',
        tier,
        `Property tier ceiling is ${inputs.policy.tierCeiling}; ${p.tool} is ${tier}.`,
      );
    }

    // R5 — capability. Normally unreachable because the tool surface is generated from the
    // manifest (§33), so an absent capability produces no tool. Kept as defence in depth for
    // the fast lane and for manifest changes mid-session.
    const cap = def.meta.requiresCapability;
    if (cap && !this.capabilityPresent(inputs, cap)) {
      return deny('R5.capability_absent', tier, `This room does not have ${cap}.`);
    }

    // R6 — bounds. Property policy, enforced here rather than in the schema, because the
    // permitted range differs per property and must be changeable without a deploy.
    const bounds = this.checkBounds(p, inputs);
    if (bounds) return bounds;

    // R7 — quiet hours. Applies to delivery as well as decision (§43, T7). This never blocks on
    // its own; it annotates, and the annotation must survive into the verdict and the audit
    // record so "deferred to morning" is visible rather than reading as a plain allow.
    const quiet = this.checkQuietHours(p, inputs);

    // R8 — duplicate suppression. Belt and braces: the agent is also told about open tickets
    // in its context, but the platform enforces it regardless.
    const dup = this.checkDuplicate(p, tier, inputs);
    if (dup) return dup;

    // R9 — rate limits, bounding both abuse and a runaway agent (§45).
    const rate = this.checkRates(p, tier, inputs);
    if (rate) return rate;

    // R10 — spend caps and the T3 confirmation requirement. Money always gets a separate turn.
    if (def.meta.spendCapApplies || p.estimatedCharge) {
      const spend = this.checkSpend(p, tier, inputs);
      if (spend) return spend;
    }
    if (def.meta.requiresConfirmation) {
      return this.requireConfirmation(p, tier, inputs);
    }

    return {
      kind: 'ALLOW',
      tier,
      ruleId: quiet?.ruleId ?? 'allow',
      reason: quiet?.reason ?? 'All policy checks passed.',
      ...(quiet ? { annotations: quiet.annotations } : {}),
    };
  }

  private capabilityPresent(inputs: PolicyInputs, cap: string): boolean {
    if (hasCapability(inputs.manifest, cap)) return true;
    // Curtain tools are served by either capability level; the adapter degrades position
    // requests onto binary open/close so the model never sees the difference.
    if (cap === 'curtains.position') return hasCapability(inputs.manifest, 'curtains.open_close');
    return false;
  }

  private checkBounds(p: Proposal, inputs: PolicyInputs): Verdict | undefined {
    if (p.tool !== 'climate.set_temperature') return undefined;
    const target = Number(p.args.targetC);
    const { minC, maxC } = inputs.policy.climate;
    if (!Number.isFinite(target)) {
      return deny('R6.bad_target', RiskTier.T1, 'Target temperature is not a number.');
    }
    if (target < minC || target > maxC) {
      return deny(
        'R6.out_of_bounds',
        RiskTier.T1,
        `This property permits ${minC}–${maxC}°C; ${target}°C is outside that.`,
      );
    }
    return undefined;
  }

  private checkQuietHours(
    p: Proposal,
    inputs: PolicyInputs,
  ): { ruleId: string; reason: string; annotations: Record<string, unknown> } | undefined {
    const { start, end, deferNonUrgentDispatch } = inputs.policy.quietHours;
    if (!isWithinQuietHours(inputs.ctx.localTime, start, end)) return undefined;

    // A non-urgent service request raised at night is queued for morning dispatch and the
    // guest is told so — it is not suppressed, and it is not silently sent at 03:00.
    if (p.tool === 'service.create_request' && deferNonUrgentDispatch) {
      const priority = String(p.args.priority ?? 'normal');
      if (priority !== 'urgent') {
        return {
          ruleId: 'R7.quiet_hours_defer',
          reason: 'Non-urgent request during quiet hours; queued for morning dispatch.',
          annotations: { dispatchAt: end, deferred: true },
        };
      }
    }
    return undefined;
  }

  private checkDuplicate(p: Proposal, tier: RiskTier, inputs: PolicyInputs): Verdict | undefined {
    if (p.tool !== 'service.create_request') return undefined;
    const category = String(p.args.category);
    const existing = inputs.openRequests.filter((r) => r.category === category);
    if (existing.length > 0) {
      return deny(
        'R8.duplicate_request',
        tier,
        `A ${category} request is already open for this room.`,
        { existingRequestId: existing[0]!.id },
      );
    }
    return undefined;
  }

  private checkRates(p: Proposal, tier: RiskTier, inputs: PolicyInputs): Verdict | undefined {
    const now = this.clock.now();

    if (inputs.turnsThisHour > 30) {
      return deny('R9.turn_rate', tier, 'This device has exceeded its hourly turn limit.');
    }

    if (p.tool === 'service.create_request') {
      const { maxOpen, maxOpenPerCategory } = inputs.policy.serviceRequests;
      if (inputs.openRequests.length >= maxOpen) {
        return deny('R9.max_open_requests', tier, `This room already has ${maxOpen} open requests.`);
      }
      const category = String(p.args.category);
      const inCategory = inputs.openRequests.filter((r) => r.category === category).length;
      if (inCategory >= maxOpenPerCategory) {
        return deny('R9.max_open_category', tier, `Too many open ${category} requests.`);
      }
    }

    if (p.tool === 'climate.set_temperature') {
      const hourAgo = now - 3_600_000;
      const changes = inputs.recentActuations.filter(
        (a) => a.tool === 'climate.set_temperature' && a.at >= hourAgo,
      ).length;
      if (changes >= inputs.policy.climate.maxChangesPerHour) {
        return deny(
          'R9.climate_churn',
          tier,
          'The temperature has been changed too many times in the last hour.',
        );
      }
    }

    const minuteAgo = now - 60_000;
    const actuationsThisMinute = inputs.recentActuations.filter((a) => a.at >= minuteAgo).length;
    if (actuationsThisMinute >= 6) {
      return deny('R9.actuation_burst', tier, 'Too many room changes in the last minute.');
    }

    return undefined;
  }

  private checkSpend(p: Proposal, tier: RiskTier, inputs: PolicyInputs): Verdict | undefined {
    const charge = p.estimatedCharge;
    if (!charge) return undefined;
    const { perOrderCap, perStayCap } = inputs.policy.spend;

    if (charge.currency !== perOrderCap.currency) {
      return deny('R10.currency_mismatch', tier, 'Order currency does not match property currency.');
    }
    if (charge.amount > perOrderCap.amount) {
      return deny(
        'R10.per_order_cap',
        tier,
        `Single orders are capped at ${perOrderCap.amount} ${perOrderCap.currency}.`,
      );
    }
    const total = inputs.stableSpend.amount + charge.amount;
    if (total > perStayCap.amount) {
      return deny(
        'R10.per_stay_cap',
        tier,
        `This stay's spending cap of ${perStayCap.amount} ${perStayCap.currency} would be exceeded.`,
      );
    }
    return undefined;
  }

  /**
   * Freeze the proposal server-side and hand back a single-use token (§44.1).
   *
   * The critical property: on confirmation the platform executes THIS frozen action, byte for
   * byte. The model does not get to reinterpret it, so an injection in the confirming turn
   * cannot fabricate a different order.
   */
  private requireConfirmation(p: Proposal, tier: RiskTier, inputs: PolicyInputs): Verdict {
    const token = `pc_${this.clock.now().toString(36)}_${(this.tokenSeq++).toString(36)}`;
    const confirmation: PendingConfirmation = {
      token,
      tool: p.tool,
      args: canonical(p.args),
      scope: inputs.ctx.scope,
      expiresAt: this.clock.now() + CONFIRMATION_TTL_MS,
      singleUse: true,
      mustInclude: p.estimatedCharge
        ? {
            totalAmount: p.estimatedCharge.amount,
            currency: p.estimatedCharge.currency,
            // Sum of quantities, not line count: "two dosas" is two items to a guest, and the
            // spoken confirmation has to match what they think they are agreeing to.
            itemCount: Array.isArray(p.args.items)
              ? (p.args.items as Array<{ quantity?: number }>).reduce(
                  (a, i) => a + (Number(i?.quantity) || 1),
                  0,
                )
              : 1,
          }
        : {},
    };
    this.pending.set(token, confirmation);
    return {
      kind: 'CONFIRM',
      tier,
      ruleId: 'R11.confirmation_required',
      reason: 'Chargeable action; explicit spoken confirmation required in a separate turn.',
      confirmation,
    };
  }

  /** The only way a frozen action can be executed. Consumes the token. */
  redeem(token: string, scope: Scope): PendingConfirmation | undefined {
    const p = this.pending.get(token);
    if (!p) return undefined;
    this.pending.delete(token);
    if (p.expiresAt < this.clock.now()) return undefined;
    // A token minted for one room can never be redeemed from another.
    if (
      p.scope.tenantId !== scope.tenantId ||
      p.scope.propertyId !== scope.propertyId ||
      p.scope.roomId !== scope.roomId
    ) {
      return undefined;
    }
    return p;
  }

  peek(token: string): PendingConfirmation | undefined {
    return this.pending.get(token);
  }

  discard(token: string): void {
    this.pending.delete(token);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

function deny(
  ruleId: string,
  tier: RiskTier,
  reason: string,
  annotations?: Record<string, unknown>,
): Verdict {
  return { kind: 'DENY', tier, ruleId, reason, ...(annotations ? { annotations } : {}) };
}

/** Stable key ordering so the frozen args and the idempotency key are reproducible. */
export function canonical<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v)
        ? canonical(v as Record<string, unknown>)
        : v;
  }
  return out as T;
}

export function moneyOf(amount: number, currency: string): Money {
  return { amount, currency };
}
