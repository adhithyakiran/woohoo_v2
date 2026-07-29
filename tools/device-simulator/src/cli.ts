#!/usr/bin/env tsx
import { createInterface } from 'node:readline/promises';
import { renderTrace } from '@woohoo/otel';
import { buildApp, type App } from '@woohoo/core';

/**
 * Headless device simulator — architecture doc §74.
 *
 * Stands in for the Woohoo hub: it skips the audio path (wake word, AEC, Opus, ASR) and injects
 * a transcript straight into the orchestrator, which is exactly where the interesting behaviour
 * starts. Without this, every engineer needs hardware and a hotel.
 *
 *   npm run turn -- "turn on the lights"
 *   npm run turn -- --device d_511a --trace "it's freezing and fix the shower"
 *   npm run turn                      # interactive REPL, keeps session state between turns
 */

interface Args {
  device: string;
  confidence: number;
  trace: boolean;
  degradation?: number;
  at?: string;
  utterances: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { device: 'd_412a', confidence: 0.95, trace: false, utterances: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--device' || a === '-d') out.device = argv[++i] ?? out.device;
    else if (a === '--confidence' || a === '-c') out.confidence = Number(argv[++i]);
    else if (a === '--trace' || a === '-t') out.trace = true;
    else if (a === '--degradation') out.degradation = Number(argv[++i]);
    else if (a === '--at') out.at = argv[++i];
    else out.utterances.push(a);
  }
  return out;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const verdictColour = (k: string) =>
  k === 'ALLOW' ? C.green(k) : k === 'DENY' ? C.red(k) : k === 'ESCALATE' ? C.red(k) : C.yellow(k);

async function runTurn(app: App, args: Args, utterance: string): Promise<void> {
  const t0 = Date.now();
  const res = await app.orchestrator.handleTurn({
    deviceId: args.device,
    transcript: utterance,
    asrConfidence: args.confidence,
    now: args.at ? new Date(args.at) : undefined,
    forceDegradation: args.degradation,
  });

  console.log(`${C.dim('guest    >')} ${utterance}`);
  console.log(
    `${C.dim('lane     >')} ${C.cyan(res.lane)}${
      res.degradationLevel ? C.dim(` (degradation L${res.degradationLevel})`) : ''
    }`,
  );

  for (const c of res.calls) {
    const status = c.result?.ok ? C.green('ok') : C.red(c.result?.error?.error ?? 'failed');
    const detail = c.result?.ok ? '' : C.dim(` — ${c.result?.error?.detail ?? c.verdict.reason}`);
    console.log(
      `${C.dim('tool     >')} ${c.tool} ${C.dim('[' + c.verdict.tier + ']')} ` +
        `${verdictColour(c.verdict.kind)} ${C.dim(c.verdict.ruleId)} ${status}${detail}`,
    );
  }

  if (res.awaitingConfirmation) {
    console.log(`${C.dim('state    >')} ${C.yellow('awaiting spoken confirmation')}`);
  }
  if (res.escalated) console.log(`${C.dim('state    >')} ${C.red('ESCALATED to staff')}`);

  console.log(`${C.bold('genie    >')} ${res.speech}`);
  if (res.screen) console.log(`${C.dim('screen   >')} ${res.screen.replace(/\n/g, ' | ')}`);
  console.log(
    C.dim(
      `         ${Date.now() - t0}ms · turn ${res.turnId} · cost $${res.costUsd.toFixed(6)} · ` +
        `provider ${app.llm.name}`,
    ),
  );

  if (args.trace) {
    console.log(C.dim('\n--- trace ---'));
    console.log(C.dim(renderTrace(res.tracer)));
  }
  console.log();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = await buildApp();

  console.log(
    C.dim(
      `woohoo device simulator · device=${args.device} · llm=${app.llm.name}` +
        `${app.llm.name === 'mock' ? ' (set GOOGLE_API_KEY to use Gemini)' : ''}\n`,
    ),
  );

  if (args.utterances.length) {
    for (const u of args.utterances) await runTurn(app, args, u);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(C.dim('Interactive mode. Session state persists between turns. Ctrl-C to exit.\n'));
  for (;;) {
    const line = (await rl.question('> ')).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    try {
      await runTurn(app, args, line);
    } catch (err) {
      console.error(C.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
