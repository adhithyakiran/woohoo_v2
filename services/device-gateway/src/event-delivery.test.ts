import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, EventJournal, InProcessEventBus, type App } from '@woohoo/core';
import { EventType, makeEvent } from '@woohoo/contracts';
import { DeviceGateway, adminToken, eventToken } from './index.js';

/**
 * The event-delivery contract - integration review R7, C4.
 *
 * The review's question is the one that matters operationally: "how will enterprise reliably
 * receive service, order, escalation and checkout events after a disconnect or restart". So
 * these tests are about position and loss, not about the happy path. The assertion that earns
 * its place is the gap one: a consumer resuming from an evicted position must be told, because
 * the failure mode of the alternative is a housekeeping request that silently never arrives.
 */

let gateway: DeviceGateway;
let app: App;
let port: number;

beforeAll(async () => {
  app = await buildApp();
  gateway = new DeviceGateway({ app, port: 0, heartbeatMs: 60_000 });
  port = await gateway.start();
});

afterAll(async () => {
  await gateway.stop();
});

const auth = { authorization: 'Bearer ' + eventToken() };

async function replay(query: string, headers: Record<string, string> = auth) {
  const res = await fetch('http://127.0.0.1:' + port + '/v1/events/domain/replay' + query, {
    headers,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function publish(bus: InProcessEventBus, over: { propertyId?: string; type?: EventType } = {}) {
  return bus.publish(
    makeEvent(
      over.type ?? EventType.ServiceRequestCreated,
      {
        source: 'test',
        subject: 'r_1',
        tenantId: 't_1',
        propertyId: over.propertyId ?? 'p_1',
        traceId: 'tr_1',
      },
      { marker: true },
    ),
  );
}

describe('domain-event endpoints refuse unauthenticated callers', () => {
  it('rejects a missing token', async () => {
    const res = await replay('', {});
    expect(res.status).toBe(401);
  });

  it('rejects the admin token, which is a different grant', async () => {
    const res = await replay('', { authorization: 'Bearer gen_not_the_event_token' });
    expect(res.status).toBe(401);
  });

  it('accepts the event token', async () => {
    const res = await replay('?since=0');
    expect(res.status).toBe(200);
  });
});

describe('the journal gives a consumer a position it can resume from', () => {
  it('assigns monotonic sequence numbers in publication order', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus);
    await publish(bus);
    await publish(bus);
    await publish(bus);
    const seqs = journal.since(0).entries.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('returns only what follows the supplied position', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus);
    await publish(bus);
    await publish(bus);
    expect(journal.since(1).entries.map((e) => e.seq)).toEqual([2]);
    expect(journal.since(2).entries).toEqual([]);
  });

  it('filters by property, so one tenant cannot read another', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus);
    await publish(bus, { propertyId: 'p_mine' });
    await publish(bus, { propertyId: 'p_theirs' });
    const mine = journal.since(0, { propertyId: 'p_mine' }).entries;
    expect(mine).toHaveLength(1);
    expect(mine[0]!.event.propertyId).toBe('p_mine');
  });

  it('filters by event type', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus);
    await publish(bus, { type: EventType.ServiceRequestCreated });
    await publish(bus, { type: EventType.FnbOrderPlaced });
    const only = journal.since(0, { types: [EventType.FnbOrderPlaced] }).entries;
    expect(only).toHaveLength(1);
    expect(only[0]!.event.type).toBe(EventType.FnbOrderPlaced);
  });
});

describe('a consumer that fell too far behind is told, not quietly shortchanged', () => {
  it('reports how many events were evicted before its position', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus, { capacity: 3 });
    for (let i = 0; i < 6; i += 1) await publish(bus);

    // Consumer last saw seq 1. Events 2 and 3 have been evicted; 4, 5, 6 remain.
    const result = journal.since(1);
    expect(result.entries.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(result.missed, 'seq 2 and 3 are gone and the consumer must be told').toBe(2);
  });

  it('reports no gap to a consumer that is merely up to date', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus, { capacity: 3 });
    await publish(bus);
    await publish(bus);
    const result = journal.since(2);
    expect(result.entries).toEqual([]);
    expect(result.missed).toBe(0);
  });

  it('reports no gap to a first-time consumer starting from zero', async () => {
    const bus = new InProcessEventBus();
    const journal = new EventJournal(bus, { capacity: 2 });
    for (let i = 0; i < 5; i += 1) await publish(bus);
    // Starting at 0 means "whatever you have"; it is not a claim to have seen anything.
    expect(journal.since(0).missed).toBe(0);
  });
});

describe('the replay endpoint hands back a resumable cursor', () => {
  it('advances nextSince to the last delivered event, not the newest', async () => {
    const bus = app.bus;
    for (let i = 0; i < 4; i += 1) await publish(bus);
    const first = await replay('?since=0&limit=2');
    expect(first.body.events).toHaveLength(2);
    expect(first.body.more).toBe(true);

    const cursor = first.body.nextSince as number;
    const second = await replay('?since=' + cursor + '&limit=2');
    const seqs = (second.body.events as Array<{ seq: number }>).map((e) => e.seq);
    // No event is skipped and none is delivered twice.
    expect(Math.min(...seqs)).toBe(cursor + 1);
  });

  it('carries the envelope fields an external consumer needs to deduplicate', async () => {
    await publish(app.bus);
    const res = await replay('?since=0&limit=500');
    const events = res.body.events as Array<Record<string, unknown>>;
    const last = events[events.length - 1]!;
    for (const field of ['id', 'type', 'time', 'tenantId', 'propertyId', 'traceId', 'schemaVersion']) {
      expect(last[field], field + ' is missing from the delivered envelope').toBeDefined();
    }
  });
});

/**
 * Over the wire. The journal tests above prove the sequence logic; these prove the SSE frames
 * carry it, because `id:` is what makes a browser or EventSource client resume on its own.
 */
async function readFrames(
  path: string,
  headers: Record<string, string>,
  until: (text: string) => boolean,
  timeoutMs = 4000,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch('http://127.0.0.1:' + port + path, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Aborted on timeout; the assertion on `text` is the real result.
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return text;
}

describe('the SSE stream carries resumable positions', () => {
  it('frames each event with an id, type and envelope', async () => {
    // Subscribe from the current tip, so the frame under test is the live one rather than
    // whatever backlog earlier tests left in the journal.
    const tip = app.eventJournal.latestSeq;
    const seen = readFrames(
      '/v1/events/domain?since=' + tip,
      auth,
      (t) => t.includes('event: ' + EventType.EscalationRaised),
    );
    await new Promise((r) => setTimeout(r, 120));
    await publish(app.bus, { type: EventType.EscalationRaised });
    const text = await seen;

    expect(text).toContain('retry:');
    expect(text).toMatch(/\nid: \d+/);
    expect(text).toContain('event: ' + EventType.EscalationRaised);
    expect(text).toContain('"schemaVersion"');
  });

  it('replays from Last-Event-ID, which is how a reconnect catches up', async () => {
    await publish(app.bus, { type: EventType.FnbOrderPlaced });
    const before = app.eventJournal.latestSeq;
    await publish(app.bus, { type: EventType.FnbOrderPlaced });

    const text = await readFrames(
      '/v1/events/domain',
      { ...auth, 'last-event-id': String(before) },
      (t) => t.includes('id: ' + app.eventJournal.latestSeq),
    );
    // The event published after the consumer's position is replayed on connect.
    expect(text).toContain('id: ' + (before + 1));
  });

  it('announces a gap when the resume position has been evicted', async () => {
    // A tiny journal of its own, so this does not depend on the shared app's volume.
    const bus = new InProcessEventBus();
    const small = new EventJournal(bus, { capacity: 2 });
    const tight = new DeviceGateway({
      app: { ...app, bus, eventJournal: small },
      port: 0,
      heartbeatMs: 60_000,
    });
    const tightPort = await tight.start();
    try {
      for (let i = 0; i < 5; i += 1) await publish(bus);
      const res = await fetch(
        'http://127.0.0.1:' + tightPort + '/v1/events/domain?since=1',
        { headers: auth },
      );
      const reader = res.body!.getReader();
      const text = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      expect(text).toContain('woohoo.stream.gap');
      expect(text).toContain('"missed":2');
    } finally {
      await tight.stop();
    }
  });
});

describe('the checkout route is reachable and guarded', () => {
  it('refuses without the admin token', async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/v1/admin/stays/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd_412a' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a body that identifies no room', async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/v1/admin/stays/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken() },
      body: JSON.stringify({ stayRef: 'stay_1' }),
    });
    expect(res.status).toBe(400);
  });

  it('purges and emits the event when called properly', async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/v1/admin/stays/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken() },
      body: JSON.stringify({ deviceId: 'd_412a', stayRef: 'stay_xyz' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: string[]; stayRef: string };
    expect(body.stayRef).toBe('stay_xyz');
    expect(body.purged).toContain('stay');
    expect(
      app.eventJournal.since(0, { types: [EventType.StayCheckedOut] }).entries.length,
    ).toBeGreaterThan(0);
  });
});
