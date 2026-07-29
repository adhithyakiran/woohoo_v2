export * from './tiers.js';
export * from './turn-context.js';
export * from './capabilities.js';
export * from './tools.js';
export * from './errors.js';
export * from './events.js';
export * from './config.js';
export * from './adapter.js';

/** A tool call as PROPOSED by the model — never trusted, never executed as-is. */
export interface ToolProposal {
  tool: string;
  args: Record<string, unknown>;
}

/** A tool call after the gateway has stripped model scope and injected the real one. */
export interface ScopedToolCall {
  tool: string;
  args: Record<string, unknown>;
  scope: import('./turn-context.js').Scope;
  turnId: string;
  idempotencyKey: string;
  actor: 'guest' | 'staff' | 'system';
}

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: import('./errors.js').ToolError;
  /** Result came from staff-authored or vendor content ⇒ fence before it enters context. */
  untrusted?: boolean;
  latencyMs: number;
}
