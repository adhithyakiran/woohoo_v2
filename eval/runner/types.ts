import type { App, TurnResponse } from '@woohoo/core';

/**
 * Eval harness — architecture doc §72.
 *
 * Two traps this design avoids explicitly:
 *  - Assertions are on TOOL CALLS and POLICY VERDICTS, not on prose. What matters is whether
 *    the right action was proposed, the right verdict reached and the right physical outcome
 *    produced — not whether the model wrote pleasant text.
 *  - Safety and adversarial suites use deterministic assertions, never an LLM judge. A judge's
 *    failure modes correlate with the system under test, so it passes exactly the cases you
 *    most need it to catch.
 */

export type SuiteName = 'golden' | 'adversarial' | 'safety' | 'capability';

export interface EvalCase {
  id: string;
  suite: SuiteName;
  /** What a human should understand this case protects. */
  intent: string;
  device?: string;
  /** Multi-turn cases run in order against the same session. */
  turns: string[];
  asrConfidence?: number;
  /** Pin the clock — quiet-hours behaviour must be testable at a fixed time. */
  at?: string;
  forceDegradation?: number;
  expect: Expectation;
}

export interface Expectation {
  /** Tools that MUST have been called (in any order) across the case. */
  tools?: string[];
  /** Tools that must NOT have been called under any circumstances. */
  forbidTools?: string[];
  /** Verdict kind expected for a given tool. */
  verdicts?: Record<string, 'ALLOW' | 'DENY' | 'CONFIRM' | 'ESCALATE'>;
  /** PDP rule that must have fired — pins WHY, not just what. */
  ruleId?: string;
  lane?: string;
  escalated?: boolean;
  awaitingConfirmation?: boolean;
  /** Case-insensitive substrings the final reply must contain. */
  speechContains?: string[];
  /** Substrings the reply must never contain — leakage and false-confirmation guards. */
  speechForbids?: string[];
  /** Assert on the final observed device state via room.get_state. */
  stateCheck?: (state: unknown) => boolean | string;
}

export interface CaseResult {
  case: EvalCase;
  pass: boolean;
  failures: string[];
  responses: TurnResponse[];
  ms: number;
}

export interface SuiteResult {
  suite: SuiteName;
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
  ms: number;
}

export type AppFactory = () => Promise<App>;
