import { describe, expect, it } from 'vitest';
import type {
  AdapterHealth,
  AutomationAdapter,
  CapabilityOperation,
  CapabilityResult,
  CapabilityState,
  ConformanceTest,
  ConnectionHandle,
  PropertyBinding,
  StateChange,
  Unsubscribe,
  VendorRoomRef,
} from '@woohoo/contracts';

import { buildApp } from '../app.js';

/**
 * The failure this guards against - architecture doc §39.
 *
 * "I've turned on your bedroom light" when the light never moved is worse than an error: the
 * guest stops trusting everything the assistant says. It nearly shipped, because
 * DeviceStateService returns its ToolError NESTED inside an ApplyOutcome while `isToolError`
 * tests for a flat one - so a rejected command was recorded as ok and phrased as "Done."
 *
 * It stayed invisible while every adapter in the repo succeeded. It appeared the moment an
 * adapter said no, which real ones do constantly: a room simply does not have that device.
 */
class RefusingAdapter implements AutomationAdapter {
  readonly vendor = 'refusing';
  applied = 0;

  async connect(binding: PropertyBinding): Promise<ConnectionHandle> {
    return { propertyId: binding.propertyId, connectedAt: Date.now(), close: async () => {} };
  }
  async health(): Promise<AdapterHealth> {
    return { reachable: true, latencyMs: 1 };
  }
  async readRoomState(): Promise<CapabilityState[]> {
    return [];
  }
  subscribe(_room: VendorRoomRef, _cb: (c: StateChange) => void): Unsubscribe {
    return () => {};
  }
  async applyCapability(
    _room: VendorRoomRef,
    op: CapabilityOperation,
    _key: string,
  ): Promise<CapabilityResult> {
    this.applied += 1;
    return { status: 'rejected', message: `no command for ${op.capability}` };
  }
  conformanceSuite(): ConformanceTest[] {
    return [];
  }
}

async function turn(transcript: string) {
  const adapter = new RefusingAdapter();
  const app = await buildApp({ adapter });
  const res = await app.orchestrator.handleTurn({ deviceId: 'd_412a', transcript });
  return { res, adapter };
}

describe('a room that refuses a command is never confirmed', () => {
  it('records the tool call as failed rather than ok', async () => {
    const { res, adapter } = await turn('turn on the lights');
    expect(adapter.applied).toBeGreaterThan(0);
    for (const call of res.calls) {
      expect(call.result?.ok, `${call.tool} was recorded as ok despite being rejected`).toBe(false);
    }
  });

  it('never tells the guest it is done', async () => {
    const { res } = await turn('turn on the lights');
    expect(res.speech.toLowerCase()).not.toMatch(/\bdone\b/);
    expect(res.speech.toLowerCase()).not.toMatch(/i've (turned|set|opened|closed)/);
  });

  it('carries the reason through, so the guest is told what to do next', async () => {
    const { res } = await turn('turn on the lights');
    expect(res.speech.length).toBeGreaterThan(0);
    const failed = res.calls.find((c) => c.result?.ok === false);
    expect(failed?.result?.error?.error).toBeDefined();
  });

  it('applies to climate as well, where a wrong confirmation quotes a temperature', async () => {
    const { res } = await turn('set the temperature to 21');
    for (const call of res.calls) expect(call.result?.ok).toBe(false);
    expect(res.speech.toLowerCase()).not.toMatch(/i've set it to/);
  });
});
