import type { EventBus, EventEnvelope, EventType } from '@woohoo/contracts';

/**
 * In-process event bus — architecture doc §38.
 *
 * Phase 1 substitute for NATS JetStream; Phase 2 is EventBridge + SQS. Handlers are isolated
 * so one bad consumer cannot break publication: nothing on the async fan-out path is allowed
 * to affect the guest-facing turn.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, Array<(e: EventEnvelope<never>) => unknown>>();
  private readonly log: EventEnvelope<unknown>[] = [];

  async publish<T>(e: EventEnvelope<T>): Promise<void> {
    this.log.push(e);
    for (const h of this.handlers.get(e.type) ?? []) {
      try {
        await h(e as never);
      } catch (err) {
        // Swallow deliberately. A failing subscriber is an operational problem, not a reason
        // for the guest's turn to fail.
        console.error(`[event-bus] handler for ${e.type} failed:`, err);
      }
    }
  }

  subscribe<T>(type: EventType, handler: (e: EventEnvelope<T>) => void | Promise<void>): void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler as (e: EventEnvelope<never>) => unknown);
  }

  /** Test/eval affordance — the durable log lives in the audit store, not here. */
  published(type?: EventType): EventEnvelope<unknown>[] {
    return type ? this.log.filter((e) => e.type === type) : [...this.log];
  }

  clear(): void {
    this.log.length = 0;
  }
}
