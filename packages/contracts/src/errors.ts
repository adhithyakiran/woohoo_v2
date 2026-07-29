/**
 * The standard tool-error envelope — architecture doc §32.1, "errors must be instructions".
 *
 * A bare vendor code ("INNCOM: ERR_0x8004") produces either a hallucinated explanation or a
 * dead-end apology. Every error the model sees is normalised into this small vocabulary plus
 * a suggestion it can act on.
 */
export const ToolErrorCode = {
  /** The room does not have this capability, or the item is off the menu. */
  NotAvailable: 'NOT_AVAILABLE',
  /** Policy refused it. The model must not retry or rephrase to get around this. */
  NotPermitted: 'NOT_PERMITTED',
  /** The head-end or upstream is unreachable right now. Offer the staff path. */
  TemporarilyUnreachable: 'TEMPORARILY_UNREACHABLE',
  /** T3 action needs a separate confirmed turn (§44.1). */
  NeedsConfirmation: 'NEEDS_CONFIRMATION',
  /** Schema or bounds violation. The detail says what a valid value looks like. */
  InvalidArgument: 'INVALID_ARGUMENT',
  /** Per-device, per-stay or per-property limit hit. */
  RateLimited: 'RATE_LIMITED',
  /** A request of this kind is already open — do not create a duplicate. */
  Duplicate: 'DUPLICATE',
} as const;
export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export interface ToolError {
  error: ToolErrorCode;
  /** Plain statement of what went wrong, safe to paraphrase to a guest. */
  detail: string;
  /** What the agent should do next. This is the field that makes self-correction work. */
  suggestion: string;
  retryable: boolean;
}

export function toolError(
  code: ToolErrorCode,
  detail: string,
  suggestion: string,
  retryable = false,
): ToolError {
  return { error: code, detail, suggestion, retryable };
}

export function isToolError(v: unknown): v is ToolError {
  return typeof v === 'object' && v !== null && 'error' in v && 'suggestion' in v;
}

/** Thrown inside the platform; never surfaced to the model directly. */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code: ToolErrorCode = ToolErrorCode.TemporarilyUnreachable,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}
