import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const p = (...s: string[]) => resolve(root, ...s);

export default defineConfig({
  resolve: {
    alias: {
      '@woohoo/contracts': p('packages/contracts/src/index.ts'),
      '@woohoo/otel': p('packages/otel/src/index.ts'),
      '@woohoo/policy': p('services/policy-service/src/index.ts'),
      '@woohoo/core': p('services/woohoo-core/src/index.ts'),
      '@woohoo/adapter-simulator': p('services/adapter-simulator/src/index.ts'),
      '@woohoo/edge-gateway': p('services/edge-gateway/src/index.ts'),
      '@woohoo/device-gateway': p('services/device-gateway/src/index.ts'),
    },
  },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'docs/**'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
