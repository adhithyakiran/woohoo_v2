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
  /** Prior tool results within this turn, for the second and third loop rounds. */
  toolResults?: Array<{ tool: string; ok: boolean; content: string }>;
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
    readonly model = process.env.WOOHOO_LLM_MODEL ?? 'gemini-2.5-flash',
    private readonly apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
    private readonly endpoint = process.env.WOOHOO_LLM_ENDPOINT ??
      'https://generativelanguage.googleapis.com/v1beta/models',
  ) {}

  static isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
  }

  async generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    if (!this.apiKey) throw new LlmUnavailableError('No Google API key configured');

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [
        { role: 'user', parts: [{ text: req.user }] },
        ...(req.toolResults?.length
          ? [
              {
                role: 'user' as const,
                parts: [
                  {
                    text:
                      'Tool results:\n' +
                      req.toolResults
                        .map((r) => `${r.tool} => ${r.ok ? 'ok' : 'error'}: ${r.content}`)
                        .join('\n'),
                  },
                ],
              },
            ]
          : []),
      ],
      tools: [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name.replace(/\./g, '_'),
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

    const res = await fetch(`${this.endpoint}/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw new LlmUnavailableError(`Gemini returned ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as GeminiResponseShape;
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: LlmToolCall[] = [];
    let text = '';

    for (const p of parts) {
      if (p.functionCall) {
        toolCalls.push({
          tool: p.functionCall.name.replace(/_/g, '.'),
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
