import type { EvalCase } from '../runner/types.js';

/**
 * Golden suite — the top intents, phrased the way guests actually phrase them.
 * Gate: 100% on tool-call correctness. Blocks merge.
 */
export const goldenCases: EvalCase[] = [
  {
    id: 'g01-lights-on-natural',
    suite: 'golden',
    intent: 'The commonest utterance in the product must take the fast lane.',
    turns: ['turn on the lights'],
    expect: { lane: 'fast', tools: ['lighting.set'], verdicts: { 'lighting.set': 'ALLOW' } },
  },
  {
    id: 'g02-lights-on-alt-order',
    suite: 'golden',
    intent: 'Both word orders reach the fast lane — this regressed once already.',
    turns: ['turn the lights on'],
    expect: { lane: 'fast', tools: ['lighting.set'] },
  },
  {
    id: 'g03-lights-off',
    suite: 'golden',
    intent: 'Lights off, fast lane.',
    turns: ['turn off the lights'],
    expect: { lane: 'fast', tools: ['lighting.set'] },
  },
  {
    id: 'g04-climate-absolute',
    suite: 'golden',
    intent: 'An explicit temperature is deterministic and needs no model.',
    turns: ['set the temperature to 23 degrees'],
    expect: { lane: 'fast', tools: ['climate.set_temperature'], verdicts: { 'climate.set_temperature': 'ALLOW' } },
  },
  {
    id: 'g05-climate-relative',
    suite: 'golden',
    intent: 'The case Dialogflow could not do: relative change needs current state first.',
    turns: ["it's freezing in here"],
    expect: {
      lane: 'agentic',
      tools: ['climate.set_temperature'],
      stateCheck: (s) => {
        const zone = (s as { zones: Array<{ zone: string; climate?: { setpointC: number } }> }).zones.find(
          (z) => z.zone === 'bedroom',
        );
        const sp = zone?.climate?.setpointC ?? 0;
        return sp > 19.5 || `expected setpoint to rise above 19.5, got ${sp}`;
      },
    },
  },
  {
    id: 'g06-dnd',
    suite: 'golden',
    intent: 'Do not disturb, fast lane.',
    turns: ['do not disturb'],
    expect: { lane: 'fast', tools: ['dnd.set'] },
  },
  {
    id: 'g07-maintenance-freetext',
    suite: 'golden',
    intent: 'Free text means judgement, so this must never be fast-laned.',
    turns: ['send someone to fix the shower, it keeps dripping'],
    at: '2026-07-29T14:00:00',
    expect: {
      lane: 'agentic',
      tools: ['service.create_request'],
      verdicts: { 'service.create_request': 'ALLOW' },
    },
  },
  {
    id: 'g08-compound-request',
    suite: 'golden',
    intent: 'Two intents in one breath — the whole reason for V2.',
    turns: ["it's too cold and can you send someone to fix the shower"],
    at: '2026-07-29T14:00:00',
    expect: { tools: ['climate.set_temperature', 'service.create_request'] },
  },
  {
    id: 'g09-duplicate-suppression',
    suite: 'golden',
    intent: 'A second identical request is suppressed rather than dispatched twice.',
    turns: ['the shower is dripping, send maintenance', 'the shower is still dripping, send someone'],
    at: '2026-07-29T14:00:00',
    expect: { ruleId: 'R8.duplicate_request' },
  },
  {
    id: 'g10-knowledge-grounded',
    suite: 'golden',
    intent: 'Property facts come from the knowledge tool, never from model memory.',
    turns: ['what time does the pool open'],
    expect: { tools: ['property.search_knowledge'] },
  },
  {
    id: 'g11-knowledge-unknown',
    suite: 'golden',
    intent: '"I do not know" is a correct answer and must route to a human.',
    turns: ['is there a helicopter pad on the roof'],
    expect: { speechForbids: ['yes, there is'] },
  },
  {
    id: 'g12-stay-info',
    suite: 'golden',
    intent: 'Checkout and wifi resolve only for this room.',
    turns: ['what is the wifi password'],
    expect: { lane: 'fast', tools: ['stay.get_info'] },
  },
  {
    id: 'g13-quiet-hours-defer',
    suite: 'golden',
    intent: 'Night-time non-urgent work is queued for morning and the guest is told.',
    turns: ['the tap is dripping, can someone look at it'],
    at: '2026-07-29T23:14:00',
    expect: { ruleId: 'R7.quiet_hours_defer', speechContains: ['07:00'] },
  },
  {
    id: 'g14-urgent-not-deferred',
    suite: 'golden',
    intent: 'Urgent work dispatches immediately regardless of the hour.',
    turns: ['there is water flooding the bathroom, this is urgent'],
    at: '2026-07-29T23:14:00',
    expect: { tools: ['service.create_request'], verdicts: { 'service.create_request': 'ALLOW' } },
  },
  {
    id: 'g15-fnb-order-confirm',
    suite: 'golden',
    intent: 'Ordering reads the real menu, then asks with the total before charging.',
    turns: ["I'd like a club sandwich and a beer"],
    expect: {
      tools: ['fnb.get_menu', 'fnb.place_order'],
      verdicts: { 'fnb.place_order': 'CONFIRM' },
      awaitingConfirmation: true,
      speechContains: ['1240', 'shall i place it'],
    },
  },
  {
    id: 'g16-fnb-order-execute',
    suite: 'golden',
    intent: 'A confirmed order executes the frozen action and states the charge.',
    turns: ["I'd like a club sandwich and a beer", 'yes'],
    expect: {
      lane: 'confirm',
      verdicts: { 'fnb.place_order': 'ALLOW' },
      awaitingConfirmation: false,
      speechContains: ['1240'],
    },
  },
  {
    id: 'g17-fnb-decline',
    suite: 'golden',
    intent: 'Declining charges nothing and says so plainly.',
    turns: ["I'd like a club sandwich", 'no'],
    expect: { speechContains: ["haven't ordered"], awaitingConfirmation: false },
  },
  {
    id: 'g18-staff-connect',
    suite: 'golden',
    intent: 'The route to a human is always available.',
    turns: ['connect me to the front desk'],
    expect: { lane: 'fast', tools: ['staff.connect'] },
  },
  {
    id: 'g19-low-confidence-clarify',
    suite: 'golden',
    intent: 'Poor ASR asks again rather than guessing at an action.',
    turns: ['mumble mumble something'],
    asrConfidence: 0.4,
    expect: { lane: 'clarify', forbidTools: ['lighting.set', 'climate.set_temperature'] },
  },
  {
    id: 'g20-curtains-suite',
    suite: 'golden',
    intent: 'A room type with curtains can close them.',
    device: 'd_511a',
    turns: ['close the curtains'],
    expect: { tools: ['curtains.set'], verdicts: { 'curtains.set': 'ALLOW' } },
  },
];
