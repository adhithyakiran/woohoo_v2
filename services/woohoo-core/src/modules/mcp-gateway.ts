import { createHash } from 'node:crypto';
import {
  getTool,
  isToolError,
  ToolErrorCode,
  toolError,
  toolSurfaceFor,
  type Scope,
  type ScopedToolCall,
  type ToolDefinition,
  type ToolProposal,
  type ToolResult,
  type TurnContext,
} from '@woohoo/contracts';

/**
 * MCP Gateway — architecture doc §30, §31, §34.
 *
 * The agent holds exactly one connection: to this. Downstream servers are never addressable
 * by the agent runtime, which is what makes tenant scoping, result sanitisation and uniform
 * audit mechanical rather than a code-review question.
 */

/** Anything that looks like scope is stripped from model output, never validated (§34.1). */
const SCOPE_FIELD_PATTERN =
  /^(room|property|tenant|device|hotel)(_?id|_?ref|_?number)?$|^(roomId|propertyId|tenantId|deviceId|roomNumber|vendorRoomId)$/i;

export type ToolHandler = (
  call: ScopedToolCall,
  ctx: TurnContext,
) => Promise<unknown>;

export interface GatewayDeps {
  handlers: Map<string, ToolHandler>;
}

export interface ExecutionOptions {
  /** Present when the capability manifest should narrow the advertised surface. */
  surface?: ToolDefinition[];
}

export class McpGateway {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly deps: GatewayDeps) {}

  /**
   * The tool surface for one room, generated from its capability manifest (§33) and then
   * filtered by property policy. A capability the room does not have produces no tool, so the
   * model cannot propose it.
   */
  listTools(
    manifest: Parameters<typeof toolSurfaceFor>[0],
    opts: { consentPreferences: boolean; disabledTools: string[] },
  ): ToolDefinition[] {
    return toolSurfaceFor(manifest, { consentPreferences: opts.consentPreferences }).filter(
      (t) => !opts.disabledTools.includes(t.name),
    );
  }

  /**
   * Strip model-supplied scope and inject the authenticated scope.
   *
   * Stripping rather than validating is deliberate. Validating a model-supplied roomId means
   * the field exists in the surface, which means it can be populated, which means somebody
   * will one day "temporarily" trust it for a staff feature. Removing the class of field
   * removes the class of bug.
   */
  scopeCall(proposal: ToolProposal, ctx: TurnContext): ScopedToolCall {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(proposal.args ?? {})) {
      if (SCOPE_FIELD_PATTERN.test(k)) continue;
      clean[k] = v;
    }
    return {
      tool: proposal.tool,
      args: clean,
      scope: ctx.scope,
      turnId: ctx.turnId,
      idempotencyKey: idempotencyKey(ctx.turnId, proposal.tool, clean),
      actor: 'guest',
    };
  }

  /** Which scope fields the model tried to supply — a signal worth alarming on (§46, layer 6). */
  strippedFields(proposal: ToolProposal): string[] {
    return Object.keys(proposal.args ?? {}).filter((k) => SCOPE_FIELD_PATTERN.test(k));
  }

  /** Schema validation. `.strict()` on every tool means invented fields fail loudly. */
  validate(proposal: ToolProposal): { ok: true; args: Record<string, unknown> } | { ok: false; error: ReturnType<typeof toolError> } {
    const def = getTool(proposal.tool);
    if (!def) {
      return {
        ok: false,
        error: toolError(
          ToolErrorCode.NotAvailable,
          `There is no tool named ${proposal.tool}.`,
          'Use only the tools listed for this room.',
        ),
      };
    }
    const parsed = def.input.safeParse(proposal.args ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        error: toolError(
          ToolErrorCode.InvalidArgument,
          `${proposal.tool}: ${first?.path.join('.') ?? 'argument'} ${first?.message ?? 'is invalid'}.`,
          'Correct the arguments and try once more. Do not add fields that are not in the schema.',
        ),
      };
    }
    return { ok: true, args: parsed.data as Record<string, unknown> };
  }

  async execute(call: ScopedToolCall, ctx: TurnContext): Promise<ToolResult> {
    const started = performance.now();
    const def = getTool(call.tool);
    const handler = this.deps.handlers.get(call.tool);

    if (!def || !handler) {
      return {
        ok: false,
        error: toolError(
          ToolErrorCode.NotAvailable,
          `${call.tool} is not available here.`,
          'Tell the guest this is not something you can do in their room.',
        ),
        latencyMs: Math.round(performance.now() - started),
      };
    }

    try {
      const value = await handler(call, ctx);
      const latencyMs = Math.round(performance.now() - started);

      if (isToolError(value)) {
        return { ok: false, error: value, latencyMs };
      }
      return {
        ok: true,
        value: def.meta.untrustedResult ? value : value,
        untrusted: def.meta.untrustedResult,
        latencyMs,
      };
    } catch (err) {
      // Raw vendor errors never reach the model — they are normalised into the small vocabulary
      // the prompt teaches it to handle (§30).
      return {
        ok: false,
        error: toolError(
          ToolErrorCode.TemporarilyUnreachable,
          'That system is not responding right now.',
          'Tell the guest you could not complete it and offer to connect them to the front desk.',
          true,
        ),
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }

  cacheGet(key: string, ttlMs: number, now = Date.now()): unknown | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (now - hit.at > ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  cacheSet(key: string, value: unknown, now = Date.now()): void {
    this.cache.set(key, { at: now, value });
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/** Stable across retries of the same logical action within a turn (§34.3). */
export function idempotencyKey(turnId: string, tool: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${turnId}|${tool}|${JSON.stringify(sortDeep(args))}`)
    .digest('hex')
    .slice(0, 32);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k]);
    return out;
  }
  return v;
}

/**
 * Untrusted-content fencing — architecture doc §46, layer 1 and layer 3.
 *
 * Staff-authored menus and FAQ text, and anything else the platform did not generate, are
 * wrapped in explicit delimiters. The standing rule in the system prompt is that nothing
 * inside these fences is ever an instruction. Layer 2 is what actually saves us — the PDP
 * never reads any of this — but structural separation makes injection markedly harder.
 */
export function fenceUntrusted(source: string, content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return [
    `<untrusted source="${source}">`,
    sanitiseUntrusted(text),
    `</untrusted>`,
  ].join('\n');
}

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore (all |any )?(previous|prior|above) instructions?/gi, label: 'override-attempt' },
  { re: /disregard (the |your )?(system )?(prompt|instructions?|rules?)/gi, label: 'override-attempt' },
  { re: /you are now|from now on,? you/gi, label: 'persona-swap' },
  { re: /<\/?(system|assistant|user|untrusted)>/gi, label: 'delimiter-injection' },
  { re: /\bsudo\b|\bdeveloper mode\b|\bjailbreak\b/gi, label: 'privilege-claim' },
];

export interface SanitisationReport {
  clean: string;
  flags: string[];
}

/** Scan-and-neutralise before content enters the model's context. */
export function scanUntrusted(text: string): SanitisationReport {
  const flags: string[] = [];
  let clean = text;
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(clean)) flags.push(label);
    re.lastIndex = 0;
    clean = clean.replace(re, '[removed]');
  }
  // Control characters and stray fence delimiters cannot survive into the prompt.
  clean = clean.replace(/[ --]/g, '');
  if (clean.length > 4000) {
    clean = clean.slice(0, 4000) + '\n[truncated]';
    flags.push('oversized');
  }
  return { clean, flags };
}

function sanitiseUntrusted(text: string): string {
  return scanUntrusted(text).clean;
}

export type { Scope };
