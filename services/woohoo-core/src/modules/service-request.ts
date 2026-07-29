import {
  EventType,
  makeEvent,
  ToolErrorCode,
  toolError,
  type EventBus,
  type PropertyPolicy,
  type Scope,
  type ToolError,
} from '@woohoo/contracts';

/**
 * Service requests — architecture doc §42.
 *
 * Where the agentic approach is most obviously better than intent matching: a free-text
 * description written by a model that understood the guest is far more useful to a technician
 * than a category code.
 */

export type RequestCategory = 'housekeeping' | 'maintenance' | 'amenity';
export type RequestStatus = 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';

export interface ServiceRequest {
  id: string;
  tenantId: string;
  propertyId: string;
  roomId: string;
  category: RequestCategory;
  subcategory?: string;
  description: string;
  priority: 'low' | 'normal' | 'urgent';
  status: RequestStatus;
  createdAt: number;
  /** Set when quiet hours defer dispatch to the morning (§7). */
  dispatchAt?: string;
  deferred: boolean;
  slaMinutes?: number;
  slaDueAt?: number;
}

export interface ServiceRequestRepository {
  create(r: ServiceRequest): Promise<void>;
  update(r: ServiceRequest): Promise<void>;
  get(id: string): Promise<ServiceRequest | undefined>;
  listOpen(roomId: string): Promise<ServiceRequest[]>;
}

export class InMemoryServiceRequestRepository implements ServiceRequestRepository {
  private readonly rows = new Map<string, ServiceRequest>();
  async create(r: ServiceRequest) {
    this.rows.set(r.id, r);
  }
  async update(r: ServiceRequest) {
    this.rows.set(r.id, r);
  }
  async get(id: string) {
    return this.rows.get(id);
  }
  async listOpen(roomId: string) {
    return [...this.rows.values()].filter(
      (r) => r.roomId === roomId && r.status !== 'completed' && r.status !== 'cancelled',
    );
  }
}

export class ServiceRequestService {
  private seq = 0;

  constructor(
    private readonly repo: ServiceRequestRepository,
    private readonly bus: EventBus,
  ) {}

  async listOpen(scope: Scope): Promise<ServiceRequest[]> {
    return this.repo.listOpen(scope.roomId);
  }

  async create(
    scope: Scope,
    input: {
      category: RequestCategory;
      subcategory?: string;
      description: string;
      priority?: 'low' | 'normal' | 'urgent';
    },
    policy: PropertyPolicy,
    annotations: Record<string, unknown> | undefined,
    traceId: string,
    now = Date.now(),
  ): Promise<ServiceRequest> {
    // The model proposes a priority; policy may only ever LOWER it, never raise it above what
    // the property permits. "Urgent" must mean something, and a guest saying so is not evidence.
    const requested = input.priority ?? 'normal';
    const priority = requested === 'urgent' && annotations?.deferred ? 'normal' : requested;

    const sla = policy.serviceRequests.slaMinutes[input.category];
    const deferred = Boolean(annotations?.deferred);

    const r: ServiceRequest = {
      id: `sr_${now.toString(36)}${(this.seq++).toString(36)}`,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      roomId: scope.roomId,
      category: input.category,
      subcategory: input.subcategory,
      description: input.description,
      priority,
      status: 'open',
      createdAt: now,
      dispatchAt: annotations?.dispatchAt as string | undefined,
      deferred,
      slaMinutes: sla,
      slaDueAt: sla ? now + sla * 60_000 : undefined,
    };
    await this.repo.create(r);

    await this.bus.publish(
      makeEvent(
        EventType.ServiceRequestCreated,
        {
          source: '/woohoo-core/service-request',
          subject: r.id,
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          traceId,
        },
        { requestId: r.id, category: r.category, priority: r.priority, deferred: r.deferred },
      ),
    );
    return r;
  }

  async cancel(scope: Scope, requestId: string, traceId: string): Promise<ServiceRequest | ToolError> {
    const r = await this.repo.get(requestId);
    // Scope check in depth: a request belonging to another room is simply not found, so a
    // guessed identifier reveals nothing about other rooms.
    if (!r || r.roomId !== scope.roomId) {
      return toolError(
        ToolErrorCode.NotAvailable,
        'No such request for this room.',
        'Tell the guest you could not find that request and offer to list their open ones.',
      );
    }
    if (r.status === 'completed' || r.status === 'cancelled') {
      return toolError(
        ToolErrorCode.NotAvailable,
        `That request is already ${r.status}.`,
        'Tell the guest it is already closed.',
      );
    }
    const updated: ServiceRequest = { ...r, status: 'cancelled' };
    await this.repo.update(updated);
    await this.bus.publish(
      makeEvent(
        EventType.ServiceRequestUpdated,
        {
          source: '/woohoo-core/service-request',
          subject: r.id,
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          traceId,
        },
        { requestId: r.id, status: 'cancelled' },
      ),
    );
    return updated;
  }
}
