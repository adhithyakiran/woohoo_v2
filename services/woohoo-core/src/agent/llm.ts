import type { ToolDefinition } from '@woohoo/contracts';

/**
 * LLM provider abstraction — architecture doc §25 (D8).
 *
 * Model IDs are configuration, not code, so a model upgrade is a staged rollout rather than a
 * deploy. Keeping one non-Google fallback wired but dormant is cheap insurance against a
 * single-provider dependency in the reasoning core of a product installed in guest rooms.
 */

export interface LlmToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  /** Assembled context layers 3–5, already fenced (§26). */
  user: string;
  tools: ToolDefinition[];
  /**
   * Prior rounds within this turn — what the model called, and what came back.
   *
   * Both halves are required. Sending only the results, without the model's own
   * functionCall turn, leaves the model with no record that it already acted: it
   * re-proposes the same calls every round, burning an LLM call each time and ending on
   * a reply that contradicts what actually happened.
   */
  rounds?: Array<{
    calls: LlmToolCall[];
    results: Array<{ tool: string; ok: boolean; content: string }>;
  }>;
  maxOutputTokens: number;
  /** Extended reasoning is a latency disaster on a voice path; capped explicitly (§25). */
  thinkingBudget: number;
  temperature: number;
}

export interface LlmResponse {
  /** Zero or more proposed tool calls. Never executed by the model itself. */
  toolCalls: LlmToolCall[];
  /** Draft spoken reply, if the model produced one. */
  text?: string;
  reasoningSummary?: string;
  usage: { tokensIn: number; tokensCached: number; tokensOut: number };
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

/**
 * Tool name as sent to the model. Gemini's function names are conservative about
 * punctuation, so dots become underscores on the wire.
 *
 * This is deliberately one-way: decoding is done with a lookup table built from the tools
 * actually advertised, never by reversing the substitution. See the decode site above.
 */
export function wireName(toolName: string): string {
  return toolName.replace(/\./g, '_');
}

/**
 * Read an environment variable, treating blank as unset.
 *
 * docker-compose substitutes `${FOO:-}` as an empty string when FOO is unset, so every
 * declared-but-unset variable arrives as `""`. Plain `??` accepts that as a real value.
 */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/** Indicative planning rates (§65). Real figures must be re-quoted before contracting. */
const RATES: Record<string, { in: number; cachedIn: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3 / 1e6, cachedIn: 0.075 / 1e6, out: 2.5 / 1e6 },
  'gemini-2.5-flash-lite': { in: 0.1 / 1e6, cachedIn: 0.025 / 1e6, out: 0.4 / 1e6 },
  'gemini-2.5-pro': { in: 1.25 / 1e6, cachedIn: 0.31 / 1e6, out: 10 / 1e6 },
  mock: { in: 0, cachedIn: 0, out: 0 },
};

export function estimateCostUsd(r: LlmResponse): number {
  const rate = RATES[r.model] ?? RATES['mock']!;
  const freshIn = Math.max(0, r.usage.tokensIn - r.usage.tokensCached);
  return freshIn * rate.in + r.usage.tokensCached * rate.cachedIn + r.usage.tokensOut * rate.out;
}

/**
 * Vertex AI / Gemini provider. Activates only when GOOGLE_API_KEY (or GEMINI_API_KEY) is set;
 * otherwise the runtime falls back to the deterministic mock so the whole stack still runs.
 *
 * Uses the REST surface directly rather than an SDK to keep the dependency footprint small —
 * this is one HTTP call with a well-known shape.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(
    // Accept both naming conventions — WOOHOO_LLM_* is ours, GEMINI_* is what most people
    // reach for first. Silently ignoring a variable someone clearly meant is a bad failure
    // mode: they set it, nothing changes, and there is no error to chase.
    //
    // Note `env()` rather than `??`: docker-compose substitutes UNSET variables as EMPTY
    // STRINGS, and `??` only skips null/undefined. That produced a 0ms timeout — every
    // request aborting instantly — from a variable nobody had set.
    readonly model = env('WOOHOO_LLM_MODEL') ?? env('GEMINI_MODEL') ?? 'gemini-2.5-flash',
    private readonly apiKey = env('GOOGLE_API_KEY') ?? env('GEMINI_API_KEY') ?? '',
    private readonly endpoint = env('WOOHOO_LLM_ENDPOINT') ??
      'https://generativelanguage.googleapis.com/v1beta/models',
    /** Seconds. A hung upstream must not outlive the turn's own wall clock (§27). */
    private readonly timeoutMs = Math.max(1, Number(env('GEMINI_TIMEOUT') ?? 20)) * 1000,
  ) {}

  static isConfigured(): boolean {
    return Boolean(env('GOOGLE_API_KEY') ?? env('GEMINI_API_KEY'));
  }

  /**
   * POST with bounded retries on transient upstream failures.
   *
   * `timeoutMs` is a budget for the WHOLE call, not per attempt. Sharing a single timer
   * across attempts silently spends the budget on retries and aborts mid-flight; giving
   * each attempt its own full timer makes the worst case attempts × timeout, which is far
   * too long with a guest waiting. So: one deadline, each attempt gets what remains, and
   * retrying stops when there is not enough left to be worth it.
   */
  private async fetchWithRetry(body: unknown, caller?: AbortSignal, attempts = 3): Promise<Response> {
    const deadline = Date.now() + this.timeoutMs;
    const remaining = () => deadline - Date.now();
    let lastStatus = 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const backoff = 200 * 2 ** (attempt - 1);
        const wait = Math.min(backoff + Math.random() * backoff, Math.max(0, remaining() - 1000));
        if (wait <= 0) break;
        await new Promise((r) => setTimeout(r, wait));
      }

      // A retry that cannot finish before the deadline is worse than none — it burns the
      // remaining budget and still fails.
      if (remaining() < 1000) break;

      const timer = AbortSignal.timeout(remaining());
      const signal = caller ? AbortSignal.any([caller, timer]) : timer;

      try {
        const res = await fetch(`${this.endpoint}/${this.model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal,
        });
        if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
        lastStatus = res.status;
        // Final attempt: return it so the caller reports the real upstream status.
        if (attempt === attempts - 1 || remaining() < 1000) return res;
        console.warn(`[llm] ${res.status} from Gemini, retrying (${attempt + 1}/${attempts - 1})`);
      } catch (err) {
        if (caller?.aborted) throw new LlmUnavailableError('Gemini request cancelled');
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (isTimeout) throw new LlmUnavailableError(`Gemini timed out after ${this.timeoutMs}ms`);
        if (attempt === attempts - 1 || remaining() < 1000) {
          throw new LlmUnavailableError(`Gemini request failed: ${String(err)}`);
        }
        console.warn(`[llm] network error, retrying (${attempt + 1}/${attempts - 1}): ${String(err)}`);
      }
    }

    throw new LlmUnavailableError(
      lastStatus
        ? `Gemini returned ${lastStatus} on every attempt within ${this.timeoutMs}ms`
        : `Gemini unreachable within ${this.timeoutMs}ms`,
    );
  }

  async generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    if (!this.apiKey) throw new LlmUnavailableError('No Google API key configured');

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      // Gemini's function-calling protocol expects the conversation to alternate:
      // user text -> model functionCall -> user functionResponse -> model ...
      // Reconstructing the model's own turn is what tells it which calls it already made.
      contents: buildContents(req),
      tools: [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: wireName(t.name),
            description: t.description,
            parameters: zodLikeToJsonSchema(t),
          })),
        },
      ],
      generationConfig: {
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        thinkingConfig: { thinkingBudget: req.thinkingBudget },
      },
    };

    // 503 "high demand" and 429 are explicitly transient and common on shared capacity.
    // Dropping the guest into degraded mode for one of those wastes a turn that a retry
    // 400ms later would have served. Permanent errors (bad key, bad model, bad request)
    // are NOT retried — repeating them just adds latency to a certain failure.
    const res = await this.fetchWithRetry(body, signal);

    if (!res.ok) {
      throw new LlmUnavailableError(`Gemini returned ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as GeminiResponseShape;
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: LlmToolCall[] = [];
    let text = '';

    // Decode via a lookup built from the tools we actually advertised. Reversing the
    // substitution by character was lossy: `climate.set_temperature` went out as
    // `climate_set_temperature` and came back as `climate.set.temperature`, because the
    // original underscore is indistinguishable from the substituted dot. Every such call
    // was then rejected as an unknown tool.
    const byWireName = new Map(req.tools.map((t) => [wireName(t.name), t.name]));

    for (const p of parts) {
      if (p.functionCall) {
        const decoded = byWireName.get(p.functionCall.name);
        toolCalls.push({
          // Fall back to the raw name when the model invents one — the platform must reject
          // it as unknown rather than have us guess at what was meant.
          tool: decoded ?? p.functionCall.name,
          args: (p.functionCall.args ?? {}) as Record<string, unknown>,
        });
      } else if (p.text) {
        text += p.text;
      }
    }

    const usage = json.usageMetadata;
    return {
      toolCalls,
      text: text.trim() || undefined,
      usage: {
        tokensIn: usage?.promptTokenCount ?? 0,
        tokensCached: usage?.cachedContentTokenCount ?? 0,
        tokensOut: usage?.candidatesTokenCount ?? 0,
      },
      model: this.model,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }
}

/**
 * Build the Gemini `contents` array for this round.
 *
 * The model turn carrying its own functionCall parts is not optional decoration — without
 * it the model cannot distinguish an action it already performed from one still outstanding.
 */
function buildContents(req: LlmRequest): unknown[] {
  const contents: unknown[] = [{ role: 'user', parts: [{ text: req.user }] }];

  for (const round of req.rounds ?? []) {
    contents.push({
      role: 'model',
      parts: round.calls.map((c) => ({
        functionCall: { name: wireName(c.tool), args: c.args },
      })),
    });
    contents.push({
      role: 'user',
      parts: round.results.map((r) => ({
        functionResponse: {
          name: wireName(r.tool),
          // Gemini expects an object here; a bare string is rejected.
          response: r.ok ? { result: safeJson(r.content) } : { error: safeJson(r.content) },
        },
      })),
    });
  }

  return contents;
}

/** Tool results are JSON where possible, but errors and fences are not. Never throw here. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 2000) };
  }
}

/** Transient upstream conditions. Anything else is permanent and must not be retried. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

/**
 * Minimal JSON Schema projection of a tool's Zod input.
 *
 * Deliberately hand-rolled and shallow: the tool surface is 22 flat schemas (§32), so a full
 * zod-to-json-schema dependency would be more surface area than the problem justifies.
 */
function zodLikeToJsonSchema(t: ToolDefinition): Record<string, unknown> {
  const def = t.input as unknown as { _def?: { typeName?: string }; shape?: () => unknown };
  const shape =
    typeof def.shape === 'function'
      ? (def.shape() as Record<string, { _def?: { typeName?: string } }>)
      : ((t.input as unknown as { shape?: Record<string, unknown> }).shape as
          | Record<string, { _def?: { typeName?: string } }>
          | undefined);

  if (!shape) return { type: 'object', properties: {} };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const { schema, isRequired } = describeZodField(field);
    properties[key] = schema;
    if (isRequired) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function describeZodField(field: unknown): { schema: Record<string, unknown>; isRequired: boolean } {
  let node = field as { _def?: Record<string, unknown> };
  let isRequired = true;
  // Unwrap optional/default/nullable wrappers to reach the base type.
  for (let i = 0; i < 5; i++) {
    const name = node?._def?.typeName as string | undefined;
    if (name === 'ZodOptional' || name === 'ZodDefault' || name === 'ZodNullable') {
      isRequired = false;
      node = node._def!.innerType as { _def?: Record<string, unknown> };
    } else break;
  }
  const typeName = node?._def?.typeName as string | undefined;
  switch (typeName) {
    case 'ZodString':
      return { schema: { type: 'string' }, isRequired };
    case 'ZodNumber':
      return { schema: { type: 'number' }, isRequired };
    case 'ZodBoolean':
      return { schema: { type: 'boolean' }, isRequired };
    case 'ZodEnum':
      return { schema: { type: 'string', enum: node._def!.values as string[] }, isRequired };
    case 'ZodArray':
      return { schema: { type: 'array', items: { type: 'object' } }, isRequired };
    case 'ZodObject':
      return { schema: { type: 'object' }, isRequired };
    default:
      return { schema: { type: 'string' }, isRequired };
  }
}
