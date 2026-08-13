import {
  EventType,
  makeEvent,
  type EventBus,
  type PropertyConfig,
  type TurnContext,
} from '@woohoo/contracts';
import { createTracer, type Tracer } from '@woohoo/otel';
import type { PolicyDecisionPoint } from '@woohoo/policy';
import { AgentRuntime, type AgentOutput, type ExecutedCall } from '../agent/runtime.js';
import { LlmUnavailableError } from '../agent/llm.js';
import { InMemoryAuditSink, TurnRecorder, digest, type AuditSink } from './audit.js';
import type { CatalogService } from './catalog.js';
import type { DeviceStateService } from './device-state.js';
import type { FnbService } from './fnb.js';
import type { GuestService } from './guest.js';
import { escalationSpeech, type NotificationService } from './notification.js';
import { McpGateway } from './mcp-gateway.js';
import { redact } from './redaction.js';
import { Router, type Lane } from './router.js';
import type { ServiceRequestService } from './service-request.js';
import { SessionStore } from './session.js';

/**
 * Session orchestrator — architecture doc §7, §27, §29, §68.
 *
 * Owns the turn: identity resolution, redaction, the state pre-fetch, lane selection, the
 * degradation ladder, response composition, the output guard, and sealing the audit record.
 */

export interface OrchestratorDeps {
  catalog: CatalogService;
  deviceState: DeviceStateService;
  serviceRequests: ServiceRequestService;
  fnb: FnbService;
  guest: GuestService;
  notifications: NotificationService;
  gateway: McpGateway;
  pdp: PolicyDecisionPoint;
  agent: AgentRuntime;
  bus: EventBus;
  audit?: AuditSink;
  sessions?: SessionStore;
}

export interface TurnRequest {
  deviceId: string;
  transcript: string;
  asrConfidence?: number;
  /** Overrides the property clock; used by evals to pin quiet hours. */
  now?: Date;
  /** Forces a degradation level for drills and tests (§68). */
  forceDegradation?: number;
}

export interface TurnResponse {
  turnId: string;
  lane: Lane | 'degraded';
  speech: string;
  screen?: string;
  calls: ExecutedCall[];
  escalated: boolean;
  awaitingConfirmation: boolean;
  degradationLevel: number;
  costUsd: number;
  totalMs: number;
  tracer: Tracer;
}

/** Cached acknowledgements played from the device phrase pack while the agent works (§20.4). */
const FILLED_PAUSES = [
  'Sure, one moment—',
  'Let me sort that—',
  'One second—',
  'On it—',
  'Just a moment—',
  'Right away—',
];

const MAX_SPEECH_WORDS = 45;

export class Orchestrator {
  private readonly sessions: SessionStore;
  private readonly audit: AuditSink;
  private readonly router = new Router();
  private seq = 0;
  /** Set by health signals; drives the ladder in §68. */
  private degradationLevel = 0;

  constructor(private readonly deps: OrchestratorDeps) {
    this.sessions = deps.sessions ?? new SessionStore();
    this.audit = deps.audit ?? new InMemoryAuditSink();
  }

  setDegradationLevel(level: number): void {
    this.degradationLevel = Math.max(0, Math.min(5, level));
  }

  getAuditSink(): AuditSink {
    return this.audit;
  }

  getSessions(): SessionStore {
    return this.sessions;
  }

  async handleTurn(req: TurnRequest): Promise<TurnResponse> {
    const startedAt = Date.now();
    const tracer = createTracer();
    const root = tracer.startSpan('orchestrator.turn');

    const resolved = await this.deps.catalog.resolveDevice(req.deviceId);
    const property = resolved.property;
    const consent = await this.deps.guest.consentFor(resolved.scope);
    const localTime = req.now ?? new Date();
    const degradationLevel = req.forceDegradation ?? this.degradationLevel;

    const ctx: TurnContext = {
      turnId: `turn_${startedAt.toString(36)}${(this.seq++).toString(36)}`,
      traceId: tracer.traceId,
      scope: resolved.scope,
      consent,
      timezone: property.timezone,
      localTime,
      language: property.defaultLanguage,
      capabilityManifestVersion: resolved.manifest.version,
      degradationLevel,
      startedAt,
    };

    root.setAll({
      turn_id: ctx.turnId,
      property: property.propertyId,
      degradation: degradationLevel,
    });

    // Redaction runs before anything else sees the transcript (§57.2).
    const redactSpan = tracer.startSpan('redactor');
    const forModel = redact(req.transcript, 'model');
    const forAudit = redact(req.transcript, 'audit');
    redactSpan.setAll({ categories_found: JSON.stringify(forAudit.found) });
    redactSpan.end();

    const session = this.sessions.get(resolved.scope.roomId, startedAt);
    session.turnTimestamps.push(startedAt);
    session.turnIndex++;

    const recorder = new TurnRecorder(ctx, forAudit.text, 'pending');

    // Pre-fetch (§27 step 1). Speculative and non-blocking in spirit: if it fails, the turn
    // proceeds with state marked unavailable rather than being delayed.
    const prefetchSpan = tracer.startSpan('context.prefetch');
    const [state, openRequests, stay, preferences] = await Promise.all([
      this.safeState(resolved, property),
      this.deps.serviceRequests.listOpen(resolved.scope).catch(() => []),
      this.deps.guest.stayView(resolved.scope, consent).catch(() => undefined),
      this.deps.guest.preferences(resolved.scope, consent).catch(() => ({})),
    ]);
    prefetchSpan.setAll({ state: state ? 'hit' : 'miss', open_requests: openRequests.length });
    prefetchSpan.end();

    const tools = this.deps.gateway.listTools(resolved.manifest, {
      consentPreferences: consent.preferences,
      disabledTools: property.policy.disabledTools,
    });

    const lightingZones = resolved.manifest.capabilities
      .filter((c) => c.capability === 'lighting.on_off')
      .flatMap((c) => c.zones ?? resolved.manifest.zones);

    const routeSpan = tracer.startSpan('router.classify');
    const route = this.router.route({
      transcript: forModel.text,
      asrConfidence: req.asrConfidence ?? 0.95,
      tools,
      pendingConfirmationToken: session.pendingConfirmationToken,
      pendingClarification: session.pendingClarification,
      lightingZones: [...new Set(lightingZones)],
      degradationLevel,
    });
    routeSpan.setAll({ lane: route.lane, match_rule: route.matchRule ?? '', score: route.score });
    routeSpan.end();
    recorder.setLane(route.lane);

    let speech = '';
    let screen: string | undefined;
    let calls: ExecutedCall[] = [];
    let escalated = false;
    let awaitingConfirmation = false;
    let costUsd = 0;
    let lane: TurnResponse['lane'] = route.lane;

    const agentInput = {
      ctx,
      property,
      transcript: forModel.text,
      tools,
      state,
      openRequests,
      stay,
      preferences: preferences as Record<string, string>,
      history: session.history.map((h) => ({ role: h.role, text: h.text })),
      pendingClarification: session.pendingClarification,
      recorder,
      tracer,
    };

    try {
      if (route.lane === 'clarify') {
        speech = route.question ?? 'Sorry, could you say that again?';
        session.pendingClarification = speech;
      } else if (route.lane === 'confirm') {
        const outcome = await this.handleConfirmation(route.confirmation!, ctx, recorder, tracer);
        speech = outcome.speech;
        calls = outcome.calls;
        session.pendingConfirmationToken = undefined;
      } else if (route.lane === 'fast') {
        const call = await this.deps.agent.executeOne(route.proposal!, agentInput);
        calls = [call];
        // The fast lane must be able to admit defeat: anything other than a clean allow
        // escalates to the agentic lane rather than failing (§24.1).
        if (call.verdict.kind !== 'ALLOW' || !call.result?.ok) {
          const agentOut = await this.runAgent(agentInput);
          lane = 'agentic';
          recorder.setLane('agentic');
          calls = agentOut.calls;
          speech = agentOut.text;
          escalated = agentOut.escalated;
          costUsd = agentOut.costUsd;
          awaitingConfirmation = Boolean(agentOut.pendingConfirmationToken);
          session.pendingConfirmationToken = agentOut.pendingConfirmationToken;
        } else {
          speech = templatedConfirmation(call);
        }
      } else if (degradationLevel >= 2) {
        // Level 2: fast lane only. Say what you CAN still do, not what you cannot (§29).
        lane = 'degraded';
        recorder.setLane('degraded');
        speech =
          'I can help with lights, temperature, do not disturb and service requests right now. ' +
          'For anything else, let me connect you to the front desk.';
      } else {
        const agentOut = await this.runAgent(agentInput);
        calls = agentOut.calls;
        speech = agentOut.text;
        escalated = agentOut.escalated;
        costUsd = agentOut.costUsd;
        awaitingConfirmation = Boolean(agentOut.pendingConfirmationToken);
        session.pendingConfirmationToken = agentOut.pendingConfirmationToken;
      }
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        lane = 'degraded';
        recorder.setLane('degraded');
        speech =
          'I can help with lights, temperature and do not disturb right now. ' +
          'For anything else, shall I connect you to the front desk?';
        root.setAll({ degraded_reason: 'llm_unavailable' });
      } else {
        throw err;
      }
    }

    // A pending T3 action gets platform-authored wording, for the same reason escalation does:
    // §44.1 requires the total to be stated aloud before consent, and a model that drafted
    // "Done." while nothing has been ordered is actively dangerous. The confirmation question
    // is generated from the FROZEN action, so what the guest hears is what "yes" will execute.
    const confirmCall = calls.find((c) => c.verdict.kind === 'CONFIRM');
    if (confirmCall?.verdict.confirmation) {
      const must = confirmCall.verdict.confirmation.mustInclude as {
        totalAmount?: number;
        currency?: string;
        itemCount?: number;
      };
      const summary = describeFrozenOrder(confirmCall.verdict.confirmation.args, must);
      speech = `${summary} Shall I place it?`;
      screen = summary;
    }

    // ESCALATE means the AGENT may not act — not that nothing happens. The platform performs
    // the handoff itself, then overrides whatever the model drafted with the §48 wording, which
    // is a compliance artefact rather than a stylistic choice.
    const escalationCall = calls.find((c) => c.verdict.kind === 'ESCALATE');
    if (escalationCall) {
      escalated = true;
      const category = (escalationCall.args.category ?? 'other') as Parameters<
        typeof escalationSpeech
      >[0];
      const summary = String(escalationCall.args.summary ?? forAudit.text).slice(0, 400);

      const escSpan = tracer.startSpan('escalation.raise', { category });
      try {
        const raised = await this.deps.notifications.escalate(
          resolved.scope,
          property,
          category,
          summary,
          ctx.traceId,
          'agent_raised',
        );
        escSpan.setAll({ escalation_id: raised.id, notified: raised.notified.join(',') });
      } catch (err) {
        // A failed escalation is the worst outcome in the system, so it is never silent.
        escSpan.fail(err);
      }
      escSpan.end();

      const wording = escalationSpeech(category, property);
      speech = wording.speech;
      screen = wording.screen;
    }

    // The fallback wording must be derived from what actually happened, never assumed.
    // A blanket "Done." here is the confident false confirmation this system exists to
    // avoid: if every proposed action was denied, saying "Done" tells the guest their
    // request succeeded when the platform in fact refused all of it.
    if (!speech) speech = fallbackSpeech(calls);

    const guardSpan = tracer.startSpan('guard.output');
    const guarded = outputGuard(speech, resolved.room.roomNumber);
    guardSpan.setAll({ violations: guarded.violations.join(',') || 'none' });
    guardSpan.end();
    speech = guarded.text;

    // Session bookkeeping
    if (route.lane !== 'clarify') session.pendingClarification = undefined;
    session.history.push({ role: 'guest', text: forModel.text, at: startedAt });
    session.history.push({ role: 'assistant', text: speech, at: Date.now() });
    for (const c of calls) {
      if (c.verdict.kind === 'ALLOW' && c.result?.ok) {
        session.recentActuations.push({ tool: c.tool, at: Date.now() });
      }
    }
    this.sessions.save(session);

    const totalMs = Date.now() - startedAt;
    recorder.setResponse(speech);
    recorder.setCost(costUsd);
    recorder.setOutcome(
      escalated ? 'escalated' : calls.some((c) => c.result && !c.result.ok) ? 'partial' : 'success',
      escalated,
    );
    root.end();

    const record = recorder.seal(totalMs);
    await this.audit.write(record);

    await this.deps.bus.publish(
      makeEvent(
        EventType.TurnCompleted,
        {
          source: '/woohoo-core/orchestrator',
          subject: ctx.turnId,
          tenantId: ctx.scope.tenantId,
          propertyId: ctx.scope.propertyId,
          traceId: ctx.traceId,
        },
        {
          turnId: ctx.turnId,
          lane,
          degradationLevel,
          outcome: record.outcome,
          toolCalls: record.toolCalls.map((t) => ({ tool: t.tool, tier: t.tier, verdict: t.verdict })),
          totalMs,
          costUsd,
        },
      ),
    );

    return {
      turnId: ctx.turnId,
      lane,
      speech,
      screen,
      calls,
      escalated,
      awaitingConfirmation,
      degradationLevel,
      costUsd,
      totalMs,
      tracer,
    };
  }

  /** The acknowledgement the device plays from its cached phrase pack (§20.4). */
  filledPause(turnIndex: number): string {
    return FILLED_PAUSES[turnIndex % FILLED_PAUSES.length]!;
  }

  private async runAgent(input: Parameters<AgentRuntime['run']>[0]): Promise<AgentOutput> {
    return this.deps.agent.run(input);
  }

  private async safeState(
    resolved: Awaited<ReturnType<CatalogService['resolveDevice']>>,
    property: PropertyConfig,
  ) {
    try {
      const supportsPosition = resolved.manifest.capabilities.some(
        (c) => c.capability === 'curtains.position',
      );
      return await this.deps.deviceState.readState(resolved.vendorRoom, {
        minC: property.policy.climate.minC,
        maxC: property.policy.climate.maxC,
        supportsCurtainPosition: supportsPosition,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Redeem a frozen T3 action. The executed action is the one that was authorised, byte for
   * byte — the confirming turn cannot substitute its own arguments (§44.1).
   */
  private async handleConfirmation(
    confirmation: { token: string; affirmative: boolean },
    ctx: TurnContext,
    recorder: TurnRecorder,
    tracer: Tracer,
  ): Promise<{ speech: string; calls: ExecutedCall[] }> {
    if (!confirmation.affirmative) {
      this.deps.pdp.discard(confirmation.token);
      return { speech: "No problem, I haven't ordered anything.", calls: [] };
    }

    const span = tracer.startSpan('confirmation.redeem');
    const frozen = this.deps.pdp.redeem(confirmation.token, ctx.scope);
    span.setAll({ redeemed: Boolean(frozen) });
    span.end();

    if (!frozen) {
      return {
        speech: "That confirmation has expired — shall I start the order again?",
        calls: [],
      };
    }

    const scoped = {
      tool: frozen.tool,
      args: frozen.args,
      scope: ctx.scope,
      turnId: ctx.turnId,
      idempotencyKey: confirmation.token,
      actor: 'guest' as const,
    };
    const auditIndex = recorder.authorised({
      tool: frozen.tool,
      tier: 'T3',
      verdict: 'ALLOW',
      ruleId: 'R11.confirmation_redeemed',
      argsDigest: digest(frozen.args),
    });
    const result = await this.deps.gateway.execute(scoped, ctx);
    recorder.completed(auditIndex, result.ok ? 'applied' : 'failed', result.latencyMs);

    const order = result.value as { etaMinutes?: number; total?: { amount: number; currency: string } };
    const speech = result.ok
      ? `Ordered — about ${order?.etaMinutes ?? 30} minutes. ` +
        `${order?.total ? `${order.total.amount} ${order.total.currency} has gone to your room bill.` : ''}`.trim()
      : "I couldn't place that order — let me connect you to the front desk.";

    return {
      speech,
      calls: [
        {
          tool: frozen.tool,
          args: frozen.args,
          verdict: { kind: 'ALLOW', tier: 'T3', ruleId: 'R11.confirmation_redeemed', reason: 'Confirmed by guest.' },
          result,
        },
      ],
    };
  }
}

/**
 * Last-resort wording when neither the model nor a template produced a reply.
 *
 * Derived strictly from observed outcomes. "Done" is only ever reachable when at least one
 * call actually succeeded — §37, "never say done on an unconfirmed write".
 */
export function fallbackSpeech(calls: ExecutedCall[]): string {
  if (!calls.length) {
    return "I'm not sure about that one — would you like me to connect you to the front desk?";
  }
  const succeeded = calls.filter((c) => c.verdict.kind === 'ALLOW' && c.result?.ok);
  if (succeeded.length === calls.length) return 'Done.';
  if (succeeded.length > 0) {
    return "I've done part of that, but not all of it. Shall I connect you to the front desk?";
  }
  // Nothing succeeded. Do not imply otherwise, and do not explain which rule refused it —
  // that is internal detail the guest cannot act on.
  return "I couldn't do that just now. Would you like me to connect you to the front desk?";
}

/**
 * Describe the frozen action for the spoken confirmation. Reads the PDP's stored arguments
 * rather than the model's draft, so the guest is told exactly what "yes" will execute.
 */
function describeFrozenOrder(
  args: Record<string, unknown>,
  must: { totalAmount?: number; currency?: string; itemCount?: number },
): string {
  const items = (args.items as Array<{ quantity: number }> | undefined) ?? [];
  const count = must.itemCount ?? items.reduce((a, i) => a + (i.quantity ?? 1), 0);
  const noun = count === 1 ? 'item' : 'items';
  const total =
    must.totalAmount !== undefined
      ? ` That's ${must.totalAmount} ${must.currency ?? ''}`.trimEnd() + ', charged to your room.'
      : ' It will be charged to your room.';
  return `I have ${count} ${noun} ready to order.${total}`;
}

/**
 * Templated confirmation — avoids a second LLM pass on the common case, saving ~300ms (§27 step 8).
 * Wording is tied to the verified outcome, so "done" can only be said when it is observed done.
 */
function templatedConfirmation(call: ExecutedCall): string {
  const value = call.result?.value as
    | { status?: string; observed?: { value?: unknown }; checkoutAt?: string }
    | undefined;
  const pending = value?.status === 'pending';
  const observed = value?.observed?.value;

  switch (call.tool) {
    case 'lighting.set':
      return pending ? "I've asked for that — give it a moment." : 'Done.';
    case 'climate.set_temperature':
      return pending
        ? `I've asked for ${observed} degrees — it'll take a moment.`
        : `I've set it to ${observed} degrees.`;
    case 'curtains.set':
      return Number(observed ?? 0) > 50 ? 'Curtains open.' : 'Curtains closed.';
    case 'dnd.set':
      return observed === 'off' ? 'Do not disturb is off.' : 'Do not disturb is on.';
    case 'tv.control':
      return 'Done.';
    case 'stay.get_info':
      return value?.checkoutAt ? `Checkout is at ${value.checkoutAt}.` : 'Here you go.';
    case 'staff.connect':
      return "I'm connecting you to the front desk now.";
    default:
      return 'Done.';
  }
}

/**
 * Output guard — architecture doc §27 step 9 and §46 layer 5.
 * Violations are replaced and logged as security events, not silently dropped.
 */
export function outputGuard(text: string, ownRoomNumber: string): { text: string; violations: string[] } {
  const violations: string[] = [];
  let out = text;

  // Any room number that is not this room's must never be spoken.
  out = out.replace(/\broom\s+(\d{3,4})\b/gi, (m, num: string) => {
    if (num === ownRoomNumber) return m;
    violations.push('other_room_reference');
    return 'another room';
  });

  if (/<untrusted|<\/untrusted|system prompt|SYSTEM IDENTITY/i.test(out)) {
    violations.push('prompt_leak');
    out = out.replace(/<\/?untrusted[^>]*>/gi, '').replace(/SYSTEM IDENTITY/gi, '');
  }

  const words = out.trim().split(/\s+/);
  if (words.length > MAX_SPEECH_WORDS) {
    violations.push('too_long');
    out = words.slice(0, MAX_SPEECH_WORDS).join(' ') + '.';
  }

  return { text: out.trim(), violations };
}
