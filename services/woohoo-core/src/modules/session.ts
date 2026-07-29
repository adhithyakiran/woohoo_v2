/**
 * Conversation session — architecture doc §28.
 *
 * TTL is deliberately short. A guest returning after two hours is starting fresh, and stale
 * context is how a "turn it off" lands on the wrong device. Nothing durable lives here: losing
 * this store costs one conversation, not one fact.
 */

export interface SessionState {
  roomId: string;
  history: Array<{ role: 'guest' | 'assistant'; text: string; at: number }>;
  /** Explicitly tracked rather than left for the model to infer from history (§28.1). */
  lastEntity?: { type: string; id: string; label: string; turnIndex: number };
  pendingClarification?: string;
  pendingConfirmationToken?: string;
  turnIndex: number;
  recentActuations: Array<{ tool: string; at: number }>;
  turnTimestamps: number[];
  updatedAt: number;
}

const IDLE_TTL_MS = 30 * 60_000;
const MAX_HISTORY = 6;

export class SessionStore {
  private readonly rows = new Map<string, SessionState>();

  constructor(private readonly ttlMs = IDLE_TTL_MS) {}

  get(roomId: string, now = Date.now()): SessionState {
    const existing = this.rows.get(roomId);
    if (existing && now - existing.updatedAt < this.ttlMs) return existing;
    const fresh: SessionState = {
      roomId,
      history: [],
      turnIndex: 0,
      recentActuations: [],
      turnTimestamps: [],
      updatedAt: now,
    };
    this.rows.set(roomId, fresh);
    return fresh;
  }

  save(s: SessionState, now = Date.now()): void {
    s.updatedAt = now;
    s.history = s.history.slice(-MAX_HISTORY);
    // Keep only what the PDP's rate rules actually look at.
    const hourAgo = now - 3_600_000;
    s.recentActuations = s.recentActuations.filter((a) => a.at >= hourAgo).slice(-64);
    s.turnTimestamps = s.turnTimestamps.filter((t) => t >= hourAgo).slice(-128);
    this.rows.set(s.roomId, s);
  }

  /** Called on stay.checked_out — the deletion trigger for stay-scoped data (§57). */
  purge(roomId: string): void {
    this.rows.delete(roomId);
  }

  turnsThisHour(roomId: string, now = Date.now()): number {
    const s = this.rows.get(roomId);
    if (!s) return 0;
    const hourAgo = now - 3_600_000;
    return s.turnTimestamps.filter((t) => t >= hourAgo).length;
  }

  size(): number {
    return this.rows.size;
  }
}
