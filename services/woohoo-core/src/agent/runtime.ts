import {
  getTool,
  type Money,
  type PropertyConfig,
  type ToolDefinition,
  type ToolProposal,
  type ToolResult,
  type TurnContext,
} from '@woohoo/contracts';
import type { PolicyDecisionPoint, PolicyInputs, Verdict } from '@woohoo/policy';
import type { Tracer } from '@woohoo/otel';
import { assembleContext, renderToolResult, type ContextInputs } from './context.js';
import { estimateCostUsd, LlmUnavailableError, type LlmProvider } from './llm.js';
import { McpGateway } from '../modules/mcp-gateway.js';
import type { TurnRecorder } from '../modules/audit.js';

/**
 * Agent runtime — architecture doc §27.
 *
 * The loop is deliberately bounded: an agent still looping after 8 seconds has failed,
 * whatever it eventually returns. Every proposal passes the PDP before execution, and every
 * verdict is written to the audit record BEFORE the tool runs, so a crash mid-turn still
 * leaves evidence of what was authorised (§7).
 */

export const LOOP_LIMITS = {
  maxRounds: 3,
  maxToolCalls: 6,
  wallClockMs: 8_000,
  softTimeoutMs: 2_500,
  maxOutputTokens: 600,
  thinkingBudget: 0,
} as const;

export interface AgentDeps {
  llm: LlmProvider;
  gateway: McpGateway;
  pdp: PolicyDecisionPoint;
  /** Estimates the monetary effect of a proposal. Never the model's own number (§ fnb.price). */
  priceProposal(p: ToolProposal, ctx: TurnContext): Promise<Money | undefined>;
  /** Rebuilt each round so duplicate and rate checks see the effects of earlier calls. */
  policyInputs(ctx: TurnContext): Promise<PolicyInputs>;
}

export interface AgentInput extends Omit<ContextInputs, 'tools'> {
  tools: ToolDefinition[];
  property: PropertyConfig;
  recorder: TurnRecorder;
  tracer: Tracer;
}

export interface ExecutedCall {
  tool: string;
  /** Scoped, validated arguments. Carried so the orchestrator can act on a verdict it did not
   *  execute — notably ESCALATE, where the platform performs the handoff rather than the agent. */
  args: Record<string, unknown>;
  verdict: Verdict;
  result?: ToolResult;
}

export interface AgentOutput {
  text: string;
  calls: ExecutedCall[];
  escalated: boolean;
  /** Set when a T3 action is awaiting a spoken confirmation in the next turn. */
  pendingConfirmationToken?: string;
  costUsd: number;
  model: string;
  degraded: boolean;
}

export class AgentRuntime {
  constructor(private readonly deps: AgentDeps) {}

  async run(input: AgentInput): Promise<AgentOutput> {
    const { ctx, recorder, tracer } = input;
    const deadline = Date.now() + LOOP_LIMITS.wallClockMs;
    const executed: ExecutedCall[] = [];
    let costUsd = 0;
    let escalated = false;
    let pendingConfirmationToken: string | undefined;
    let replyText = '';

    const assembled = assembleContext(input);
    recorder.setContext(String(assembled.estimatedTokens), assembled.promptVersion, this.deps.llm.model);

    let toolResults: Array<{ tool: string; ok: boolean; content: string }> | undefined;

    for (let round = 0; round < LOOP_LIMITS.maxRounds; round++) {
      if (Date.now() > deadline) break;

      const llmSpan = tracer.startSpan('llm.generate', {
        model: this.deps.llm.model,
        round,
        prompt_version: assembled.promptVersion,
      });

      let response;
      try {
        response = await this.deps.llm.generate({
          system: assembled.system,
          user: assembled.user,
          tools: input.tools,
          toolResults,
          maxOutputTokens: LOOP_LIMITS.maxOutputTokens,
          thinkingBudget: LOOP_LIMITS.thinkingBudget,
          temperature: 0.2,
        });
      } catch (err) {
        llmSpan.fail(err);
        llmSpan.end();
        if (err instanceof LlmUnavailableError) throw err;
        throw new LlmUnavailableError(String(err));
      }

      const turnCost = estimateCostUsd(response);
      costUsd += turnCost;
      llmSpan.setAll({
        tokens_in: response.usage.tokensIn,
        tokens_cached: response.usage.tokensCached,
        tokens_out: response.usage.tokensOut,
        cost_usd: Number(turnCost.toFixed(6)),
        tool_calls: response.toolCalls.length,
        finish_reason: response.finishReason,
      });
      llmSpan.end();

      if (response.reasoningSummary) recorder.setReasoning(response.reasoningSummary);
      if (response.text) replyText = response.text;

      if (!response.toolCalls.length) break;

      const results: Array<{ tool: string; ok: boolean; content: string }> = [];

      for (const call of response.toolCalls) {
        if (executed.length >= LOOP_LIMITS.maxToolCalls) break;
        const outcome = await this.executeOne({ tool: call.tool, args: call.args }, input);
        executed.push(outcome);

        if (outcome.verdict.kind === 'ESCALATE') escalated = true;
        if (outcome.verdict.kind === 'CONFIRM') {
          pendingConfirmationToken = outcome.verdict.confirmation?.token;
        }

        const def = getTool(call.tool);
        results.push({
          tool: call.tool,
          ok: Boolean(outcome.result?.ok),
          content: outcome.result?.ok
            ? renderToolResult(
                call.tool,
                true,
                outcome.result.value,
                Boolean(def?.meta.untrustedResult),
              )
            : JSON.stringify(outcome.result?.error ?? { error: outcome.verdict.kind, detail: outcome.verdict.reason }),
        });
      }

      toolResults = results;

      // A confirmation request or an escalation ends the turn here: the guest must answer, or
      // a human must act. Continuing to reason past either is how agents talk themselves into
      // executing something they were told to hold.
      if (pendingConfirmationToken || escalated) break;
    }

    return {
      text: replyText,
      calls: executed,
      escalated,
      pendingConfirmationToken,
      costUsd,
      model: this.deps.llm.model,
      degraded: false,
    };
  }

  /**
   * Validate → price → authorise → record → execute.
   *
   * The ordering is the point. The PDP sees canonical arguments and a platform-computed charge,
   * and the audit entry exists before anything reaches the world.
   */
  async executeOne(proposal: ToolProposal, input: AgentInput): Promise<ExecutedCall> {
    const { ctx, recorder, tracer } = input;

    const validation = input.tools.some((t) => t.name === proposal.tool)
      ? this.deps.gateway.validate(proposal)
      : ({
          ok: false as const,
          error: {
            error: 'NOT_AVAILABLE' as const,
            detail: `${proposal.tool} is not available in this room.`,
            suggestion: 'Use only the tools listed for this room.',
            retryable: false,
          },
        });

    if (!validation.ok) {
      const verdict: Verdict = {
        kind: 'DENY',
        tier: getTool(proposal.tool)?.meta.tier ?? 'T5',
        ruleId: 'gateway.invalid_argument',
        reason: validation.error.detail,
      };
      recorder.authorised({
        tool: proposal.tool,
        tier: verdict.tier,
        verdict: verdict.kind,
        ruleId: verdict.ruleId,
        argsDigest: '',
        status: 'denied',
      });
      return {
        tool: proposal.tool,
        args: {},
        verdict,
        result: { ok: false, error: validation.error, latencyMs: 0 },
      };
    }

    // Scope stripping happens here, before policy sees anything (§34.1).
    const stripped = this.deps.gateway.strippedFields(proposal);
    const scoped = this.deps.gateway.scopeCall({ tool: proposal.tool, args: validation.args }, ctx);
    if (stripped.length) {
      tracer.startSpan('gateway.scope_stripped', { tool: proposal.tool, fields: stripped.join(',') }).end();
    }

    const estimatedCharge = await this.deps.priceProposal(
      { tool: proposal.tool, args: scoped.args },
      ctx,
    );

    const policySpan = tracer.startSpan('policy.decide', { tool: proposal.tool });
    const policyInputs = await this.deps.policyInputs(ctx);
    const verdict = this.deps.pdp.decide(
      { tool: proposal.tool, args: scoped.args, estimatedCharge },
      policyInputs,
    );
    policySpan.setAll({ tier: verdict.tier, verdict: verdict.kind, rule_id: verdict.ruleId });
    policySpan.end();

    // Written BEFORE execution — see §7.
    const auditIndex = recorder.authorised({
      tool: proposal.tool,
      tier: verdict.tier,
      verdict: verdict.kind,
      ruleId: verdict.ruleId,
      argsDigest: scoped.idempotencyKey.slice(0, 16),
      annotations: verdict.annotations,
    });

    if (verdict.kind !== 'ALLOW') {
      recorder.completed(auditIndex, verdict.kind === 'ESCALATE' ? 'escalated' : 'denied', 0);
      return {
        tool: proposal.tool,
        args: scoped.args,
        verdict,
        result: {
          ok: false,
          error: {
            error: verdict.kind === 'CONFIRM' ? 'NEEDS_CONFIRMATION' : 'NOT_PERMITTED',
            detail: verdict.reason,
            suggestion:
              verdict.kind === 'CONFIRM'
                ? 'State the full total aloud and ask the guest to confirm. Do not place it yet.'
                : 'Tell the guest plainly that you cannot do this. Do not retry or rephrase.',
            retryable: false,
          },
          latencyMs: 0,
        },
      };
    }

    const execSpan = tracer.startSpan('mcp.call', { tool: proposal.tool, tier: verdict.tier });
    const result = await this.deps.gateway.execute(
      { ...scoped, args: { ...scoped.args, __annotations: verdict.annotations } },
      ctx,
    );
    execSpan.setAll({ ok: result.ok, latency_ms: result.latencyMs });
    if (!result.ok) execSpan.fail(result.error?.detail ?? 'tool failed');
    execSpan.end();

    recorder.completed(auditIndex, result.ok ? 'applied' : 'failed', result.latencyMs);
    return { tool: proposal.tool, args: scoped.args, verdict, result };
  }
}
