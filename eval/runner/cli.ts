#!/usr/bin/env tsx
import { SUITES } from '../suites/index.js';
import { gateFor, runSuite } from './run.js';
import type { SuiteName } from './types.js';

/**
 * Eval CLI — the CI gate from architecture doc §72 and §77.
 *
 *   npm run eval                 # every suite
 *   npm run eval -- adversarial  # one suite
 *   npm run eval -- --verbose
 */

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

async function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const wanted = argv.filter((a) => !a.startsWith('-')) as SuiteName[];
  const names = (wanted.length ? wanted : (Object.keys(SUITES) as SuiteName[])).filter(
    (n) => n in SUITES,
  );

  console.log(C.bold('\nWoohoo eval harness\n'));
  let allOk = true;
  const summary: string[] = [];

  for (const name of names) {
    const result = await runSuite(name, SUITES[name]);
    const gate = gateFor(result);
    allOk &&= gate.ok;

    const head = gate.ok ? C.green('PASS') : C.red('FAIL');
    console.log(
      `${head} ${C.bold(name.padEnd(12))} ${result.passed}/${result.total} ${C.dim(`${result.ms}ms`)}`,
    );

    for (const r of result.results) {
      if (!r.pass) {
        console.log(`  ${C.red('✗')} ${r.case.id} ${C.dim('— ' + r.case.intent)}`);
        for (const f of r.failures) console.log(`      ${C.yellow(f)}`);
      } else if (verbose) {
        console.log(`  ${C.green('✓')} ${r.case.id} ${C.dim(r.case.intent)}`);
      }
    }
    summary.push(gate.reason);
  }

  console.log('');
  for (const s of summary) console.log(C.dim('  ' + s));
  console.log(allOk ? C.green('\nAll gates passed.\n') : C.red('\nGATE FAILED — this would block the merge.\n'));
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
