import { createHash } from 'node:crypto';
import type { RiskTier, TurnContext } from '@woohoo/contracts';

/**
 * Audit — architecture doc §7, §12 (D18), §57, §70.1.
 *
 * The record that resolves billing disputes and answers "why did it do that". Deliberately a
 * different artefact from the trace: the trace is sampled and short-lived and exists for
 * engineers; this is complete, immutable and retained for 13 months.
 *
 * The load-bearing detail from §7: policy verdicts are appended BEFORE execution. If the
 * process dies mid-turn the record still shows what was authorised. Log-after-the-fact loses
 * exactly the records you need most.
 */

export interface AuditToolEntry {
  tool: string;
  tier: RiskTier;
  verdict: string;
  ruleId: string;
  /** Recorded at authorisation time; updated once execution returns. */
  status: 'authorised' | 'applied' | 'pending' | 'failed' | 'denied' | 'escalated';
  argsDigest: string;
  latencyMs?: number;
  annotations?: Record<string, unknown>;
}

export interface TurnRecord {
  turnId: string;
  traceId: string;
  tenantId: string;
  propertyId: string;
  roomId: string;
  deviceId: string;
  startedAt: string;
  lane: string;
  language: string;
  degradationLevel: number;
  /** Redacted before it ever reaches here (§57.2). Raw audio is never written anywhere. */
  transcriptRedacted: string;
  /** Digest of the assembled context, not the context itself. */
  contextDigest: string;
  promptVersion?: string;
  model?: string;
  reasoningSummary?: string;
  toolCalls: AuditToolEntry[];
  responseText?: string;
  outcome: 'success' | 'partial' | 'failed' | 'refused' | 'escalated';
  escalated: boolean;
  totalMs?: number;
  costUsd?: number;
  sealedAt?: string;
}

export interface AuditSink {
  write(record: TurnRecord): Promise<void>;
  /** Read back for the eval replay harness and for dispute resolution. */
  list(filter?: { roomId?: string; propertyId?: string }): Promise<TurnRecord[]>;
}

/**
 * In-memory sink. The production sink writes to S3 with Object Lock in compliance mode, which
 * is what makes "immutable" a technical claim rather than a policy claim (§36).
 */
export class InMemoryAuditSink implements AuditSink {
  private readonly rows: TurnRecord[] = [];
  async write(record: TurnRecord) {
    // Frozen on write so a later mutation of the caller's object cannot rewrite history.
    this.rows.push(structuredClone(record));
  }
  async list(filter?: { roomId?: string; propertyId?: string }) {
    return this.rows.filter(
      (r) =>
        (!filter?.roomId || r.roomId === filter.roomId) &&
        (!filter?.propertyId || r.propertyId === filter.propertyId),
    );
  }
  clear() {
    this.rows.length = 0;
  }
}

export function digest(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
}

/** Builds a turn record incrementally so verdicts land before execution results. */
export class TurnRecorder {
  private readonly record: TurnRecord;

  constructor(ctx: TurnContext, transcriptRedacted: string, lane: string) {
    this.record = {
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      tenantId: ctx.scope.tenantId,
      propertyId: ctx.scope.propertyId,
      roomId: ctx.scope.roomId,
      deviceId: ctx.scope.deviceId,
      startedAt: new Date(ctx.startedAt).toISOString(),
      lane,
      language: ctx.language,
      degradationLevel: ctx.degradationLevel,
      transcriptRedacted,
      contextDigest: '',
      toolCalls: [],
      outcome: 'success',
      escalated: false,
    };
  }

  setContext(digestValue: string, promptVersion?: string, model?: string): void {
    this.record.contextDigest = digestValue;
    this.record.promptVersion = promptVersion;
    this.record.model = model;
  }

  setLane(lane: string): void {
    this.record.lane = lane;
  }

  setReasoning(summary: string): void {
    this.record.reasoningSummary = summary;
  }

  /** Called at authorisation time, before the tool runs. */
  authorised(entry: Omit<AuditToolEntry, 'status'> & { status?: AuditToolEntry['status'] }): number {
    this.record.toolCalls.push({ status: 'authorised', ...entry });
    return this.record.toolCalls.length - 1;
  }

  completed(index: number, status: AuditToolEntry['status'], latencyMs: number): void {
    const e = this.record.toolCalls[index];
    if (!e) return;
    e.status = status;
    e.latencyMs = latencyMs;
  }

  setResponse(text: string): void {
    this.record.responseText = text;
  }

  setOutcome(outcome: TurnRecord['outcome'], escalated = false): void {
    this.record.outcome = outcome;
    this.record.escalated = escalated || this.record.escalated;
  }

  setCost(costUsd: number): void {
    this.record.costUsd = costUsd;
  }

  seal(totalMs: number): TurnRecord {
    this.record.totalMs = totalMs;
    this.record.sealedAt = new Date().toISOString();
    return this.record;
  }

  current(): TurnRecord {
    return this.record;
  }
}
