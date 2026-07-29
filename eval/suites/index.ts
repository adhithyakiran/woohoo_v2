import type { EvalCase, SuiteName } from '../runner/types.js';
import { goldenCases } from './golden.js';
import { adversarialCases } from './adversarial.js';
import { safetyCases } from './safety.js';
import { capabilityCases } from './capability.js';

export const SUITES: Record<SuiteName, EvalCase[]> = {
  golden: goldenCases,
  adversarial: adversarialCases,
  safety: safetyCases,
  capability: capabilityCases,
};

export const ALL_CASES: EvalCase[] = Object.values(SUITES).flat();

export { goldenCases, adversarialCases, safetyCases, capabilityCases };
