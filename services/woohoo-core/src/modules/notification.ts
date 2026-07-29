import {
  EventType,
  makeEvent,
  type EscalationRaisedData,
  type EventBus,
  type PropertyConfig,
  type Scope,
} from '@woohoo/contracts';

/**
 * Staff notification and escalation — architecture doc §48.
 *
 * The T4 path. The agent's job is to gather context and hand off fast, not to resolve. An
 * escalation nobody acknowledges is the worst failure in the system, so acknowledgement is
 * tracked here rather than assumed (§67).
 */

export type EscalationCategory = 'medical' | 'fire' | 'security' | 'welfare' | 'other';

export interface Escalation {
  id: string;
  tenantId: string;
  propertyId: string;
  roomId: string;
  category: EscalationCategory;
  severity: 'critical' | 'high' | 'normal';
  summary: string;
  raisedAt: number;
  notified: string[];
  acknowledgedAt?: number;
  requiresAckWithinS: number;
}

const SEVERITY: Record<EscalationCategory, Escalation['severity']> = {
  medical: 'critical',
  fire: 'critical',
  security: 'critical',
  welfare: 'high',
  other: 'normal',
};

/**
 * What the assistant says aloud, per §48. Every line states the device's limits plainly —
 * the device must never imply it has summoned help it cannot summon.
 */
export function escalationSpeech(
  category: EscalationCategory,
  property: PropertyConfig,
): { speech: string; screen: string } {
  const emergency = property.escalation.emergencyNumberDisplay;
  const helpline = property.escalation.crisisHelplineDisplay;

  switch (category) {
    case 'medical':
      return {
        speech:
          `I'm alerting the hotel team right now. If this is an emergency please call ${emergency} — ` +
          `I'm not able to call them for you. I'll stay here with you.`,
        screen: `Emergency: ${emergency}\nHotel team alerted`,
      };
    case 'fire':
      return {
        speech:
          `I've alerted the hotel team. If you see fire or smoke, please leave using the nearest ` +
          `marked exit and do not use the lift. Call ${emergency} once you are safe.`,
        screen: `Emergency: ${emergency}\nUse nearest marked exit — do not use the lift`,
      };
    case 'security':
      return {
        // Quiet by default: a loud confirmation can escalate a dangerous situation if the
        // guest may not be alone.
        speech: `I've let the hotel's security team know and someone will be with you shortly.`,
        screen: `Security notified\nEmergency: ${emergency}`,
      };
    case 'welfare':
      return {
        speech: helpline
          ? `I'm sorry you're going through this. I've asked the duty manager to check in with you. ` +
            `If you'd like to talk to someone right now, you can call ${helpline}.`
          : `I'm sorry you're going through this. I've asked the duty manager to check in with you.`,
        screen: helpline ? `Support line: ${helpline}\nDuty manager notified` : `Duty manager notified`,
      };
    default:
      return {
        speech: `I've passed this to the hotel team and someone will follow up with you.`,
        screen: `Hotel team notified`,
      };
  }
}

export class NotificationService {
  private readonly escalations = new Map<string, Escalation>();
  private seq = 0;

  constructor(private readonly bus: EventBus) {}

  async escalate(
    scope: Scope,
    property: PropertyConfig,
    category: EscalationCategory,
    summary: string,
    traceId: string,
    trigger = 'agent_raised',
    now = Date.now(),
  ): Promise<Escalation> {
    const severity = SEVERITY[category];
    const notified =
      severity === 'critical'
        ? [property.escalation.frontDesk.target, property.escalation.dutyManager.target]
        : [property.escalation.dutyManager.target];

    const e: Escalation = {
      id: `esc_${now.toString(36)}${(this.seq++).toString(36)}`,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      roomId: scope.roomId,
      category,
      severity,
      summary,
      raisedAt: now,
      notified,
      requiresAckWithinS: severity === 'critical' ? 120 : 600,
    };
    this.escalations.set(e.id, e);

    const data: EscalationRaisedData = {
      escalationId: e.id,
      roomRef: scope.roomId,
      category,
      severity,
      trigger,
      contextSummary: summary,
      notified,
      requiresAckWithinS: e.requiresAckWithinS,
    };
    await this.bus.publish(
      makeEvent(
        EventType.EscalationRaised,
        {
          source: '/woohoo-core/notification',
          subject: e.id,
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          traceId,
        },
        data,
      ),
    );
    return e;
  }

  acknowledge(id: string, now = Date.now()): boolean {
    const e = this.escalations.get(id);
    if (!e) return false;
    e.acknowledgedAt = now;
    return true;
  }

  /** Escalations past their acknowledgement window — the thing to alarm on (§67). */
  unacknowledged(now = Date.now()): Escalation[] {
    return [...this.escalations.values()].filter(
      (e) => !e.acknowledgedAt && now - e.raisedAt > e.requiresAckWithinS * 1000,
    );
  }

  list(): Escalation[] {
    return [...this.escalations.values()];
  }
}
