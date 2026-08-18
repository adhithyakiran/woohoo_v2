import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from './llm.js';

/** One tool outcome, flattened out of the per-round history. */
type ToolResult = { tool: string; ok: boolean; content: string };

/**
 * Deterministic mock provider.
 *
 * This is a test double, not a second implementation of the agent. It exists so the whole
 * stack — orchestrator, PDP, gateway, adapters, audit — runs and is verifiable in CI and on a
 * laptop with no API key and no network. The eval suites in §72 assert on TOOL CALLS and
 * POLICY VERDICTS, which is the thing that actually matters (§72, "evaluating the model
 * instead of the system"), and those assertions hold regardless of which provider produced
 * the proposal.
 *
 * When GOOGLE_API_KEY is present the runtime uses GeminiProvider instead and the same suites
 * run against the real model.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock';

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const utterance = extractUtterance(req.user).toLowerCase();
    const available = new Set(req.tools.map((t) => t.name));
    const state = extractState(req.user);

    // Second round of the loop. A real agent reads the menu it just fetched and then proposes
    // an order from genuine item ids — it never invents one. Modelling that here is what makes
    // the T3 confirmation path (§44.1) exercisable end to end without an API key.
    // Flatten every prior round: the mock reasons over everything it has learned this turn,
    // not just the most recent call.
    const priorResults = (req.rounds ?? []).flatMap((r) => r.results);
    if (priorResults.length) {
      const order = planOrderFromMenu(utterance, priorResults, available);
      if (order) {
        return {
          toolCalls: [order],
          usage: usageFor(req),
          model: this.model,
          finishReason: 'tool_calls',
          reasoningSummary: 'ordering from fetched menu',
        };
      }
      return respond(compose(priorResults), req);
    }

    const calls = plan(utterance, available, state);
    if (!calls.length) {
      return respond(refusalFor(utterance), req);
    }
    return {
      toolCalls: calls,
      usage: usageFor(req),
      model: this.model,
      finishReason: 'tool_calls',
      reasoningSummary: `matched ${calls.map((c) => c.tool).join(', ')}`,
    };
  }
}

interface ParsedState {
  setpointC?: number;
  brightness?: number;
  lightsOn?: boolean;
}

function plan(u: string, available: Set<string>, state: ParsedState): LlmToolCall[] {
  const can = (t: string) => available.has(t);
  const calls: LlmToolCall[] = [];
  const zone = /living|lounge/.test(u) ? 'living' : /bath/.test(u) ? 'bathroom' : 'bedroom';

  // Safety first — evaluated before anything else, exactly as §48 requires of the real path.
  const distress = detectDistress(u);
  if (distress && can('staff.escalate_urgent')) {
    return [{ tool: 'staff.escalate_urgent', args: { category: distress, summary: u.slice(0, 200) } }];
  }

  // Requests about other rooms or other guests are refused, not routed. No tool can express
  // them anyway (§45), but the model should not try.
  if (/room (\d{3,4})|next door|another room|who is (in|staying)|other guest/.test(u)) {
    return [];
  }
  if (/unlock|open the door|door lock/.test(u)) return [];

  if (/curtain|blind|drape/.test(u) && can('curtains.set')) {
    const close = /clos|shut|draw/.test(u);
    calls.push({ tool: 'curtains.set', args: { zone, position: close ? 0 : 100 } });
  }

  if (/light|lamp|bright|dim|dark/.test(u) && can('lighting.set')) {
    if (/dim|dimmer|lower|softer|darker/.test(u)) {
      const current = state.brightness ?? 70;
      calls.push({ tool: 'lighting.set', args: { zone, brightness: Math.max(10, current - 30) } });
    } else if (/bright|brighter|more light|turn up/.test(u)) {
      const current = state.brightness ?? 40;
      calls.push({ tool: 'lighting.set', args: { zone, brightness: Math.min(100, current + 30) } });
    } else {
      const off = /off|out\b|kill/.test(u);
      calls.push({ tool: 'lighting.set', args: { zone, on: !off } });
    }
  }

  if (
    /cold|freezing|chilly|warm|hot|boiling|stuffy|temperature|degrees|heat|cool|ac\b|air con/.test(u) &&
    can('climate.set_temperature')
  ) {
    const explicit = u.match(/(\d{2}(?:\.\d)?)\s*(?:degrees?|c\b|celsius)/);
    if (explicit?.[1]) {
      calls.push({ tool: 'climate.set_temperature', args: { zone, targetC: Number(explicit[1]) } });
    } else {
      // Relative change — this is the case Dialogflow could not do, and it needs current state.
      const current = state.setpointC ?? 22;
      const warmer = /cold|freezing|chilly|warm|heat/.test(u) && !/too (warm|hot)/.test(u);
      const delta = warmer ? 3 : -3;
      calls.push({
        tool: 'climate.set_temperature',
        args: { zone, targetC: clamp(Math.round((current + delta) * 2) / 2, 16, 30) },
      });
    }
  }

  if (/do not disturb|dnd|privacy/.test(u) && can('dnd.set')) {
    calls.push({ tool: 'dnd.set', args: { state: /off|cancel|clear/.test(u) ? 'off' : 'dnd' } });
  }
  if (/make up (my |the )?room|clean my room/.test(u) && can('dnd.set')) {
    calls.push({ tool: 'dnd.set', args: { state: 'make_up_room' } });
  }

  // Service requests — free text means judgement, which is why the fast lane never takes these.
  if (
    /fix|broken|not working|leak|drip|repair|blocked|flood|overflow|burst|spill|won't|wont /.test(u) &&
    can('service.create_request')
  ) {
    calls.push({
      tool: 'service.create_request',
      args: {
        category: 'maintenance',
        description: u.slice(0, 300),
        priority: /flood|urgent|emergency|water everywhere/.test(u) ? 'urgent' : 'normal',
      },
    });
  } else if (/towel|pillow|blanket|toiletr|amenit|slipper/.test(u) && can('service.create_request')) {
    calls.push({
      tool: 'service.create_request',
      args: { category: 'amenity', description: u.slice(0, 300), priority: 'normal' },
    });
  } else if (/housekeep|clean|tidy|turn ?down|rubbish|bin\b/.test(u) && can('service.create_request')) {
    calls.push({
      tool: 'service.create_request',
      args: { category: 'housekeeping', description: u.slice(0, 300), priority: 'normal' },
    });
  }

  // Ordering always begins by reading the menu: item ids must come from fnb.get_menu, never
  // from the model's memory of what a hotel probably serves.
  if (
    /menu|what.*(eat|food)|room service|hungry|order|bring me|i'?d like|can i (get|have)/.test(u) &&
    can('fnb.get_menu')
  ) {
    calls.push({ tool: 'fnb.get_menu', args: {} });
  }

  if (/checkout|check out|wifi|wi-fi|password|my bill|folio/.test(u) && can('stay.get_info')) {
    calls.push({ tool: 'stay.get_info', args: {} });
  }

  if (/wake me|wake-?up call|alarm/.test(u) && can('stay.set_wakeup_call')) {
    const t = u.match(/(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?/);
    if (t) {
      let h = Number(t[1]);
      const m = t[2] ?? '00';
      if (t[3] === 'pm' && h < 12) h += 12;
      if (t[3] === 'am' && h === 12) h = 0;
      calls.push({
        tool: 'stay.set_wakeup_call',
        args: { action: 'set', time: `${String(h).padStart(2, '0')}:${m}` },
      });
    }
  }

  if (/pool|gym|spa|breakfast|restaurant|open|hours|where is|how do i get/.test(u) && can('property.search_knowledge')) {
    calls.push({ tool: 'property.search_knowledge', args: { query: u.slice(0, 180) } });
  }

  if (/front desk|reception|speak to|talk to someone|concierge/.test(u) && can('staff.connect')) {
    calls.push({ tool: 'staff.connect', args: { department: 'front_desk' } });
  }

  if (/status|where.*(my|the) (towel|order|food)|how long/.test(u)) {
    if (can('service.get_status')) calls.push({ tool: 'service.get_status', args: {} });
  }

  return calls.slice(0, 3);
}

/**
 * Match the guest's words against the menu that was actually returned, and propose an order
 * only for items that really exist. Quantities default to one; "two beers" is honoured.
 */
function planOrderFromMenu(
  u: string,
  results: ToolResult[],
  available: Set<string>,
): LlmToolCall | undefined {
  if (!available.has('fnb.place_order')) return undefined;
  if (!/order|bring me|i'?d like|can i (get|have)|send up|room service/.test(u)) return undefined;

  const menuResult = results.find((r) => r.tool === 'fnb.get_menu' && r.ok);
  if (!menuResult) return undefined;

  const menu = safeParse(stripFence(menuResult.content)) as
    | Array<{ id: string; name: string; keywords?: string[] }>
    | undefined;
  if (!Array.isArray(menu) || !menu.length) return undefined;

  const items: Array<{ menuItemId: string; quantity: number }> = [];
  for (const item of menu) {
    // Match the full name, its significant words, and the item's spoken aliases. Without the
    // aliases "a beer" never resolves to "Kingfisher Premium" and the guest silently loses it.
    const candidates = [
      item.name.toLowerCase(),
      ...item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
      ...(item.keywords ?? []).map((k) => k.toLowerCase()),
    ];
    if (!candidates.some((c) => u.includes(c))) continue;
    const qty = /\btwo\b|\b2\b/.test(u) ? 2 : /\bthree\b|\b3\b/.test(u) ? 3 : 1;
    items.push({ menuItemId: item.id, quantity: qty });
  }

  return items.length ? { tool: 'fnb.place_order', args: { items } } : undefined;
}

/** Menu results arrive fenced as untrusted content (§46); unwrap before parsing. */
function stripFence(s: string): string {
  const m = s.match(/<untrusted[^>]*>\s*([\s\S]*?)\s*<\/untrusted>/);
  return m?.[1] ?? s;
}

function detectDistress(u: string): 'medical' | 'fire' | 'security' | 'welfare' | undefined {
  if (/chest pain|can'?t breathe|heart attack|stroke|bleeding|ambulance|unconscious|choking/.test(u)) {
    return 'medical';
  }
  if (/fire\b|smoke|burning smell/.test(u)) return 'fire';
  if (/someone (is )?(in|outside) my room|intruder|being followed|unsafe|threatened/.test(u)) {
    return 'security';
  }
  if (/want to die|kill myself|end my life|hurt myself|self.?harm/.test(u)) return 'welfare';
  return undefined;
}

function refusalFor(u: string): string {
  if (/unlock|open the door|door lock/.test(u)) {
    return "I'm not able to control the door lock. The front desk can help with that.";
  }
  if (/room \d{3,4}|next door|another room|who is (in|staying)|other guest/.test(u)) {
    return 'I can only help with your own room.';
  }
  return "I'm not sure about that one — would you like me to connect you to the front desk?";
}

function compose(results: ToolResult[]): string {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    return "I couldn't do that just now. Would you like me to connect you to the front desk?";
  }
  const parts = results.filter((r) => r.ok).map((r) => summarise(r.tool, r.content));
  const tail = failed.length ? " I couldn't manage the rest of that, though." : '';
  return parts.filter(Boolean).join(' ') + tail;
}

function summarise(tool: string, content: string): string {
  const v = safeParse(content);
  switch (tool) {
    // On a pending outcome the observed value is what the room STILL reads, not what was
    // asked for. Quoting it produces "I've asked for 19.5 degrees" to a guest who said 26.
    // The tool result carries no copy of the request, so the honest reply names no number.
    case 'climate.set_temperature': {
      const s = v?.observed?.value ?? v?.value;
      if (v?.status === 'pending') return "I've asked for that — give it a moment.";
      // Never interpolate a missing reading: "I've set it to undefined degrees" is worse
      // than saying nothing at all.
      return s == null ? 'Done.' : `I've set it to ${s} degrees.`;
    }
    case 'lighting.set':
      return v?.status === 'pending' ? "I've asked for that light change." : 'Done with the lights.';
    case 'curtains.set':
      if (v?.status === 'pending') return "I've asked for that — give it a moment.";
      return Number(v?.observed?.value ?? 0) > 50 ? 'Curtains open.' : 'Curtains closed.';
    case 'dnd.set':
      return v?.status === 'pending'
        ? "I've asked for that — give it a moment."
        : 'Do not disturb is set.';
    case 'service.create_request':
      return v?.deferred
        ? `I've logged that for maintenance — they'll come by after ${v?.dispatchAt ?? 'the morning'} so you're not disturbed tonight.`
        : `I've logged that, reference ${v?.id ?? 'noted'}.`;
    case 'stay.get_info':
      return v?.checkoutAt ? `Checkout is at ${v.checkoutAt}.` : 'Here are your stay details.';
    case 'property.search_knowledge':
      return Array.isArray(v) && v.length ? String(v[0]?.body ?? '').slice(0, 180) : "I don't have that — shall I ask the front desk?";
    case 'fnb.get_menu':
      return Array.isArray(v) && v.length
        ? `We have ${v.slice(0, 3).map((i: { name: string }) => i.name).join(', ')}. What would you like?`
        : 'The menu is not available right now.';
    case 'fnb.place_order':
      return `Ordered — about ${v?.etaMinutes ?? 30} minutes.`;
    case 'staff.connect':
      return "I'm connecting you to the front desk now.";
    case 'service.get_status':
      return Array.isArray(v) && v.length ? `You have ${v.length} open request(s).` : 'Nothing open right now.';
    default:
      return 'Done.';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function extractUtterance(user: string): string {
  const m = user.match(/<guest_utterance>\s*([\s\S]*?)\s*<\/guest_utterance>/);
  return m?.[1] ?? user;
}

/** Reads the pre-fetched state snapshot out of the assembled context (§27.2). */
function extractState(user: string): ParsedState {
  const m = user.match(/<room_state>\s*([\s\S]*?)\s*<\/room_state>/);
  if (!m?.[1]) return {};
  const v = safeParse(m[1]);
  const bedroom = v?.zones?.find((z: { zone: string }) => z.zone === 'bedroom') ?? v?.zones?.[0];
  return {
    setpointC: bedroom?.climate?.setpointC,
    brightness: bedroom?.lighting?.brightness,
    lightsOn: bedroom?.lighting?.on,
  };
}

function respond(text: string, req: LlmRequest): LlmResponse {
  return {
    toolCalls: [],
    text,
    usage: usageFor(req),
    model: 'mock',
    finishReason: 'stop',
  };
}

function usageFor(req: LlmRequest) {
  const tokensIn = Math.ceil((req.system.length + req.user.length) / 4);
  return {
    tokensIn,
    // Layers 0–2 are byte-stable and cacheable (§26.1); model the discount honestly.
    tokensCached: Math.floor(req.system.length / 4),
    tokensOut: 60,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
