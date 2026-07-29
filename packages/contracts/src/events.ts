import type { RiskTier } from './tiers.js';

/**
 * Event backbone — architecture doc §38 and Appendix B.
 *
 * Every event carries tenantId, propertyId, traceId and a schema version. Adding tenantId
 * later is a migration, and without it per-tenant filtering, cost attribution and regional
 * routing all become impossible to bolt on.
 */
export interface EventEnvelope<T = unknown> {
  specversion: '1.0';
  type: EventType;
  source: string;
  id: string;
  time: string;
  subject: string;
  tenantId: string;
  propertyId: string;
  traceId: string;
  schemaVersion: string;
  data: T;
}

export const EventType = {
  TurnCompleted: 'woohoo.turn.completed',
  ServiceRequestCreated: 'woohoo.service_request.created',
  ServiceRequestUpdated: 'woohoo.service_request.updated',
  FnbOrderPlaced: 'woohoo.fnb_order.placed',
  DeviceStateChanged: 'woohoo.device_state.changed',
  DeviceOffline: 'woohoo.device.offline',
  DeviceOnline: 'woohoo.device.online',
  PolicyDenied: 'woohoo.policy.denied',
  EscalationRaised: 'woohoo.escalation.raised',
  StayCheckedOut: 'woohoo.stay.checked_out',
  CapabilityManifestUpdated: 'woohoo.capability_manifest.updated',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export interface TurnCompletedData {
  turnId: string;
  roomRef: string;
  deviceId: string;
  lane: 'fast' | 'agentic' | 'clarify' | 'confirm' | 'degraded';
  language: string;
  degradationLevel: number;
  asr?: { vendor: string; confidence: number; audioMs: number };
  llm?: {
    model: string;
    promptVersion: string;
    tokensIn: number;
    tokensCached: number;
    tokensOut: number;
    costUsd: number;
  };
  toolCalls: Array<{
    tool: string;
    tier: RiskTier;
    verdict: string;
    status: string;
    ms: number;
  }>;
  latency: { endpointToFirstAudioMs: number; totalMs: number };
  outcome: 'success' | 'partial' | 'failed' | 'refused';
  escalated: boolean;
  bargeIn: boolean;
}

export interface PolicyDeniedData {
  turnId: string;
  tool: string;
  tier: RiskTier;
  ruleId: string;
  verdict: string;
  reason: string;
  /** Hash, never the utterance itself — this event feeds security monitoring, not analytics. */
  utteranceHash: string;
}

export interface EscalationRaisedData {
  escalationId: string;
  roomRef: string;
  category: 'medical' | 'fire' | 'security' | 'welfare' | 'other';
  severity: 'critical' | 'high' | 'normal';
  trigger: string;
  contextSummary: string;
  notified: string[];
  requiresAckWithinS: number;
}

export interface StayCheckedOutData {
  stayRef: string;
  roomRef: string;
  checkedOutAt: string;
  /** Drives data deletion, so this event must not be lost (§57). */
  purge: string[];
}

export interface EventBus {
  publish<T>(e: EventEnvelope<T>): Promise<void>;
  subscribe<T>(type: EventType, handler: (e: EventEnvelope<T>) => void | Promise<void>): void;
}

let seq = 0;
export function makeEvent<T>(
  type: EventType,
  opts: { source: string; subject: string; tenantId: string; propertyId: string; traceId: string },
  data: T,
): EventEnvelope<T> {
  return {
    specversion: '1.0',
    type,
    source: opts.source,
    id: `evt_${Date.now().toString(36)}${(seq++).toString(36).padStart(3, '0')}`,
    time: new Date().toISOString(),
    subject: opts.subject,
    tenantId: opts.tenantId,
    propertyId: opts.propertyId,
    traceId: opts.traceId,
    schemaVersion: '1.0',
    data,
  };
}
