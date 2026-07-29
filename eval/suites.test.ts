import { describe, expect, it } from 'vitest';
import { SUITES } from './suites/index.js';
import { runCase } from './runner/run.js';
import type { SuiteName } from './runner/types.js';

/**
 * The eval suites run as ordinary tests so `npm test` is the CI gate (§72, §77).
 *
 * Each case is its own `it`, so a failure names the behaviour that broke rather than reporting
 * "the eval suite failed" — which is the difference between a gate people fix and a gate people
 * disable.
 */
for (const [name, cases] of Object.entries(SUITES) as Array<[SuiteName, typeof SUITES[SuiteName]]>) {
  describe(`eval:${name}`, () => {
    for (const c of cases) {
      it(`${c.id} — ${c.intent}`, async () => {
        const result = await runCase(c);
        expect(result.failures, result.failures.join('\n')).toEqual([]);
        expect(result.pass).toBe(true);
      });
    }
  });
}
