import { EventType, type EventBus, type EventEnvelope } from '@woohoo/contracts';

/**
 * Replayable sequence over the event bus - integration review R7.
 *
 * The bus fans out to in-process handlers and forgets. That is enough for the console's live
 * feed and wrong for an enterprise consumer, whose actual question is "what happened while I
 * was disconnected". Answering it needs three things the bus does not have: a monotonic
 * position, retention, and an honest signal when retention was not enough.
 *
 * The third matters most. A consumer that reconnects and is handed whatever happens to still
 * be in memory, with no indication that a housekeeping request fell out of the buffer, is
 * worse than one that is told it is behind: the first silently loses a guest's towels, the
 * second can reconcile. So `since` reports what it could not supply rather than returning a
 * best-effort list.
 *
 * In-memory retention is a single-replica Phase 1 position, documented as such. Durable
 * delivery is a broker (NATS JetStream, then EventBridge + SQS) and the `seq` contract here
 * is deliberately the one a broker can take over without consumers changing.
 */

export interface JournalEntry {
  /** Monotonic from 1, never reused, assigned in publication order. */
  seq: number;
  event: EventEnvelope<unknown>;
}

export interface EventScope {
  tenantId?: string;
  propertyId?: string;
  types?: EventType[];
}

export interface ReplayResult {
  entries: JournalEntry[];
  /**
   * Events that were published after the consumer's position but had already been evicted -
   * unrecoverable from this journal. Non-zero means the consumer must reconcile from the
   * authoritative store rather than trust the stream.
   */
  missed: number;
  /** Position to resume from; a consumer stores this, not a timestamp. */
  latestSeq: number;
}

function matches(event: EventEnvelope<unknown>, scope?: EventScope): boolean {
  if (!scope) return true;
  if (scope.tenantId && event.tenantId !== scope.tenantId) return false;
  if (scope.propertyId && event.propertyId !== scope.propertyId) return false;
  if (scope.types?.length && !scope.types.includes(event.type)) return false;
  return true;
}

export class EventJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly listeners = new Set<(e: JournalEntry) => void>();
  private readonly capacity: number;
  private seq = 0;
  /** Oldest seq still retained, so eviction is detectable rather than invisible. */
  private oldest = 1;

  constructor(bus: EventBus, opts: { capacity?: number } = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 1_000);
    // Every declared type, not the five currently emitted: a type that starts being published
    // later should appear on the stream without anyone remembering to register it here.
    for (const type of Object.values(EventType)) {
      bus.subscribe(type, (e) => this.append(e as EventEnvelope<unknown>));
    }
  }

  private append(event: EventEnvelope<unknown>): void {
    const entry: JournalEntry = { seq: ++this.seq, event };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.shift();
      this.oldest = this.entries[0]?.seq ?? this.seq;
    }
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch (err) {
        // Same rule as the bus: a broken consumer must not affect publication.
        console.error('[event-journal] listener failed:', err);
      }
    }
  }

  /** Events after `afterSeq` that match `scope`, plus what could not be supplied. */
  since(afterSeq: number, scope?: EventScope): ReplayResult {
    const from = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0;
    // Only count a gap for positions the consumer actually had not seen.
    const missed = from > 0 && from < this.oldest - 1 ? this.oldest - 1 - from : 0;
    return {
      entries: this.entries.filter((e) => e.seq > from && matches(e.event, scope)),
      missed,
      latestSeq: this.seq,
    };
  }

  /** Live tail. Returns an unsubscribe, and only fires for in-scope events. */
  listen(onEntry: (e: JournalEntry) => void, scope?: EventScope): () => void {
    const wrapped = (e: JournalEntry) => {
      if (matches(e.event, scope)) onEntry(e);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  get latestSeq(): number {
    return this.seq;
  }

  get oldestRetainedSeq(): number {
    return this.entries[0]?.seq ?? this.seq + 1;
  }

  get retained(): number {
    return this.entries.length;
  }
}
