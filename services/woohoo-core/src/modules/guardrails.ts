import type { SerialisedSpan } from '@woohoo/otel';
import type { ExecutedCall } from '../agent/runtime.js';

/**
 * Guardrail reporting — makes the invisible controls visible.
 *
 * The system's safety model is a chain of controls at different stages (architecture doc
 * §46). Most of them succeed by producing NOTHING: a tool that was never offered, a field
 * that was stripped, a room that could not be addressed. That is exactly what makes them
 * hard to trust — there is no evidence they ran.
 *
 * This reconstructs, per turn, which control was active at each stage and what it did, so
 * an operator or a reviewer can see the chain rather than take it on faith.
 */

export type GuardrailOutcome = 'passed' | 'blocked' | 'modified' | 'not_applicable';

export interface GuardrailReport {
  /** Stage in the pipeline, in execution order. */
  stage: string;
  /** Human name of the control. */
  control: string;
  outcome: GuardrailOutcome;
  /** What it actually did on THIS turn. */
  detail: string;
  /** Architecture doc reference, so a reviewer can find the reasoning. */
  ref: string;
}

export interface GuardrailInputs {
  spans: SerialisedSpan[];
  calls: ExecutedCall[];
  toolsOffered: number;
  toolsTotal: number;
  transcriptRedactions: Record<string, number>;
  outputViolations: string[];
  lane: string;
  degradationLevel: number;
}

export function reportGuardrails(i: GuardrailInputs): GuardrailReport[] {
  const out: GuardrailReport[] = [];
  const span = (name: string) => i.spans.find((s) => s.name === name);

  // ── 1. Identity and scope ────────────────────────────────────────────────
  out.push({
    stage: 'identity',
    control: 'Ambient scope',
    outcome: 'passed',
    detail:
      'Tenant, property and room derived from the device identity. No message or tool ' +
      'argument can supply a room, so another room is not addressable.',
    ref: 'P2 · §34.1',
  });

  // ── 2. Redaction ─────────────────────────────────────────────────────────
  const found = Object.entries(i.transcriptRedactions);
  out.push({
    stage: 'redaction',
    control: 'PII redaction',
    outcome: found.length ? 'modified' : 'passed',
    detail: found.length
      ? `Masked before the model and the audit store: ${found.map(([k, n]) => `${k}×${n}`).join(', ')}.`
      : 'No PII detected. Card numbers are blocked on every path regardless.',
    ref: '§57.2',
  });

  // ── 3. Capability filtering ──────────────────────────────────────────────
  const withheld = i.toolsTotal - i.toolsOffered;
  out.push({
    stage: 'tool-surface',
    control: 'Capability filtering',
    outcome: withheld > 0 ? 'modified' : 'passed',
    detail:
      withheld > 0
        ? `${i.toolsOffered} of ${i.toolsTotal} tools offered. ${withheld} withheld because this ` +
          `room lacks the capability — the model cannot propose what it was never given.`
        : `All ${i.toolsOffered} tools available in this room.`,
    ref: '§33',
  });

  // ── 4. Scope stripping ───────────────────────────────────────────────────
  const stripped = i.spans.filter((s) => s.name === 'gateway.scope_stripped');
  out.push({
    stage: 'gateway',
    control: 'Scope stripping',
    outcome: stripped.length ? 'blocked' : 'not_applicable',
    detail: stripped.length
      ? `Model supplied scope fields (${stripped.map((s) => s.attrs.fields).join('; ')}). ` +
        `Stripped, not validated — the real scope was injected server-side.`
      : 'Model supplied no scope fields on this turn.',
    ref: '§34.1',
  });

  // ── 5. Schema validation ─────────────────────────────────────────────────
  const invalid = i.calls.filter((c) => c.verdict.ruleId === 'gateway.invalid_argument');
  out.push({
    stage: 'gateway',
    control: 'Strict schema validation',
    outcome: invalid.length ? 'blocked' : 'passed',
    detail: invalid.length
      ? `Rejected ${invalid.length} call(s): ${invalid.map((c) => c.tool).join(', ')}. Unknown ` +
        `tools and invented fields fail loudly rather than being ignored.`
      : 'All proposed arguments matched their schema.',
    ref: '§32.1',
  });

  // ── 6. Policy Decision Point ─────────────────────────────────────────────
  const denied = i.calls.filter((c) => c.verdict.kind === 'DENY');
  const confirmed = i.calls.filter((c) => c.verdict.kind === 'CONFIRM');
  const escalated = i.calls.filter((c) => c.verdict.kind === 'ESCALATE');
  const allowed = i.calls.filter((c) => c.verdict.kind === 'ALLOW');

  let pdpOutcome: GuardrailOutcome = 'not_applicable';
  if (denied.length || escalated.length) pdpOutcome = 'blocked';
  else if (confirmed.length) pdpOutcome = 'modified';
  else if (allowed.length) pdpOutcome = 'passed';

  const parts: string[] = [];
  if (allowed.length) parts.push(`${allowed.length} allowed`);
  if (confirmed.length) parts.push(`${confirmed.length} held for confirmation`);
  if (denied.length) parts.push(`${denied.length} denied (${denied.map((c) => c.verdict.ruleId).join(', ')})`);
  if (escalated.length) parts.push(`${escalated.length} escalated to a human`);

  out.push({
    stage: 'policy',
    control: 'Policy Decision Point',
    outcome: pdpOutcome,
    detail: parts.length
      ? `${parts.join('; ')}. The PDP reads only structured data — never the guest's words — ` +
        `so nothing in the utterance can change what is permitted.`
      : 'No tool calls proposed, so nothing required authorisation.',
    ref: 'P1 · §44',
  });

  // ── 7. Verify-read ───────────────────────────────────────────────────────
  // `ok` only means the tool call itself did not error. A change the head-end acknowledged
  // but never made comes back ok:true with status 'pending', so counting ok alone reported a
  // silent failure as "read back and confirmed" — the exact false confirmation §37 exists to
  // prevent. The status inside the result is the thing that matters.
  const statusOf = (c: (typeof i.calls)[number]) =>
    (c.result?.ok ? (c.result.value as { status?: string } | undefined)?.status : undefined);

  const applied = i.calls.filter((c) => statusOf(c) === 'applied');
  const pending = i.calls.filter(
    (c) => statusOf(c) === 'pending' || (c.verdict.kind === 'ALLOW' && !c.result?.ok),
  );
  out.push({
    stage: 'execution',
    control: 'Verify-read',
    outcome: pending.length ? 'modified' : applied.length ? 'passed' : 'not_applicable',
    detail: pending.length
      ? `${pending.length} call(s) authorised but not observed to take effect — reported as ` +
        `pending, never as done.`
      : applied.length
        ? `${applied.length} change(s) read back and confirmed before being reported to the guest.`
        : 'No state-changing calls on this turn.',
    ref: '§37',
  });

  // ── 8. Output guard ──────────────────────────────────────────────────────
  out.push({
    stage: 'output',
    control: 'Output guard',
    outcome: i.outputViolations.length ? 'blocked' : 'passed',
    detail: i.outputViolations.length
      ? `Rewrote the reply: ${i.outputViolations.join(', ')}.`
      : 'No other-room references, prompt leakage or over-length reply.',
    ref: '§46 layer 5',
  });

  // ── 9. Degradation ───────────────────────────────────────────────────────
  if (i.lane === 'degraded' || i.degradationLevel > 0) {
    const llmError = i.spans.find((s) => s.attrs.llm_error)?.attrs.llm_error;
    out.push({
      stage: 'resilience',
      control: 'Degradation ladder',
      outcome: 'modified',
      detail: llmError
        ? `Upstream unavailable (${String(llmError).slice(0, 120)}). Reply names what still ` +
          `works rather than reporting a failure.`
        : `Running at degradation level ${i.degradationLevel}; capability reduced deliberately.`,
      ref: '§29 · §68',
    });
  }

  return out;
}
