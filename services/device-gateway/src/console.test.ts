import { describe, expect, it } from 'vitest';
import { CONSOLE_HTML } from './console.js';

/**
 * The console is assembled as one raw string, so the compiler never looks inside it. A single
 * stray quote is shippable, and the browser's response is to abort the whole script block:
 * health check, scenario buttons, endpoint list and the Send handler all stop at once, with a
 * page that still renders and a server that still reports healthy.
 *
 * That is not hypothetical. A malformed curl snippet did exactly this, and the only symptom
 * was a set of empty boxes. Parsing the emitted script is the cheapest way to make it loud.
 */
const SCRIPT = CONSOLE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

/** Pull one function out of the page script by brace matching. */
function extractFn(name: string): string {
  const start = SCRIPT.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in console script');
  let depth = 0;
  let seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    const c = SCRIPT[i];
    if (c === '{') { depth++; seen = true; }
    else if (c === '}') {
      depth--;
      if (seen && depth === 0) return SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

/**
 * Run renderConnect() against stubs and return the HTML it produced.
 *
 * `hostBox` is what the reader typed into the target-host field; empty means "leave it as the
 * address this page was served from", which under an SSH tunnel is localhost.
 */
function renderConnectHtml(hostBox = ''): string {
  let out = '';
  const fn = new Function(
    'location',
    '$',
    'document',
    [extractFn('esc'), extractFn('codeBlock'), extractFn('renderConnect'), 'renderConnect();'].join(
      '\n',
    ),
  ) as (l: unknown, q: (s: string) => unknown, d: unknown) => void;

  fn(
    { protocol: 'http:', host: 'localhost:8443', origin: 'http://localhost:8443' },
    (sel: string) => {
      if (sel === '#dev') return { value: 'd_412a' };
      if (sel === '#chost') return { value: hostBox };
      return {
        set innerHTML(v: string) {
          out = v;
        },
      };
    },
    { querySelectorAll: () => [] },
  );
  return out;
}

describe('console page', () => {
  it('emits a script block', () => {
    expect(SCRIPT.length).toBeGreaterThan(0);
  });

  it('every script block is syntactically valid JavaScript', () => {
    const blocks = [...CONSOLE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const [i, src] of blocks.entries()) {
      // `new Function` parses without executing, so no DOM is needed.
      expect(() => new Function(src), 'script block ' + i + ' failed to parse').not.toThrow();
    }
  });

  it('contains no backticks or template placeholders inside the raw literal', () => {
    // String.raw ends at the first backtick, so one in a comment truncates the page.
    expect(CONSOLE_HTML).not.toContain('`');
    expect(CONSOLE_HTML).not.toContain('${');
  });

  it('references the endpoints the gateway actually serves', () => {
    for (const path of ['/v1/turn', '/health', '/v1/events']) {
      expect(CONSOLE_HTML).toContain(path);
    }
  });
});

/**
 * The Connect pane is what another team copies to integrate. A malformed example there is a
 * support ticket from someone who cannot tell whether the service or their client is at fault.
 */
describe('connect pane examples', () => {
  const html = renderConnectHtml();

  it('lists every endpoint an integrator needs', () => {
    expect(html).toContain('http://localhost:8443/v1/turn');
    expect(html).toContain('ws://localhost:8443');
    expect(html).toContain('http://localhost:8443/v1/events');
    expect(html).toContain('http://localhost:8443/health');
  });

  it('produces a curl example whose payload is valid JSON', () => {
    const decoded = [...html.matchAll(/data-code="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!));
    const curl = decoded.find((c) => c.startsWith('curl -X POST'));
    expect(curl, 'no curl example found').toBeTruthy();

    const payload = curl!.slice(curl!.indexOf("-d '") + 4, curl!.lastIndexOf("'"));
    expect(() => JSON.parse(payload)).not.toThrow();
    // The gateway requires `transcript`; sending `text` returns 400.
    expect(JSON.parse(payload)).toHaveProperty('transcript');
    expect(JSON.parse(payload)).toHaveProperty('deviceId');
  });

  it('uses curl.exe in the PowerShell example', () => {
    // Plain `curl` in PowerShell is an alias for Invoke-WebRequest and rejects these flags.
    expect(html).toContain('curl.exe');
  });

  it('offers a websocket example that says hello before sending a turn', () => {
    const decoded = [...html.matchAll(/data-code="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!));
    const ws = decoded.find((c) => c.includes('new WebSocket'));
    expect(ws).toBeTruthy();
    expect(ws!.indexOf('"hello"')).toBeLessThan(ws!.indexOf('"turn"'));
  });
});

/**
 * A turn reaches the console twice: once from its own response, once from the SSE feed. The
 * server broadcasts before the response is parsed, so the feed usually arrives FIRST. An
 * ownership check that assumed the opposite order drew every turn twice — which, on a console
 * used to verify hotel behaviour, reads as the assistant having acted twice.
 */
describe('turn card de-duplication', () => {
  function harness() {
    const code = [
      'const cards = new Map(); let selected = null;',
      'function inspect(){}',
      extractFn('esc'),
      extractFn('laneClass'),
      extractFn('renderTurn'),
      'return { renderTurn: renderTurn, cards: cards };',
    ].join('\n');

    const flow: { cards: unknown[]; querySelector: () => null; prepend: (el: unknown) => void } & Record<string, unknown> = {
      cards: [],
      querySelector: () => null,
      prepend(el: unknown) {
        (this.cards as unknown[]).unshift(el);
      },
    };
    const make = () => ({
      className: '',
      innerHTML: '',
      onclick: null,
      replaceWith(next: unknown) {
        const i = (flow.cards as unknown[]).indexOf(this);
        if (i >= 0) (flow.cards as unknown[])[i] = next;
      },
      remove() {
        const i = (flow.cards as unknown[]).indexOf(this);
        if (i >= 0) (flow.cards as unknown[]).splice(i, 1);
      },
    });

    const fn = new Function('document', '$', code) as (d: unknown, q: unknown) => { renderTurn: Function; cards: Map<string, { el: { innerHTML: string } }> };
    const api = fn({ createElement: make }, () => flow);
    return { ...api, flow };
  }

  it('renders one card when the feed and the response both report the same turn', () => {
    const h = harness();
    // Feed first — the order that actually occurs in the browser.
    h.renderTurn({ turnId: 't1', transcript: 'its cold', speech: 'Done.', lane: 'agentic' }, 'feed');
    h.renderTurn({ turnId: 't1', transcript: 'its cold', speech: 'Done.', status: 200 }, 'self');
    expect(h.flow.cards).toHaveLength(1);
  });

  it('drops the external badge once the console claims the turn', () => {
    const h = harness();
    h.renderTurn({ turnId: 't2', transcript: 'hi', speech: 'Hello' }, 'feed');
    expect((h.flow.cards[0] as { innerHTML: string }).innerHTML).toContain('external');

    h.renderTurn({ turnId: 't2', transcript: 'hi', speech: 'Hello' }, 'self');
    expect((h.flow.cards[0] as { innerHTML: string }).innerHTML).not.toContain('external');
  });

  it('keeps the external badge for a turn this console never sent', () => {
    const h = harness();
    h.renderTurn({ turnId: 't3', transcript: 'from curl', speech: 'ok' }, 'feed');
    expect((h.flow.cards[0] as { innerHTML: string }).innerHTML).toContain('external');
  });

  it('does not let a later empty call list erase calls already shown', () => {
    const h = harness();
    h.renderTurn(
      {
        turnId: 't4',
        transcript: 'warm it up',
        speech: 'Done',
        calls: [{ tool: 'climate.set_temperature', tier: 'T1', verdict: 'ALLOW', ok: true }],
      },
      'feed',
    );
    // The WS path reports no calls, because the speak frame carries none.
    h.renderTurn({ turnId: 't4', transcript: 'warm it up', speech: 'Done', calls: [] }, 'self');

    expect(h.flow.cards).toHaveLength(1);
    expect((h.flow.cards[0] as { innerHTML: string }).innerHTML).toContain('climate.set_temperature');
  });

  it('clears the running badge once the turn completes', () => {
    const h = harness();
    h.renderTurn({ turnId: 't5', transcript: 'lights', running: true }, 'feed');
    expect((h.flow.cards[0] as { innerHTML: string }).innerHTML).toContain('running');

    h.renderTurn({ turnId: 't5', transcript: 'lights', speech: 'Done', lane: 'fast' }, 'self');
    expect((h.flow.cards[0] as { innerHTML: string }).innerHTML).not.toContain('running');
  });

  it('keeps separate turns on separate cards', () => {
    const h = harness();
    h.renderTurn({ turnId: 'a', transcript: 'one', speech: 'x' }, 'self');
    h.renderTurn({ turnId: 'b', transcript: 'two', speech: 'y' }, 'self');
    expect(h.flow.cards).toHaveLength(2);
  });
});

/**
 * The console is normally reached through an SSH tunnel, so location.origin is localhost and
 * every generated command would only run on the tester's own machine. Handing one of those to
 * a colleague produces a confusing "connection refused" that looks like a broken service.
 */
describe('connect pane target host', () => {
  const html = renderConnectHtml;

  it('regenerates every example against the host that was typed in', () => {
    const out = html('65.1.106.31:8443');
    expect(out).toContain('http://65.1.106.31:8443/v1/turn');
    expect(out).toContain('ws://65.1.106.31:8443');
    expect(out).not.toContain('localhost:8443');
  });

  it('warns that tunnelled localhost commands only work on this machine', () => {
    const out = html('');
    expect(out).toMatch(/only work on this machine/i);
  });

  it('warns about exposure once a non-local host is targeted', () => {
    const out = html('65.1.106.31:8443');
    // There is no auth on /v1/turn yet; opening it wide is a real cost and safety problem.
    expect(out).toMatch(/no authentication/i);
  });
});

/**
 * The Connect pane has to answer the three questions that actually block an integrator, or
 * they end up asking in Slack: which id identifies the room, what the transcript field is
 * called, and whether the port is even open to them.
 */
describe('connect pane guidance', () => {
  const html = renderConnectHtml();

  it('names the required request fields', () => {
    expect(html).toContain('deviceId');
    expect(html).toContain('transcript');
    expect(html).toContain('asrConfidence');
  });

  it('warns that the field is transcript, not text', () => {
    // A wrong field name returns 400 and reads like the service is broken. This exact
    // mistake was made in written instructions once already.
    expect(html).toContain('<span class="r">text</span>');
    expect(html).toMatch(/returns 400/i);
  });

  it('documents the response fields a client will use', () => {
    for (const field of ['speech', 'calls', 'guardrails', 'vendorCalls', 'pipeline', 'lane']) {
      expect(html).toContain(field);
    }
  });

  it('lists every seeded room with what makes it different', () => {
    for (const dev of ['d_412a', 'd_511a', 'd_512a']) {
      expect(html).toContain(dev);
    }
  });

  it('tells the reader to check reachability before anything else', () => {
    expect(html).toMatch(/Test reachability/i);
  });
});

/**
 * The Rooms pane is the answer to "how do I add a room". It has to state the one fact that
 * causes real damage when assumed: the vendor room id is not the hotel room number. Getting
 * that wrong actuates a stranger's room while every log reports success.
 */
describe('rooms pane', () => {
  const SRC = SCRIPT;

  it('is registered as a pane and a tab', () => {
    expect(CONSOLE_HTML).toContain('data-p="rooms"');
    expect(CONSOLE_HTML).toContain('id="p-rooms"');
    expect(SRC).toContain("'rooms'");
  });

  it('warns that the vendor id is not the room number', () => {
    expect(SRC).toMatch(/Not the room number/i);
  });

  it('documents the external catalog contract', () => {
    expect(SRC).toContain('WOOHOO_CATALOG_URL');
    expect(SRC).toContain('/devices/:deviceId');
  });

  it('explains why provisioning is kept off the MCP tool surface', () => {
    // Provisioning on MCP would let the model be argued into binding a device to any room.
    expect(SRC).toMatch(/not an MCP tool/i);
  });

  it('points at the admin endpoint with a token header', () => {
    expect(SRC).toContain('/v1/admin/rooms');
    expect(SRC).toContain('x-admin-token');
  });
});
