import { beforeEach, describe, expect, it } from 'vitest';
import { EventType, type Scope } from '@woohoo/contracts';
import { buildApp, type App } from '../app.js';

/**
 * Stay teardown - integration review R7, R8.
 *
 * Before this existed, `GuestService.onCheckout` was documented as reliability-critical and
 * had no caller. A purge that nothing invokes reads exactly like a purge that works, which is
 * why the test that matters here is not "the event fires" but "the data is actually gone and
 * the pending confirmation did not survive into the next stay".
 */

let app: App;
let scope: Scope;

beforeEach(async () => {
  app = await buildApp();
  scope = (await app.catalog.resolveDevice('d_412a')).scope;
});

describe('checking out purges the stay', () => {
  it('removes the stay record, so the next guest inherits nothing', async () => {
    const before = await app.guest.getRepository().getStay(scope.roomId);
    expect(before, 'the seeded property should have a stay to purge').toBeDefined();

    await app.checkout.checkout(scope);

    expect(await app.guest.getRepository().getStay(scope.roomId)).toBeUndefined();
  });

  it('discards a pending confirmation rather than leaving it for the next guest', async () => {
    const session = app.sessions.get(scope.roomId);
    session.pendingConfirmationToken = 'confirm_two_coffees_1840';
    app.sessions.save(session);

    const result = await app.checkout.checkout(scope);

    expect(result.discardedPendingConfirmation).toBe(true);
    // A confirmation token surviving checkout means the next guest can say "yes" and be
    // charged for an order the previous guest proposed.
    expect(app.sessions.get(scope.roomId).pendingConfirmationToken).toBeUndefined();
  });

  it('clears conversation history, so "turn it off" cannot resolve across stays', async () => {
    const session = app.sessions.get(scope.roomId);
    session.history.push({ role: 'guest', text: 'turn on the bedroom light', at: Date.now() });
    session.lastEntity = { type: 'device', id: 'lighting', label: 'bedroom light', turnIndex: 1 };
    app.sessions.save(session);

    await app.checkout.checkout(scope);

    const after = app.sessions.get(scope.roomId);
    expect(after.history).toEqual([]);
    expect(after.lastEntity).toBeUndefined();
  });

  it('reports a pending confirmation as absent when there was none', async () => {
    const result = await app.checkout.checkout(scope);
    expect(result.discardedPendingConfirmation).toBe(false);
  });
});

describe('checkout publishes the event the purge contract depends on', () => {
  it('publishes stay.checked_out', async () => {
    await app.checkout.checkout(scope);
    const published = app.bus.published(EventType.StayCheckedOut);
    expect(published).toHaveLength(1);
  });

  it('scopes the event so an enterprise consumer can filter it', async () => {
    await app.checkout.checkout(scope, { stayRef: 'stay_abc' });
    const e = app.bus.published(EventType.StayCheckedOut)[0]!;
    expect(e.tenantId).toBe(scope.tenantId);
    expect(e.propertyId).toBe(scope.propertyId);
    expect(e.schemaVersion).toBeDefined();
    expect(e.id).toMatch(/^evt_/);
  });

  it('lists what was purged, so a consumer can audit the deletion', async () => {
    const result = await app.checkout.checkout(scope);
    const e = app.bus.published(EventType.StayCheckedOut)[0]!;
    const data = e.data as { purge: string[]; stayRef: string; roomRef: string };
    expect(data.purge).toEqual(result.purged);
    expect(data.purge).toContain('stay');
    expect(data.purge).toContain('session.pending_confirmation');
    expect(data.roomRef).toBe(scope.roomId);
  });

  it('reaches the journal, so it is externally deliverable rather than in-process only', async () => {
    await app.checkout.checkout(scope);
    const delivered = app.eventJournal
      .since(0, { types: [EventType.StayCheckedOut] })
      .entries;
    expect(delivered, 'stay.checked_out must be consumable off-process').toHaveLength(1);
  });

  it('publishes after the purge, so a consumer seeing it can trust the deletion happened', async () => {
    let stayAtPublishTime: unknown = 'not checked';
    app.bus.subscribe(EventType.StayCheckedOut, async () => {
      stayAtPublishTime = await app.guest.getRepository().getStay(scope.roomId);
    });
    await app.checkout.checkout(scope);
    expect(stayAtPublishTime).toBeUndefined();
  });
});
