import { z } from 'zod';
import { EventType, makeEvent, type EventBus, type Scope } from '@woohoo/contracts';
import type { GuestService } from './guest.js';
import type { SessionStore } from './session.js';

/**
 * Stay teardown - integration review R7 and R8.
 *
 * `GuestService.onCheckout` existed, was documented as reliability-critical, and had no
 * caller: a purge with no trigger and an event with no producer. That is the worst shape for
 * a compliance control, because the code reads as though the guarantee is implemented.
 *
 * Checkout is owned by the PMS, which agentic does not integrate with directly, so this is an
 * inbound call from whoever does - the enterprise API - rather than something discovered here.
 * Two things have to happen in the same operation:
 *
 *  - Stay-scoped guest data is purged (§57). This is the lawful-basis boundary.
 *  - Conversation state is purged. Not for compliance but for correctness: a pending
 *    confirmation is an offer to spend the previous guest's money, and a `lastEntity` is how
 *    "turn it off" lands on a device the new guest never mentioned.
 *
 * The event is published after both, so a consumer that sees stay.checked_out knows the purge
 * already happened rather than that it was scheduled.
 */

/**
 * Inbound checkout body. Either identify the room by a device whose binding can be verified,
 * or name the room directly - a room with no enrolled device still has to be purgeable.
 */
export const StayCheckoutSchema = z
  .object({
    deviceId: z.string().min(1).optional(),
    roomId: z.string().min(1).optional(),
    propertyId: z.string().min(1).optional(),
    tenantId: z.string().min(1).optional(),
    stayRef: z.string().min(1).optional(),
    checkedOutAt: z.string().datetime().optional(),
  })
  .refine((v) => Boolean(v.deviceId) || Boolean(v.roomId && v.propertyId && v.tenantId), {
    message: 'Supply deviceId, or roomId with propertyId and tenantId',
  });
export type StayCheckout = z.infer<typeof StayCheckoutSchema>;

export interface CheckoutRequest {
  /** Opaque stay token, for correlation with the enterprise record. */
  stayRef?: string;
  /** ISO timestamp from the PMS, if the checkout is being replayed after the fact. */
  checkedOutAt?: string;
}

export interface CheckoutResult {
  roomId: string;
  stayRef: string;
  checkedOutAt: string;
  /** What was actually deleted, which is also the event's `purge` list. */
  purged: string[];
  /**
   * Whether a confirmation was outstanding when the room was released. Surfaced because an
   * order the previous guest never confirmed must not be attributable to the next one.
   */
  discardedPendingConfirmation: boolean;
  eventId: string;
}

export class CheckoutService {
  constructor(
    private readonly deps: {
      guest: GuestService;
      sessions: SessionStore;
      bus: EventBus;
    },
  ) {}

  async checkout(scope: Scope, req: CheckoutRequest = {}): Promise<CheckoutResult> {
    const session = this.deps.sessions.get(scope.roomId);
    const discardedPendingConfirmation = Boolean(session.pendingConfirmationToken);

    const purged: string[] = [];
    await this.deps.guest.onCheckout(scope);
    purged.push('stay', 'preferences:stay_scoped');

    this.deps.sessions.purge(scope.roomId);
    purged.push('session.history', 'session.pending_confirmation', 'session.last_entity');

    const checkedOutAt = req.checkedOutAt ?? new Date().toISOString();
    const stayRef = req.stayRef ?? 'stay_' + scope.roomId;

    const event = makeEvent(
      EventType.StayCheckedOut,
      {
        source: 'woohoo-core/checkout',
        subject: scope.roomId,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        // No turn produced this, so the trace is the checkout itself.
        traceId: 'checkout_' + scope.roomId + '_' + Date.parse(checkedOutAt).toString(36),
      },
      { stayRef, roomRef: scope.roomId, checkedOutAt, purge: purged },
    );
    await this.deps.bus.publish(event);

    return {
      roomId: scope.roomId,
      stayRef,
      checkedOutAt,
      purged,
      discardedPendingConfirmation,
      eventId: event.id,
    };
  }
}
