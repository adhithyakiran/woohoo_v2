import { describe, expect, it } from 'vitest';
import { SimulatorAdapter } from '@woohoo/adapter-simulator';
import { EdgeGateway } from './index.js';

const ROOM = { vendorRoomId: 'INN-0412', propertyId: 'p_blr_whitefield' };

async function makeEdge(publish?: (e: unknown) => Promise<void>) {
  const adapter = new SimulatorAdapter({ latencyMs: 0, seed: 7 });
  const edge = new EdgeGateway({
    propertyId: 'p_blr_whitefield',
    adapter,
    publish: publish as never,
  });
  await edge.connect();
  return { edge, adapter };
}

describe('edge gateway — offline autonomy', () => {
  it('actuates lights from the local grammar with no cloud involved', async () => {
    const { edge } = await makeEdge();
    const r = await edge.handleOffline(ROOM, 'turn on the lights');
    expect(r.handled).toBe(true);
    const state = edge.localState(ROOM);
    expect(state?.some((s) => s.capability === 'lighting.on_off' && s.value === true)).toBe(true);
  });

  it('refuses honestly outside the grammar and names what still works', async () => {
    const { edge } = await makeEdge();
    const r = await edge.handleOffline(ROOM, 'book me a table at the rooftop restaurant');
    expect(r.handled).toBe(false);
    expect(r.speech).toContain('offline');
    expect(r.speech).toContain('lights');
  });

  it('queues offline actuations for replay once the link returns', async () => {
    const { edge } = await makeEdge();
    await edge.handleOffline(ROOM, 'do not disturb');
    expect(edge.outboxDepth).toBe(1);

    const sent: unknown[] = [];
    const { edge: edge2 } = await makeEdge(async (e) => void sent.push(e));
    await edge2.handleOffline(ROOM, 'lights off');
    const flushed = await edge2.flush();
    expect(flushed.sent).toBe(1);
    expect(flushed.remaining).toBe(0);
  });

  it('keeps entries queued when the upstream is still failing', async () => {
    const { edge } = await makeEdge(async () => {
      throw new Error('WAN down');
    });
    await edge.handleOffline(ROOM, 'lights off');
    const flushed = await edge.flush();
    expect(flushed.sent).toBe(0);
    expect(flushed.remaining).toBe(1);
  });
});

describe('edge gateway — reconnect behaviour', () => {
  it('jitters backoff so a property-wide blip does not become a reconnect storm', async () => {
    const { edge } = await makeEdge();
    edge.markOffline();
    const delays = Array.from({ length: 12 }, () => edge.nextReconnectDelayMs());
    expect(delays.every((d) => d >= 0 && d <= 60_000)).toBe(true);
    // Full jitter means the values must not all be identical.
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it('caps backoff at one minute', async () => {
    const { edge } = await makeEdge();
    edge.markOffline();
    for (let i = 0; i < 40; i++) {
      expect(edge.nextReconnectDelayMs()).toBeLessThanOrEqual(60_000);
    }
  });
});
