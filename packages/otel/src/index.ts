/**
 * Minimal in-process tracer — architecture doc §70.
 *
 * Deliberately dependency-free so the Docker-less dev path works. The span shape follows the
 * OpenTelemetry GenAI semantic conventions closely enough that swapping in the real SDK is a
 * constructor change: one trace_id from wake word to playback, W3C traceparent on every hop.
 */

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs?: number;
  attrs: Record<string, unknown>;
  status: 'ok' | 'error';
  error?: string;
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, unknown>): ActiveSpan;
  spans(): readonly Span[];
  traceId: string;
}

export interface ActiveSpan {
  set(key: string, value: unknown): void;
  setAll(attrs: Record<string, unknown>): void;
  fail(err: unknown): void;
  end(): number;
  readonly span: Span;
}

let counter = 0;
const id = (n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

export function newTraceId(): string {
  return id(32);
}

export function createTracer(traceId = newTraceId()): Tracer {
  const collected: Span[] = [];
  const stack: Span[] = [];

  return {
    traceId,
    spans: () => collected,
    startSpan(name, attrs = {}) {
      const span: Span = {
        name,
        traceId,
        spanId: `${id(12)}${(counter++ % 16).toString(16)}`,
        parentSpanId: stack.at(-1)?.spanId,
        startMs: performance.now(),
        attrs: { ...attrs },
        status: 'ok',
      };
      collected.push(span);
      stack.push(span);
      let ended = false;
      const finish = () => {
        if (ended) return span.endMs! - span.startMs;
        ended = true;
        span.endMs = performance.now();
        const i = stack.lastIndexOf(span);
        if (i >= 0) stack.splice(i, 1);
        return span.endMs - span.startMs;
      };
      return {
        span,
        set: (k, v) => void (span.attrs[k] = v),
        setAll: (a) => void Object.assign(span.attrs, a),
        fail: (err) => {
          span.status = 'error';
          span.error = err instanceof Error ? err.message : String(err);
        },
        end: finish,
      };
    },
  };
}

export function durationOf(s: Span): number {
  return s.endMs === undefined ? 0 : Math.round(s.endMs - s.startMs);
}

export interface SerialisedSpan {
  name: string;
  ms: number;
  depth: number;
  status: 'ok' | 'error';
  error?: string;
  attrs: Record<string, unknown>;
}

/**
 * Flatten a trace for transport to a UI or a log.
 *
 * Derived from the spans themselves rather than hand-maintained, so it stays accurate as
 * stages are added — a hand-written pipeline list silently goes stale the first time
 * someone inserts a step.
 */
export function serialiseSpans(t: Tracer): SerialisedSpan[] {
  const byParent = new Map<string | undefined, Span[]>();
  for (const s of t.spans()) {
    const k = s.parentSpanId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(s);
  }
  const out: SerialisedSpan[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      out.push({
        name: s.name,
        ms: durationOf(s),
        depth,
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
        attrs: s.attrs,
      });
      walk(s.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

/** Render a trace as an indented tree — used by the device simulator and eval runner. */
export function renderTrace(t: Tracer): string {
  const byParent = new Map<string | undefined, Span[]>();
  for (const s of t.spans()) {
    const k = s.parentSpanId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(s);
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      const pad = '  '.repeat(depth);
      const ms = String(durationOf(s)).padStart(5);
      const mark = s.status === 'error' ? ' !' : '  ';
      const attrs = Object.entries(s.attrs)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' ');
      lines.push(`${ms}ms${mark}${pad}${s.name}${attrs ? '  ' + attrs : ''}`);
      walk(s.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines.join('\n');
}

// ── vendor call log ─────────────────────────────────────────────────────────
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One HTTP call to a property head-end (INNCOM, Interel, …).
 *
 * These are the calls an operator actually needs when a guest says "it didn't work": the
 * object that was addressed, what was asked for, what the controller said, and what was
 * observed afterwards. Capability-level logging hides exactly the layer that fails.
 */
export interface VendorCall {
  vendor: string;
  method: string;
  url: string;
  /** Vendor object/register address — never the hotel room number (§39.2). */
  objectId?: string;
  capability?: string;
  zone?: string;
  requested?: unknown;
  observed?: unknown;
  status: number;
  ok: boolean;
  ms: number;
  /** Set when the controller acknowledged but nothing changed, and similar traps. */
  note?: string;
}

const vendorLog = new AsyncLocalStorage<VendorCall[]>();

/**
 * Collect vendor calls made anywhere inside `fn` into `log`.
 *
 * AsyncLocalStorage rather than a shared array because turns run concurrently: a module-level
 * buffer would attribute one room's calls to another guest's turn.
 */
export function withVendorLog<T>(log: VendorCall[], fn: () => Promise<T>): Promise<T> {
  return vendorLog.run(log, fn);
}

/** No-op outside a turn, so adapters can be used from scripts and tests without ceremony. */
export function recordVendorCall(call: VendorCall): void {
  vendorLog.getStore()?.push(call);
}
