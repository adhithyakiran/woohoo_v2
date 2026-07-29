import { describe, expect, it } from 'vitest';
import { RiskTier } from '@woohoo/contracts';
import { PolicyDecisionPoint } from './pdp.js';
import { DEFAULT_POLICY, DELUXE_MANIFEST, makeCtx, makeInputs } from './fixtures.js';
import type { PolicyClock } from './types.js';

const fixedClock = (t: number): PolicyClock => ({ now: () => t });

describe('PDP — tool existence and kill switches', () => {
  it('denies a tool the model invented', () => {
    const v = new PolicyDecisionPoint().decide({ tool: 'door.unlock', args: {} }, makeInputs());
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R1.unknown_tool');
  });

  it('denies a tool disabled by the capability kill switch', () => {
    const inputs = makeInputs({
      policy: { ...DEFAULT_POLICY, disabledTools: ['fnb.place_order'] },
    });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'fnb.place_order', args: { items: [{ menuItemId: 'm1', quantity: 1 }] } },
      inputs,
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R2.tool_disabled');
  });

  it('read-only mode (tier ceiling T0) blocks writes but allows reads', () => {
    const inputs = makeInputs({ policy: { ...DEFAULT_POLICY, tierCeiling: 'T0' } });
    const pdp = new PolicyDecisionPoint();

    const write = pdp.decide({ tool: 'lighting.set', args: { zone: 'bedroom', on: true } }, inputs);
    expect(write.kind).toBe('DENY');
    expect(write.ruleId).toBe('R2.tier_ceiling');

    const read = pdp.decide({ tool: 'room.get_state', args: {} }, inputs);
    expect(read.kind).toBe('ALLOW');
  });
});

describe('PDP — consent', () => {
  it('denies everything when voice consent is withdrawn', () => {
    const inputs = makeInputs({
      ctx: makeCtx({ consent: { voice: false, preferences: false, personalisation: false } }),
    });
    const v = new PolicyDecisionPoint().decide({ tool: 'room.get_state', args: {} }, inputs);
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R3.no_voice_consent');
  });

  it('denies preference writes without preference consent', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'preferences.set', args: { key: 'preferred_temperature_c', value: '22' } },
      makeInputs(),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R3.no_preference_consent');
  });

  it('allows preference writes once the guest has opted in', () => {
    const inputs = makeInputs({
      ctx: makeCtx({ consent: { voice: true, preferences: true, personalisation: false } }),
    });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'preferences.set', args: { key: 'preferred_temperature_c', value: '22' } },
      inputs,
    );
    expect(v.kind).toBe('ALLOW');
  });
});

describe('PDP — T4 is never executed by the agent', () => {
  it('escalates rather than allowing', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'staff.escalate_urgent', args: { category: 'medical', summary: 'chest pain' } },
      makeInputs(),
    );
    expect(v.kind).toBe('ESCALATE');
    expect(v.tier).toBe(RiskTier.T4);
  });

  // Regression: a T3 ceiling must not silence a medical escalation. A ceiling caps what the
  // agent EXECUTES; the route to a human stays open at every degradation level (§48, §68).
  it('still escalates when the property is in read-only mode', () => {
    const inputs = makeInputs({ policy: { ...DEFAULT_POLICY, tierCeiling: 'T0' } });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'staff.escalate_urgent', args: { category: 'medical', summary: 'chest pain' } },
      inputs,
    );
    expect(v.kind).toBe('ESCALATE');
  });

  it('keeps staff.connect reachable under a read-only ceiling', () => {
    const inputs = makeInputs({ policy: { ...DEFAULT_POLICY, tierCeiling: 'T0' } });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'staff.connect', args: { department: 'front_desk' } },
      inputs,
    );
    expect(v.kind).toBe('ALLOW');
  });

  // ...but an explicit by-name kill still wins, so an incident can shut a specific tool down.
  it('honours an explicit by-name disable even for always-available tools', () => {
    const inputs = makeInputs({
      policy: { ...DEFAULT_POLICY, disabledTools: ['staff.connect'] },
    });
    const v = new PolicyDecisionPoint().decide({ tool: 'staff.connect', args: {} }, inputs);
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R2.tool_disabled');
  });
});

describe('PDP — capability gating', () => {
  it('denies a curtain action in a room type without curtains', () => {
    const inputs = makeInputs({ manifest: DELUXE_MANIFEST });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'curtains.set', args: { zone: 'bedroom', position: 0 } },
      inputs,
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R5.capability_absent');
  });

  it('allows curtains when the room only supports binary open/close', () => {
    const inputs = makeInputs({
      manifest: {
        version: '1',
        zones: ['bedroom'],
        capabilities: [{ capability: 'curtains.open_close', zones: ['bedroom'] }],
        scenes: [],
      },
    });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'curtains.set', args: { zone: 'bedroom', position: 0 } },
      inputs,
    );
    expect(v.kind).toBe('ALLOW');
  });
});

describe('PDP — property bounds', () => {
  it('rejects a temperature outside the property band', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'climate.set_temperature', args: { zone: 'bedroom', targetC: 31 } },
      makeInputs(),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R6.out_of_bounds');
    expect(v.reason).toContain('18–26');
  });

  it('accepts a temperature inside the band', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'climate.set_temperature', args: { zone: 'bedroom', targetC: 23 } },
      makeInputs(),
    );
    expect(v.kind).toBe('ALLOW');
  });
});

describe('PDP — quiet hours', () => {
  it('defers a non-urgent night-time maintenance request to morning', () => {
    const inputs = makeInputs({ ctx: makeCtx({ localTime: new Date('2026-07-29T23:14:00') }) });
    const v = new PolicyDecisionPoint().decide(
      {
        tool: 'service.create_request',
        args: { category: 'maintenance', description: 'shower dripping', priority: 'normal' },
      },
      inputs,
    );
    expect(v.kind).toBe('ALLOW');
    expect(v.ruleId).toBe('R7.quiet_hours_defer');
    expect(v.annotations?.dispatchAt).toBe('07:00');
  });

  it('dispatches an urgent request immediately regardless of the hour', () => {
    const inputs = makeInputs({ ctx: makeCtx({ localTime: new Date('2026-07-29T23:14:00') }) });
    const v = new PolicyDecisionPoint().decide(
      {
        tool: 'service.create_request',
        args: { category: 'maintenance', description: 'water leaking', priority: 'urgent' },
      },
      inputs,
    );
    expect(v.kind).toBe('ALLOW');
    expect(v.annotations?.deferred).toBeUndefined();
  });
});

describe('PDP — duplicates and rate limits', () => {
  it('suppresses a duplicate request in the same category', () => {
    const inputs = makeInputs({
      openRequests: [{ id: 'sr_1', category: 'maintenance', createdAt: Date.now() }],
    });
    const v = new PolicyDecisionPoint().decide(
      { tool: 'service.create_request', args: { category: 'maintenance', description: 'tap' } },
      inputs,
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R8.duplicate_request');
    expect(v.annotations?.existingRequestId).toBe('sr_1');
  });

  it('caps climate churn per hour', () => {
    const now = 1_800_000_000_000;
    const recent = Array.from({ length: 6 }, (_, i) => ({
      tool: 'climate.set_temperature',
      at: now - i * 60_000 - 120_000,
    }));
    const v = new PolicyDecisionPoint(fixedClock(now)).decide(
      { tool: 'climate.set_temperature', args: { zone: 'bedroom', targetC: 22 } },
      makeInputs({ recentActuations: recent }),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R9.climate_churn');
  });

  it('caps an actuation burst within a minute', () => {
    const now = 1_800_000_000_000;
    const recent = Array.from({ length: 6 }, (_, i) => ({ tool: 'lighting.set', at: now - i * 1000 }));
    const v = new PolicyDecisionPoint(fixedClock(now)).decide(
      { tool: 'lighting.set', args: { zone: 'bedroom', on: true } },
      makeInputs({ recentActuations: recent }),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R9.actuation_burst');
  });

  it('caps turns per device per hour', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'room.get_state', args: {} },
      makeInputs({ turnsThisHour: 31 }),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R9.turn_rate');
  });
});

describe('PDP — spend control', () => {
  const order = { items: [{ menuItemId: 'm_club', quantity: 1 }] };

  it('denies an order over the per-order cap', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'fnb.place_order', args: order, estimatedCharge: { amount: 6500, currency: 'INR' } },
      makeInputs(),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R10.per_order_cap');
  });

  it('denies an order that would breach the per-stay cap', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'fnb.place_order', args: order, estimatedCharge: { amount: 2000, currency: 'INR' } },
      makeInputs({ stableSpend: { amount: 14000, currency: 'INR' } }),
    );
    expect(v.kind).toBe('DENY');
    expect(v.ruleId).toBe('R10.per_stay_cap');
  });

  it('requires confirmation for an in-budget order rather than allowing it outright', () => {
    const v = new PolicyDecisionPoint().decide(
      { tool: 'fnb.place_order', args: order, estimatedCharge: { amount: 1240, currency: 'INR' } },
      makeInputs(),
    );
    expect(v.kind).toBe('CONFIRM');
    expect(v.confirmation?.mustInclude.totalAmount).toBe(1240);
    expect(v.confirmation?.singleUse).toBe(true);
  });
});

describe('PDP — the T3 confirmation protocol (§44.1)', () => {
  it('executes the frozen action, not a re-derived one', () => {
    const pdp = new PolicyDecisionPoint();
    const inputs = makeInputs();
    const v = pdp.decide(
      {
        tool: 'fnb.place_order',
        args: { items: [{ menuItemId: 'm_club', quantity: 1 }] },
        estimatedCharge: { amount: 1240, currency: 'INR' },
      },
      inputs,
    );
    const token = v.confirmation!.token;

    const redeemed = pdp.redeem(token, inputs.ctx.scope);
    expect(redeemed).toBeDefined();
    // The frozen args are what executes — the confirming turn cannot substitute its own.
    expect(redeemed!.args).toEqual({ items: [{ menuItemId: 'm_club', quantity: 1 }] });
  });

  it('is single use — a replayed token buys nothing', () => {
    const pdp = new PolicyDecisionPoint();
    const inputs = makeInputs();
    const v = pdp.decide(
      {
        tool: 'fnb.place_order',
        args: { items: [{ menuItemId: 'm_club', quantity: 1 }] },
        estimatedCharge: { amount: 1240, currency: 'INR' },
      },
      inputs,
    );
    const token = v.confirmation!.token;
    expect(pdp.redeem(token, inputs.ctx.scope)).toBeDefined();
    expect(pdp.redeem(token, inputs.ctx.scope)).toBeUndefined();
  });

  it('expires after 90 seconds', () => {
    let t = 1_800_000_000_000;
    const pdp = new PolicyDecisionPoint({ now: () => t });
    const inputs = makeInputs();
    const v = pdp.decide(
      {
        tool: 'fnb.place_order',
        args: { items: [{ menuItemId: 'm_club', quantity: 1 }] },
        estimatedCharge: { amount: 1240, currency: 'INR' },
      },
      inputs,
    );
    t += 91_000;
    expect(pdp.redeem(v.confirmation!.token, inputs.ctx.scope)).toBeUndefined();
  });

  it('cannot be redeemed from a different room', () => {
    const pdp = new PolicyDecisionPoint();
    const inputs = makeInputs();
    const v = pdp.decide(
      {
        tool: 'fnb.place_order',
        args: { items: [{ menuItemId: 'm_club', quantity: 1 }] },
        estimatedCharge: { amount: 1240, currency: 'INR' },
      },
      inputs,
    );
    const otherRoom = { ...inputs.ctx.scope, roomId: 'r_999', deviceId: 'd_999' };
    expect(pdp.redeem(v.confirmation!.token, otherRoom)).toBeUndefined();
  });
});
