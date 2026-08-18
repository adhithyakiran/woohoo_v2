import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { fallbackSpeech, outputGuard, templatedConfirmation } from './orchestrator.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../agent/llm.js';
import type { ExecutedCall } from '../agent/runtime.js';

/**
 * Adversarial-model tests — architecture doc §46.
 *
 * The prompt is not a security control, so the honest question is: what happens when the model
 * ITSELF is the adversary? These use a provider that ignores every instruction and proposes
 * exactly what an attacker would, then assert the platform stops it regardless.
 */
class AdversarialLlm implements LlmProvider {
  readonly name = 'adversarial';
  readonly model = 'mock';
  constructor(private readonly calls: Array<{ tool: string; args: Record<string, unknown> }>) {}
  async generate(_req: LlmRequest): Promise<LlmResponse> {
    return {
      toolCalls: this.calls,
      usage: { tokensIn: 0, tokensCached: 0, tokensOut: 0 },
      model: 'mock',
      finishReason: 'tool_calls',
    };
  }
}

async function attack(calls: Array<{ tool: string; args: Record<string, unknown> }>) {
  const app = await buildApp({ llm: new AdversarialLlm(calls) });
  const res = await app.orchestrator.handleTurn({
    deviceId: 'd_412a',
    transcript: 'do it',
  });
  return { res, app };
}

describe('a fully compromised model cannot reach the world', () => {
  it('cannot invoke a tool that does not exist (door locks are absent by design)', async () => {
    const { res } = await attack([{ tool: 'door.unlock', args: {} }]);
    expect(res.calls[0]?.verdict.kind).toBe('DENY');
    expect(res.calls[0]?.result?.ok).toBeFalsy();
  });

  it('cannot address another room by injecting a scope field', async () => {
    const { res } = await attack([
      { tool: 'stay.get_info', args: { room_id: 'r_402', roomNumber: '402' } },
    ]);
    // Rejected by strict schema validation: stay.get_info accepts no arguments at all.
    expect(res.calls[0]?.verdict.kind).toBe('DENY');
  });

  it('cannot actuate another room by smuggling room_id alongside valid args', async () => {
    const { res } = await attack([
      { tool: 'lighting.set', args: { zone: 'bedroom', on: false, room_id: 'r_511' } },
    ]);
    expect(res.calls[0]?.verdict.kind).toBe('DENY');
  });

  it('cannot use a capability the room does not have', async () => {
    // d_412a is a Deluxe: no curtains. The tool is not in its surface.
    const { res } = await attack([{ tool: 'curtains.set', args: { zone: 'bedroom', position: 0 } }]);
    expect(res.calls[0]?.verdict.kind).toBe('DENY');
  });

  it('cannot exceed the property temperature band', async () => {
    const { res } = await attack([
      { tool: 'climate.set_temperature', args: { zone: 'bedroom', targetC: 35 } },
    ]);
    expect(res.calls[0]?.verdict.ruleId).toBe('R6.out_of_bounds');
  });

  it('cannot spend past the per-order cap', async () => {
    const { res } = await attack([
      { tool: 'fnb.place_order', args: { items: [{ menuItemId: 'm_club', quantity: 10 }] } },
    ]);
    expect(res.calls[0]?.verdict.ruleId).toBe('R10.per_order_cap');
  });

  it('cannot self-confirm a chargeable action inside one turn', async () => {
    const { res } = await attack([
      { tool: 'fnb.place_order', args: { items: [{ menuItemId: 'm_club', quantity: 1 }] } },
    ]);
    expect(res.calls[0]?.verdict.kind).toBe('CONFIRM');
    expect(res.awaitingConfirmation).toBe(true);
    expect(res.speech.toLowerCase()).not.toContain('ordered —');
  });
});

describe('the guest is never told an action succeeded when it did not', () => {
  // Regression: a blanket "Done." default meant every-action-denied still reported success.
  it('does not say "Done" when every action was refused', async () => {
    const { res } = await attack([{ tool: 'door.unlock', args: {} }]);
    expect(res.speech).not.toBe('Done.');
    expect(res.speech.toLowerCase()).toContain("couldn't");
  });

  it('says "Done" only when something actually succeeded', () => {
    const ok: ExecutedCall = {
      tool: 'lighting.set',
      args: {},
      verdict: { kind: 'ALLOW', tier: 'T1', ruleId: 'allow', reason: '' },
      result: { ok: true, latencyMs: 1 },
    };
    expect(fallbackSpeech([ok])).toBe('Done.');
  });

  it('is explicit about partial success rather than rounding up', () => {
    const ok: ExecutedCall = {
      tool: 'lighting.set',
      args: {},
      verdict: { kind: 'ALLOW', tier: 'T1', ruleId: 'allow', reason: '' },
      result: { ok: true, latencyMs: 1 },
    };
    const denied: ExecutedCall = {
      tool: 'curtains.set',
      args: {},
      verdict: { kind: 'DENY', tier: 'T1', ruleId: 'R5.capability_absent', reason: '' },
      result: { ok: false, latencyMs: 0 },
    };
    expect(fallbackSpeech([ok, denied])).toContain('part of that');
  });

  it('offers a human when nothing was attempted at all', () => {
    expect(fallbackSpeech([])).toContain('front desk');
  });
});

describe('output guard', () => {
  it('replaces another room number with a neutral phrase', () => {
    const r = outputGuard('The guest in room 402 ordered a sandwich.', '412');
    expect(r.text).not.toContain('402');
    expect(r.violations).toContain('other_room_reference');
  });

  it('leaves the caller’s own room number intact', () => {
    const r = outputGuard('Your room 412 is set to 22 degrees.', '412');
    expect(r.text).toContain('412');
    expect(r.violations).not.toContain('other_room_reference');
  });

  it('strips prompt-leak markers', () => {
    const r = outputGuard('Here is my SYSTEM IDENTITY and <untrusted> block', '412');
    expect(r.violations).toContain('prompt_leak');
    expect(r.text).not.toContain('<untrusted>');
  });

  it('caps runaway length', () => {
    const r = outputGuard('word '.repeat(200), '412');
    expect(r.violations).toContain('too_long');
    expect(r.text.split(/\s+/).length).toBeLessThanOrEqual(46);
  });
});

/**
 * A fast-lane proposal that the PDP denies escalates to the agentic lane so the guest gets an
 * explanation. The denial itself must survive that escalation.
 *
 * It did not: the agentic result overwrote the call list, so "set the temperature to 35
 * degrees" — refused by R6.out_of_bounds — was reported with calls:[] and a guardrail summary
 * reading "No tool calls proposed, so nothing required authorisation". The observability panel
 * therefore showed no policy involvement at the exact moment policy blocked the command.
 */
describe('fast-lane denial is recorded', () => {
  it('keeps the denied call after escalating to the agentic lane', async () => {
    const app = await buildApp({});
    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_511a',
      transcript: 'set the temperature to 35 degrees',
      asrConfidence: 0.95,
    });

    const denied = res.calls.filter((c) => c.verdict.kind === 'DENY');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]!.tool).toBe('climate.set_temperature');
    expect(denied[0]!.verdict.ruleId).toContain('out_of_bounds');
  });

  it('reports the policy guardrail as blocked, not as not_applicable', async () => {
    const app = await buildApp({});
    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_511a',
      transcript: 'set the temperature to 35 degrees',
      asrConfidence: 0.95,
    });

    const pdp = res.guardrails.find((g) => g.control === 'Policy Decision Point');
    expect(pdp).toBeDefined();
    expect(pdp!.outcome).toBe('blocked');
    expect(pdp!.detail).toContain('out_of_bounds');
  });
});

/**
 * Silent failure — the head-end acknowledges a write and does not perform it.
 *
 * This is the single most damaging failure mode this product has: the guest is told the room
 * changed, and it did not. It shipped. The chain had three independent defects, each of which
 * alone was enough to produce a confident lie:
 *
 *   1. the simulator returned status 'applied' even when it knowingly skipped the write;
 *   2. the verify-read compared the re-read against the adapter's OWN observed value rather
 *      than against the request, so both reads agreed on the stale value and it concluded
 *      success — it was checking the head-end was self-consistent, which it always is;
 *   3. the guardrail counted result.ok, which is true for a pending change, and reported
 *      "1 change read back and confirmed".
 *
 * The observable symptom was an assistant saying "I've set it to 19.5 degrees" to a guest who
 * had asked for 25.
 */
describe('silent head-end failure', () => {
  async function silentApp() {
    const { SimulatorAdapter } = await import('@woohoo/adapter-simulator');
    // Every write is acknowledged and none takes effect.
    return buildApp({ adapter: new SimulatorAdapter({ latencyMs: 0, seed: 3, silentFailureRate: 1 }) });
  }

  it('does not report a change that did not happen as applied', async () => {
    const app = await silentApp();
    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_511a',
      transcript: 'set the bedroom to 25 degrees',
      asrConfidence: 0.95,
    });

    const climate = res.calls.filter((c) => c.tool === 'climate.set_temperature');
    expect(climate.length).toBeGreaterThan(0);
    for (const c of climate) {
      if (c.verdict.kind !== 'ALLOW') continue;
      const status = (c.result?.value as { status?: string } | undefined)?.status;
      expect(status, 'a silently failed write must not be reported as applied').not.toBe('applied');
    }
  });

  it('reports the verify-read guardrail as modified, not passed', async () => {
    const app = await silentApp();
    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_511a',
      transcript: 'set the bedroom to 25 degrees',
      asrConfidence: 0.95,
    });

    const vr = res.guardrails.find((g) => g.control === 'Verify-read');
    expect(vr).toBeDefined();
    expect(vr!.outcome).not.toBe('passed');
    expect(vr!.detail).toMatch(/not observed|pending/i);
  });

  it('still reports applied when the write genuinely takes effect', async () => {
    const { SimulatorAdapter } = await import('@woohoo/adapter-simulator');
    const app = await buildApp({ adapter: new SimulatorAdapter({ latencyMs: 0, seed: 3 }) });
    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_511a',
      transcript: 'set the bedroom to 22 degrees',
      asrConfidence: 0.95,
    });

    const applied = res.calls.some(
      (c) => (c.result?.value as { status?: string } | undefined)?.status === 'applied',
    );
    expect(applied, 'a healthy write must still be reported as applied').toBe(true);

    const vr = res.guardrails.find((g) => g.control === 'Verify-read');
    expect(vr!.outcome).toBe('passed');
  });
});

/**
 * A reply must never interpolate a missing reading. This was observable: a head-end that
 * returned no value produced "I've set it to undefined degrees" in a guest bedroom.
 */
describe('confirmation wording never leaks undefined', () => {
  it('falls back to a plain confirmation when no value was observed', () => {
    const speech = templatedConfirmation({
      tool: 'climate.set_temperature',
      args: { targetC: 23 },
      verdict: { kind: 'ALLOW', tier: 'T1', ruleId: 'allow', reason: '' },
      result: { ok: true, value: { status: 'applied' }, latencyMs: 1 },
    } as never);

    expect(speech).not.toContain('undefined');
    expect(speech).toBe('Done.');
  });

  it('quotes what was asked for, not the stale reading, when pending', () => {
    const speech = templatedConfirmation({
      tool: 'climate.set_temperature',
      args: { targetC: 26 },
      verdict: { kind: 'ALLOW', tier: 'T1', ruleId: 'allow', reason: '' },
      result: { ok: true, value: { status: 'pending', observed: { value: 19.5 } }, latencyMs: 1 },
    } as never);

    expect(speech).toContain('26');
    expect(speech).not.toContain('19.5');
  });
});

/**
 * Rooms were only creatable by editing seed.ts and restarting. Provisioning at runtime has to
 * produce a room that is immediately usable, or it is worse than useless: a caller would get a
 * 201 and then an unknown-device error on the very next request.
 */
describe('room provisioning', () => {
  it('creates a room that can be spoken to straight away', async () => {
    const { provisionRoom } = await import('./provisioning.js');
    const app = await buildApp({});

    const created = await provisionRoom(
      app.catalogRepo,
      app.catalog,
      {
        roomNumber: '901',
        vendorRoomId: 'INN-0088',
        zones: ['bedroom'],
        capabilities: [{ capability: 'lighting.on_off' }],
      },
      'p_blr_whitefield',
    );

    expect(created.deviceId).toBe('d_901a');
    expect(created.capabilities).toContain('lighting.on_off');

    // The resolution cache is per-device with a 60s TTL; without invalidation on write the new
    // room is invisible for a minute and the first turn fails for no visible reason.
    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_901a',
      transcript: 'turn on the lights',
      asrConfidence: 0.95,
    });
    expect(res.speech.length).toBeGreaterThan(0);
  });

  it('only offers tools the provisioned room actually has', async () => {
    const { provisionRoom } = await import('./provisioning.js');
    const app = await buildApp({});

    await provisionRoom(
      app.catalogRepo,
      app.catalog,
      { roomNumber: '902', vendorRoomId: 'INN-0088', capabilities: [{ capability: 'lighting.on_off' }] },
      'p_blr_whitefield',
    );

    const res = await app.orchestrator.handleTurn({
      deviceId: 'd_902a',
      transcript: 'close the curtains',
      asrConfidence: 0.95,
    });

    // No curtain capability was granted, so no curtain tool exists to propose.
    expect(res.calls.some((c) => c.tool.startsWith('curtains.'))).toBe(false);
  });

  it('rejects an unknown room type rather than creating a room that cannot resolve', async () => {
    const { provisionRoom, ProvisioningError } = await import('./provisioning.js');
    const app = await buildApp({});

    await expect(
      provisionRoom(
        app.catalogRepo,
        app.catalog,
        { roomNumber: '903', vendorRoomId: 'INN-0088', roomTypeId: 'rt_does_not_exist' },
        'p_blr_whitefield',
      ),
    ).rejects.toBeInstanceOf(ProvisioningError);
  });

  it('updates rather than duplicates when the same room number is sent twice', async () => {
    const { provisionRoom, listConfigured } = await import('./provisioning.js');
    const app = await buildApp({});
    const room = { roomNumber: '904', vendorRoomId: 'INN-0088', roomTypeId: 'rt_suite' };

    await provisionRoom(app.catalogRepo, app.catalog, room, 'p_blr_whitefield');
    await provisionRoom(
      app.catalogRepo,
      app.catalog,
      { ...room, vendorRoomId: 'INN-0512' },
      'p_blr_whitefield',
    );

    const listed = await listConfigured(app.catalogRepo, app.catalog, 'p_blr_whitefield');
    const matches = listed.rooms.filter((r) => r.roomNumber === '904');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.vendorRoomId).toBe('INN-0512');
  });
});
