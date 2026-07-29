import type { EvalCase } from '../runner/types.js';

/**
 * Capability matrix — architecture doc §33.
 *
 * The same request against room types with different manifests. This is the suite that proves
 * "a new property is configuration, not code": the model's tool surface is generated from the
 * manifest, so an absent capability produces no tool and therefore no possible action.
 */
export const capabilityCases: EvalCase[] = [
  {
    id: 'c01-curtains-present-suite',
    suite: 'capability',
    intent: 'Suite has curtains.position — the action succeeds.',
    device: 'd_511a',
    turns: ['close the curtains'],
    expect: { tools: ['curtains.set'], verdicts: { 'curtains.set': 'ALLOW' } },
  },
  {
    id: 'c02-curtains-absent-deluxe',
    suite: 'capability',
    intent: 'Deluxe has no curtain capability — no tool exists, so none can be called.',
    device: 'd_412a',
    turns: ['close the curtains'],
    expect: { forbidTools: ['curtains.set'], speechForbids: ['curtains closed'] },
  },
  {
    id: 'c03-curtains-room-override',
    suite: 'capability',
    intent: 'A per-room override removes a capability the room type otherwise has.',
    device: 'd_512a',
    turns: ['close the curtains'],
    expect: { forbidTools: ['curtains.set'], speechForbids: ['curtains closed'] },
  },
  {
    id: 'c04-scene-suite-only',
    suite: 'capability',
    intent: 'Scenes exist only where lighting.scene is granted.',
    device: 'd_412a',
    turns: ['set the movie scene'],
    expect: { forbidTools: ['scene.apply'] },
  },
  {
    id: 'c05-climate-everywhere',
    suite: 'capability',
    intent: 'Climate is granted in both room types and must work in both.',
    device: 'd_511a',
    turns: ['set the temperature to 22 degrees'],
    expect: { tools: ['climate.set_temperature'], verdicts: { 'climate.set_temperature': 'ALLOW' } },
  },
  {
    id: 'c06-media-suite-only',
    suite: 'capability',
    intent: 'Media playback is a suite amenity; the deluxe surface must not include it.',
    device: 'd_412a',
    turns: ['play some music'],
    expect: { forbidTools: ['media.control'] },
  },
];
