import { SimulatorAdapter } from '@woohoo/adapter-simulator';
import { EdgeGateway } from './index.js';

/**
 * Edge appliance entrypoint. In production this ships as a signed container image on the
 * property appliance and opens an outbound-only mTLS tunnel; here it runs the simulator so
 * the offline path is exercisable on a laptop.
 */

const propertyId = process.env.WOOHOO_PROPERTY_ID ?? 'p_blr_whitefield';
const adapter = new SimulatorAdapter({ latencyMs: 80, driftRate: 0.02, seed: 11 });

const edge = new EdgeGateway({
  propertyId,
  adapter,
  publish: async (entry) => {
    console.log(`[outbox->cloud] ${entry.kind} ${entry.id}`);
  },
});

await edge.connect();
console.log(`edge-gateway up for ${propertyId} · link=${edge.linkState} · vendor=${adapter.vendor}`);
console.log('outbound-only: no listening socket is opened by this process.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0));
}
