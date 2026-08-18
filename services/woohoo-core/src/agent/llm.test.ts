import { describe, expect, it } from 'vitest';
import { TOOLS } from '@woohoo/contracts';
import { GeminiProvider, wireName } from './llm.js';

/**
 * Tool-name round-trip — regression for a bug the mock provider cannot catch.
 *
 * Names are sanitised on the way out (dots become underscores) and were previously decoded
 * by reversing that substitution. That is lossy for any name containing BOTH characters:
 * `climate.set_temperature` went out as `climate_set_temperature` and came back as
 * `climate.set.temperature`, so every real Gemini call to those tools was rejected as
 * unknown. Only a live model surfaces this, because the mock echoes names verbatim.
 */
describe('Gemini tool-name encoding', () => {
  it('every real tool name survives encode → decode', () => {
    const byWireName = new Map(TOOLS.map((t) => [wireName(t.name), t.name]));
    for (const t of TOOLS) {
      expect(byWireName.get(wireName(t.name)), `round-trip failed for ${t.name}`).toBe(t.name);
    }
  });

  it('encoding stays unique — no two tools collide on the wire', () => {
    const wire = TOOLS.map((t) => wireName(t.name));
    expect(new Set(wire).size, 'two tools encode to the same wire name').toBe(TOOLS.length);
  });

  it('catches the specific names that broke: dot AND underscore together', () => {
    const tricky = ['climate.set_temperature', 'service.create_request', 'fnb.place_order'];
    for (const name of tricky) {
      expect(TOOLS.some((t) => t.name === name), `${name} should exist`).toBe(true);
      // The old implementation did this, and it is wrong:
      expect(wireName(name).replace(/_/g, '.')).not.toBe(name);
      // The lookup approach is correct:
      const lookup = new Map(TOOLS.map((t) => [wireName(t.name), t.name]));
      expect(lookup.get(wireName(name))).toBe(name);
    }
  });

  it('wire names contain no characters Gemini rejects in a function name', () => {
    for (const t of TOOLS) {
      expect(wireName(t.name)).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    }
  });
});

describe('Gemini configuration', () => {
  it('treats blank environment variables as unset', () => {
    const prev = { ...process.env };
    try {
      process.env.GEMINI_API_KEY = 'AIzaTestKeyForUnitTestOnly';
      // docker-compose substitutes unset vars as empty strings; `??` would accept those.
      process.env.GEMINI_MODEL = '';
      process.env.WOOHOO_LLM_MODEL = '';
      delete process.env.GOOGLE_API_KEY;
      expect(new GeminiProvider().model).toBe('gemini-2.5-flash');
    } finally {
      process.env = prev;
    }
  });

  it('uses an explicitly set model', () => {
    const prev = { ...process.env };
    try {
      process.env.GEMINI_API_KEY = 'AIzaTestKeyForUnitTestOnly';
      process.env.GEMINI_MODEL = 'gemini-2.5-pro';
      delete process.env.WOOHOO_LLM_MODEL;
      expect(new GeminiProvider().model).toBe('gemini-2.5-pro');
    } finally {
      process.env = prev;
    }
  });

  it('is not configured when no key is present', () => {
    const prev = { ...process.env };
    try {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      expect(GeminiProvider.isConfigured()).toBe(false);
      // A blank key is not a key.
      process.env.GEMINI_API_KEY = '   ';
      expect(GeminiProvider.isConfigured()).toBe(false);
    } finally {
      process.env = prev;
    }
  });
});

/**
 * The model must be shown its OWN prior calls, not just their results.
 *
 * This was a real defect: results were sent as a plain user text message and the model turn
 * carrying the functionCall parts was omitted entirely. Gemini therefore had no record that it
 * had already acted, and re-proposed the same calls on every round — three LLM round-trips and
 * three times the cost for one turn, ending on a reply that contradicted what had happened.
 * Nothing failed loudly; the duplicate-request rule absorbed it. Hence this test.
 */
describe('Gemini conversation structure', () => {
  /** Intercept the outgoing request body without a network call. */
  async function capture(rounds: unknown): Promise<any> {
    const original = globalThis.fetch;
    let body: any;
    globalThis.fetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const p = new GeminiProvider('gemini-2.5-flash', 'test-key');
      await p.generate({
        system: 's',
        user: 'turn the heat up',
        tools: TOOLS.slice(0, 3),
        rounds: rounds as any,
        maxOutputTokens: 64,
        thinkingBudget: 0,
        temperature: 0.2,
      });
    } finally {
      globalThis.fetch = original;
    }
    return body;
  }

  it('replays the model functionCall turn alongside its results', async () => {
    const body = await capture([
      {
        calls: [{ tool: 'climate.set_temperature', args: { targetC: 22 } }],
        results: [{ tool: 'climate.set_temperature', ok: true, content: '{"targetC":22}' }],
      },
    ]);

    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);

    // The model turn must carry the call it made, under the wire name.
    const fc = body.contents[1].parts[0].functionCall;
    expect(fc.name).toBe('climate_set_temperature');
    expect(fc.args).toEqual({ targetC: 22 });

    // The result must come back as a functionResponse, not as prose.
    const fr = body.contents[2].parts[0].functionResponse;
    expect(fr.name).toBe('climate_set_temperature');
    expect(fr.response).toEqual({ result: { targetC: 22 } });
  });

  it('sends only the user turn when nothing has been called yet', async () => {
    const body = await capture(undefined);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
  });

  it('pairs every functionCall with exactly one functionResponse', async () => {
    const body = await capture([
      {
        calls: [
          { tool: 'climate.set_temperature', args: { targetC: 22 } },
          { tool: 'service.create_request', args: { category: 'maintenance' } },
        ],
        results: [
          { tool: 'climate.set_temperature', ok: true, content: '{"targetC":22}' },
          { tool: 'service.create_request', ok: false, content: 'NOT_PERMITTED' },
        ],
      },
    ]);

    const calls = body.contents[1].parts.filter((p: any) => p.functionCall);
    const responses = body.contents[2].parts.filter((p: any) => p.functionResponse);
    expect(calls).toHaveLength(2);
    expect(responses).toHaveLength(2);

    // A failure is reported as an error, never as a successful result.
    expect(responses[1].functionResponse.response).toEqual({ error: { text: 'NOT_PERMITTED' } });
  });

  it('keeps rounds in order across a multi-round turn', async () => {
    const round = (t: string) => ({
      calls: [{ tool: t, args: {} }],
      results: [{ tool: t, ok: true, content: '{}' }],
    });
    const body = await capture([round('climate.set_temperature'), round('fnb.get_menu')]);

    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect(body.contents[1].parts[0].functionCall.name).toBe('climate_set_temperature');
    expect(body.contents[3].parts[0].functionCall.name).toBe('fnb_get_menu');
  });
});
