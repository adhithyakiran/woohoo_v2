import { fastLaneEligible, getTool, type ToolDefinition, type ToolProposal } from '@woohoo/contracts';

/**
 * Three-lane router — architecture doc §24.
 *
 * Hotel voice traffic is extraordinarily head-heavy, so paying full agentic reasoning for
 * "turn off the lights" spends ~800ms and a Gemini call to answer a question a small matcher
 * answers in a few milliseconds with higher reliability.
 *
 * The counter-argument — that a fast path rots — is real, which is why fast-lane rules here are
 * validated by shadow evaluation (§24.3) rather than hand-maintained on trust.
 */

export type Lane = 'fast' | 'agentic' | 'clarify' | 'confirm';

export interface RouteDecision {
  lane: Lane;
  /** Fast lane only: the single action to execute. */
  proposal?: ToolProposal;
  /** Clarify lane only: the question to ask. */
  question?: string;
  /** Confirm lane only. */
  confirmation?: { token: string; affirmative: boolean };
  matchRule?: string;
  score: number;
  reason: string;
}

export interface RouteInput {
  transcript: string;
  asrConfidence: number;
  tools: ToolDefinition[];
  /** Set when the previous turn asked for a T3 confirmation. */
  pendingConfirmationToken?: string;
  pendingClarification?: string;
  /** Zones that actually exist in this room, for ambiguity detection. */
  lightingZones: string[];
  degradationLevel: number;
}

const CONF_FAST = 0.85;
const CONF_CLARIFY = 0.6;

interface FastRule {
  id: string;
  test: RegExp;
  build(m: RegExpMatchArray, input: RouteInput): ToolProposal | undefined;
}

/**
 * The fast-lane grammar. Deliberately narrow: every rule is a single action with all slots
 * filled, no free text and no anaphora. Anything needing judgement belongs to the agent.
 */
const FAST_RULES: FastRule[] = [
  // Both word orders matter: guests say "turn on the lights" at least as often as "turn the
  // lights on", and a fast-lane rule that only matches one of them silently halves its own
  // coverage while looking like it works.
  {
    id: 'lights.on',
    test: /^(?:please\s+)?(?:(?:turn|switch)\s+(?:on\s+(?:the\s+)?lights?|(?:the\s+)?lights?\s+on)|lights?\s+on)$/i,
    build: (_m, i) => ({ tool: 'lighting.set', args: { zone: soleZone(i) ?? 'bedroom', on: true } }),
  },
  {
    id: 'lights.off',
    test: /^(?:please\s+)?(?:(?:turn|switch)\s+(?:off\s+(?:the\s+)?lights?|(?:the\s+)?lights?\s+(?:off|out))|lights?\s+(?:off|out))$/i,
    build: (_m, i) => ({ tool: 'lighting.set', args: { zone: soleZone(i) ?? 'bedroom', on: false } }),
  },
  {
    id: 'dnd.on',
    test: /^(turn on |enable |set )?(do not disturb|dnd)( on| please)?$/i,
    build: () => ({ tool: 'dnd.set', args: { state: 'dnd' } }),
  },
  {
    id: 'dnd.off',
    test: /^(turn off |disable |cancel )(do not disturb|dnd)$/i,
    build: () => ({ tool: 'dnd.set', args: { state: 'off' } }),
  },
  {
    id: 'makeup.room',
    test: /^(please )?(make up|clean) (my |the )?room$/i,
    build: () => ({ tool: 'dnd.set', args: { state: 'make_up_room' } }),
  },
  {
    // Non-capturing groups throughout, and a named capture for the value. Positional indices
    // silently shift when anyone edits an alternation — which is exactly how this rule broke.
    id: 'climate.absolute',
    test: /^(?:set\s+|make\s+)?(?:the\s+)?(?:temperature|temp|thermostat|ac|air\s?con(?:ditioning)?)\s+(?:to\s+)?(?<value>\d{2}(?:\.\d)?)\s*(?:degrees?|c|celsius)?$/i,
    build: (m) => {
      const value = m.groups?.value;
      if (!value) return undefined;
      return {
        tool: 'climate.set_temperature',
        args: { zone: 'bedroom', targetC: Number(value) },
      };
    },
  },
  {
    id: 'curtains.close',
    test: /^(please )?(close|shut|draw) (the )?(curtains?|blinds?|drapes?)$/i,
    build: () => ({ tool: 'curtains.set', args: { zone: 'bedroom', position: 0 } }),
  },
  {
    id: 'curtains.open',
    test: /^(please )?open (the )?(curtains?|blinds?|drapes?)$/i,
    build: () => ({ tool: 'curtains.set', args: { zone: 'bedroom', position: 100 } }),
  },
  {
    id: 'tv.off',
    test: /^(turn |switch )?(the )?(tv|television) off$/i,
    build: () => ({ tool: 'tv.control', args: { power: 'off' } }),
  },
  {
    id: 'stay.info',
    test: /^(what('s| is) the )?(wifi|wi-?fi)( password)?\??$|^when (is|do i) (check ?out|need to check out)\??$/i,
    build: () => ({ tool: 'stay.get_info', args: {} }),
  },
  {
    id: 'service.status',
    test: /^(what('s| is) the )?status( of my requests?)?\??$/i,
    build: () => ({ tool: 'service.get_status', args: {} }),
  },
  {
    id: 'staff.connect',
    test: /^(connect me to |call |get me )?(the )?(front desk|reception)$/i,
    build: () => ({ tool: 'staff.connect', args: { department: 'front_desk' } }),
  },
];

/** Words that carry a referent the fast lane cannot resolve on its own (§28.1). */
const ANAPHORA = /\b(it|that|them|those|the other one|same as|again)\b/i;
/** Relative changes need current state, so they are never fast-lane (§24.2). */
const RELATIVE = /\b(warmer|cooler|colder|hotter|brighter|dimmer|a bit|a little|more|less|up|down)\b/i;

export class Router {
  route(input: RouteInput): RouteDecision {
    const text = input.transcript.trim();
    const normalised = text.replace(/[.!?]+$/, '').trim();

    // Confirm lane first: a pending T3 token means the only meaningful input is yes or no, and
    // this path must not involve the model at all (§44.1).
    if (input.pendingConfirmationToken) {
      const affirmative = /^(yes|yeah|yep|yes please|go ahead|confirm|do it|place it|ok|okay|sure)$/i.test(
        normalised,
      );
      const negative = /^(no|nope|cancel|don'?t|stop|forget it|never ?mind)$/i.test(normalised);
      if (affirmative || negative) {
        return {
          lane: 'confirm',
          confirmation: { token: input.pendingConfirmationToken, affirmative },
          score: 1,
          matchRule: 'confirm.yes_no',
          reason: 'Answering a pending confirmation.',
        };
      }
      // Anything else discards the pending action rather than guessing at consent.
      return {
        lane: 'agentic',
        score: 0,
        reason: 'Pending confirmation was not answered yes or no; treating as a new request.',
      };
    }

    if (input.asrConfidence < CONF_CLARIFY) {
      return {
        lane: 'clarify',
        question: "Sorry, I didn't catch that — could you say it again?",
        score: input.asrConfidence,
        matchRule: 'clarify.low_confidence',
        reason: `ASR confidence ${input.asrConfidence.toFixed(2)} below ${CONF_CLARIFY}.`,
      };
    }

    // Ambiguous referent with no session context to resolve it. Never guess between two
    // physical devices — a wrong guess on "turn off the light" in a suite is worse than asking.
    if (ANAPHORA.test(normalised) && !input.pendingClarification) {
      const ambiguousLight = /light|lamp/i.test(normalised) && input.lightingZones.length > 1;
      if (ambiguousLight) {
        return {
          lane: 'clarify',
          question: `Which lights would you like — ${listOf(input.lightingZones)}?`,
          score: 0.5,
          matchRule: 'clarify.ambiguous_zone',
          reason: 'Anaphoric reference to lights in a multi-zone room.',
        };
      }
    }

    // Degradation level 2+ is fast-lane only (§68); the orchestrator has already decided that,
    // and a non-matching utterance there gets the reduced-scope message rather than the agent.
    const available = new Set(input.tools.map((t) => t.name));

    if (input.asrConfidence >= CONF_FAST && !RELATIVE.test(normalised) && !ANAPHORA.test(normalised)) {
      for (const rule of FAST_RULES) {
        const m = normalised.match(rule.test);
        if (!m) continue;
        const proposal = rule.build(m, input);
        if (!proposal) continue;
        if (!available.has(proposal.tool)) continue;

        const def = getTool(proposal.tool);
        // The fast lane may never serve T3 or above — money and irreversible actions always
        // get full reasoning plus explicit confirmation (§24.2).
        if (!def || !fastLaneEligible(def.meta.tier)) continue;

        return {
          lane: 'fast',
          proposal,
          matchRule: rule.id,
          score: input.asrConfidence,
          reason: `Matched fast-path rule ${rule.id}.`,
        };
      }
    }

    return {
      lane: 'agentic',
      score: input.asrConfidence,
      reason: 'No deterministic match; full reasoning required.',
    };
  }
}

function soleZone(i: RouteInput): string | undefined {
  return i.lightingZones.length === 1 ? i.lightingZones[0] : undefined;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}
