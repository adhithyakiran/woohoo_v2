import {
  isToolError,
  ToolErrorCode,
  toolError,
  type Money,
  type ScopedToolCall,
  type ToolProposal,
  type TurnContext,
} from '@woohoo/contracts';
import { PolicyDecisionPoint, type PolicyInputs } from '@woohoo/policy';
import { SimulatorAdapter } from '@woohoo/adapter-simulator';
import { HttpCatalogRepository } from './modules/catalog-http.js';
import { HoneywellHttpAdapter } from '@woohoo/adapter-honeywell';
import { MasterDbAdapter } from '@woohoo/adapter-masterdb';
import type { AutomationAdapter } from '@woohoo/contracts';
import { AgentRuntime } from './agent/runtime.js';
import { GeminiProvider, type LlmProvider } from './agent/llm.js';
import { MockLlmProvider } from './agent/mock-provider.js';
import { InProcessEventBus } from './infra/event-bus.js';
import { InMemoryAuditSink } from './modules/audit.js';
import {
  CatalogService,
  InMemoryCatalogRepository,
  type CatalogRepository,
} from './modules/catalog.js';
import { DeviceStateService, type ApplyOutcome } from './modules/device-state.js';
import { FnbService, InMemoryFnbRepository } from './modules/fnb.js';
import { GuestService, InMemoryGuestRepository } from './modules/guest.js';
import { InMemoryKnowledgeRepository, KnowledgeService } from './modules/knowledge.js';
import { McpGateway, type ToolHandler } from './modules/mcp-gateway.js';
import { NotificationService } from './modules/notification.js';
import { Orchestrator } from './modules/orchestrator.js';
import {
  InMemoryServiceRequestRepository,
  ServiceRequestService,
} from './modules/service-request.js';
import { SessionStore } from './modules/session.js';
import { seedDemoProperty } from './seed.js';

/**
 * Composition root — architecture doc §10 (D13).
 *
 * Phase 1 is a modular monolith: every module talks through an explicit, typed interface
 * shaped like a network call, so promoting any of them to a service later is a transport
 * change rather than a redesign.
 */

export interface App {
  orchestrator: Orchestrator;
  catalog: CatalogService;
  /** Exposed so the control plane can provision rooms. Never touched on a turn. */
  catalogRepo: CatalogRepository;
  deviceState: DeviceStateService;
  serviceRequests: ServiceRequestService;
  fnb: FnbService;
  guest: GuestService;
  knowledge: KnowledgeService;
  notifications: NotificationService;
  gateway: McpGateway;
  pdp: PolicyDecisionPoint;
  bus: InProcessEventBus;
  audit: InMemoryAuditSink;
  sessions: SessionStore;
  adapter: AutomationAdapter;
  llm: LlmProvider;
}

export interface BuildOptions {
  llm?: LlmProvider;
  catalogRepo?: CatalogRepository;
  adapter?: AutomationAdapter;
  seed?: boolean;
}

/**
 * Pick the automation adapter from configuration.
 *
 * Defaulting to the simulator keeps the platform runnable with no head-end present; a hotel
 * deployment sets WOOHOO_ADAPTER=honeywell and HONEYWELL_URL.
 */
function createAdapter(): AutomationAdapter {
  const kind = (process.env.WOOHOO_ADAPTER ?? '').trim().toLowerCase();
  if (kind === 'honeywell') return new HoneywellHttpAdapter();
  // Drives a property imported from V1: the command catalogue is the protocol.
  if (kind === 'masterdb') return new MasterDbAdapter();
  return new SimulatorAdapter({ latencyMs: 60, seed: 42 });
}

/**
 * Seed the catalogue from V1. `WOOHOO_SEED_PROPERTY` takes one id, a comma-separated list,
 * or `all` for every property that has automation.
 *
 * Warnings are printed rather than swallowed: a room whose commands point at a health check
 * will accept instructions and change nothing, and that is worth knowing at boot rather than
 * from a guest. With many properties the per-room detail would bury the startup log, so it
 * is summarised and the full text stays available from `npm run capability -- import`.
 */
async function seedImportedProperty(catalogRepo: CatalogRepository, spec: string) {
  const { importProperty, propertiesWithAutomation } = await import('@woohoo/adapter-masterdb');

  const ids =
    spec.trim().toLowerCase() === 'all'
      ? await propertiesWithAutomation()
      : spec
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isFinite(n));

  let rooms = 0;
  let devices = 0;
  let warnings = 0;
  const verbose = ids.length === 1;

  for (const id of ids) {
    let imported;
    try {
      imported = await importProperty(id);
    } catch (err) {
      // One unimportable property must not stop the rest of the estate from loading.
      console.warn(`  skipped property ${id}: ${(err as Error).message}`);
      continue;
    }

    await catalogRepo.upsertProperty(imported.property);
    for (const room of imported.rooms) await catalogRepo.upsertRoom(room);
    for (const device of imported.devices) await catalogRepo.upsertDevice(device);

    rooms += imported.rooms.length;
    devices += imported.devices.length;
    warnings += imported.warnings.length;

    if (verbose) {
      console.log(
        `seeded ${imported.property.name} (${imported.property.propertyId}) - ` +
          `${imported.rooms.length} rooms, ${imported.devices.length} devices, ` +
          `${imported.property.roomTypes.length} room types`,
      );
      for (const w of imported.warnings) console.warn(`  warning: ${w}`);
    }
  }

  if (!verbose) {
    console.log(
      `seeded ${ids.length} properties - ${rooms} rooms, ${devices} devices, ` +
        `${warnings} onboarding warnings (npm run capability -- import --property <id> for detail)`,
    );
  }
}

export async function buildApp(opts: BuildOptions = {}): Promise<App> {
  const bus = new InProcessEventBus();
  const audit = new InMemoryAuditSink();
  const sessions = new SessionStore();

  // WOOHOO_CATALOG_URL hands ownership of rooms and devices to another service; without it
  // the in-memory catalog keeps the stack runnable with no external dependency.
  const catalogRepo =
    opts.catalogRepo ??
    (process.env.WOOHOO_CATALOG_URL?.trim()
      ? new HttpCatalogRepository()
      : new InMemoryCatalogRepository());
  const catalog = new CatalogService(catalogRepo);

  // WOOHOO_ADAPTER=honeywell points the platform at a real head-end over HTTP. The in-process
  // simulator stays the default so tests and a bare `npm run gateway` need no extra service.
  const adapter = opts.adapter ?? createAdapter();
  await adapter.connect({ propertyId: 'p_blr_whitefield', vendor: adapter.vendor });
  const deviceState = new DeviceStateService(adapter);

  const serviceRequests = new ServiceRequestService(new InMemoryServiceRequestRepository(), bus);
  const fnbRepo = new InMemoryFnbRepository();
  const fnb = new FnbService(fnbRepo, bus);
  const guestRepo = new InMemoryGuestRepository();
  const guest = new GuestService(guestRepo);
  const knowledgeRepo = new InMemoryKnowledgeRepository();
  const knowledge = new KnowledgeService(knowledgeRepo);
  const notifications = new NotificationService(bus);
  const pdp = new PolicyDecisionPoint();

  if (opts.seed !== false) {
    // WOOHOO_SEED_PROPERTY=167 (or 167,153 or all) boots against real V1 properties instead
    // of the fixture: their rooms, their devices, and manifests derived from the commands
    // each room actually has.
    const imported = process.env.WOOHOO_SEED_PROPERTY?.trim();
    if (imported) {
      await seedImportedProperty(catalogRepo, imported);
    } else {
      await seedDemoProperty({ catalogRepo, fnbRepo, guestRepo, knowledgeRepo });
    }
  }

  // The LLM is configuration: the real provider activates when a key is present, otherwise the
  // deterministic mock keeps the whole stack runnable and testable (§25, D8).
  const llm =
    opts.llm ?? (GeminiProvider.isConfigured() ? new GeminiProvider() : new MockLlmProvider());

  const handlers = buildHandlers({
    catalog,
    deviceState,
    serviceRequests,
    fnb,
    guest,
    knowledge,
    notifications,
  });
  const gateway = new McpGateway({ handlers });

  const agent = new AgentRuntime({
    llm,
    gateway,
    pdp,
    priceProposal: async (p, ctx) => priceProposal(fnb, p, ctx),
    policyInputs: async (ctx) => buildPolicyInputs(ctx, { catalog, serviceRequests, fnb, sessions }),
  });

  const orchestrator = new Orchestrator({
    catalog,
    deviceState,
    serviceRequests,
    fnb,
    guest,
    notifications,
    gateway,
    pdp,
    agent,
    bus,
    audit,
    sessions,
  });

  return {
    orchestrator, catalog, catalogRepo, deviceState, serviceRequests, fnb, guest, knowledge,
    notifications, gateway, pdp, bus, audit, sessions, adapter, llm,
  };
}

/** Only the platform prices an order — never the model (§ fnb.price, §44 R10). */
async function priceProposal(
  fnb: FnbService,
  p: ToolProposal,
  ctx: TurnContext,
): Promise<Money | undefined> {
  if (p.tool !== 'fnb.place_order') return undefined;
  const items = p.args.items as Array<{ menuItemId: string; quantity: number }> | undefined;
  if (!Array.isArray(items)) return undefined;
  const priced = await fnb.price(ctx.scope, items);
  return isToolError(priced) ? undefined : priced.total;
}

async function buildPolicyInputs(
  ctx: TurnContext,
  deps: {
    catalog: CatalogService;
    serviceRequests: ServiceRequestService;
    fnb: FnbService;
    sessions: SessionStore;
  },
): Promise<PolicyInputs> {
  const resolved = await deps.catalog.resolveDevice(ctx.scope.deviceId);
  const session = deps.sessions.get(ctx.scope.roomId);
  const [openRequests, stableSpend] = await Promise.all([
    deps.serviceRequests.listOpen(ctx.scope),
    deps.fnb.spendThisStay(ctx.scope),
  ]);

  return {
    ctx,
    manifest: resolved.manifest,
    policy: resolved.property.policy,
    openRequests: openRequests.map((r) => ({ id: r.id, category: r.category, createdAt: r.createdAt })),
    stableSpend,
    recentActuations: session.recentActuations,
    turnsThisHour: deps.sessions.turnsThisHour(ctx.scope.roomId),
  };
}

interface HandlerDeps {
  catalog: CatalogService;
  deviceState: DeviceStateService;
  serviceRequests: ServiceRequestService;
  fnb: FnbService;
  guest: GuestService;
  knowledge: KnowledgeService;
  notifications: NotificationService;
}

/**
 * Tool handlers. Note what they receive: a ScopedToolCall whose scope came from the device
 * certificate. None of them accepts a room identifier from the caller (P2).
 */
function buildHandlers(d: HandlerDeps): Map<string, ToolHandler> {
  const h = new Map<string, ToolHandler>();

  const resolve = async (ctx: TurnContext) => d.catalog.resolveDevice(ctx.scope.deviceId);
  const annotationsOf = (call: ScopedToolCall) =>
    (call.args.__annotations as Record<string, unknown> | undefined) ?? undefined;

  h.set('room.get_state', async (_call, ctx) => {
    const r = await resolve(ctx);
    return d.deviceState.readState(r.vendorRoom, {
      minC: r.property.policy.climate.minC,
      maxC: r.property.policy.climate.maxC,
      supportsCurtainPosition: r.manifest.capabilities.some((c) => c.capability === 'curtains.position'),
    });
  });

  /**
   * An ApplyOutcome carries its ToolError nested, and `isToolError` tests for a flat one -
   * so returning the outcome as-is makes the gateway record ok:true for a command the room
   * rejected, and the guest is told "Done." about a light that never moved. Unwrap it here,
   * at the one boundary where a handler hands its result to the gateway.
   */
  const settle = (outcome: ApplyOutcome) =>
    outcome.status === 'failed' && outcome.error ? outcome.error : outcome;

  const applyCapability = (capability: string, extract: (args: Record<string, unknown>) => unknown) =>
    (async (call: ScopedToolCall, ctx: TurnContext) => {
      const r = await resolve(ctx);
      return settle(
        await d.deviceState.apply(
        r.vendorRoom,
        {
          capability,
          zone: call.args.zone as never,
          value: extract(call.args) as never,
        },
        call.idempotencyKey,
        ),
      );
    }) as ToolHandler;

  h.set('lighting.set', async (call, ctx) => {
    const r = await resolve(ctx);
    const hasBrightness = call.args.brightness !== undefined;
    return settle(
      await d.deviceState.apply(
        r.vendorRoom,
        {
          capability: hasBrightness ? 'lighting.brightness' : 'lighting.on_off',
          zone: call.args.zone as never,
          value: (hasBrightness ? call.args.brightness : call.args.on) as never,
        },
        call.idempotencyKey,
      ),
    );
  });

  h.set('climate.set_temperature', applyCapability('climate.setpoint', (a) => a.targetC));
  h.set('climate.set_mode', applyCapability('climate.mode', (a) => a.mode));
  h.set('curtains.set', applyCapability('curtains.position', (a) => a.position));
  h.set('dnd.set', applyCapability('dnd', (a) => a.state));
  h.set('tv.control', applyCapability('tv.power_volume_input', (a) => a.power ?? 'on'));
  h.set('scene.apply', applyCapability('lighting.scene', (a) => a.scene));
  h.set('media.control', applyCapability('media.playback', (a) => a.action));

  h.set('service.create_request', async (call, ctx) => {
    const r = await resolve(ctx);
    return d.serviceRequests.create(
      ctx.scope,
      call.args as never,
      r.property.policy,
      annotationsOf(call),
      ctx.traceId,
    );
  });
  h.set('service.get_status', async (_call, ctx) => d.serviceRequests.listOpen(ctx.scope));
  h.set('service.cancel_request', async (call, ctx) =>
    d.serviceRequests.cancel(ctx.scope, String(call.args.requestId), ctx.traceId),
  );

  h.set('fnb.get_menu', async (call, ctx) =>
    d.fnb.getMenu(ctx.scope, call.args.category as string | undefined),
  );
  h.set('fnb.get_order_status', async (_call, ctx) => d.fnb.getOrders(ctx.scope));
  h.set('fnb.place_order', async (call, ctx) => {
    const items = call.args.items as Array<{ menuItemId: string; quantity: number; notes?: string }>;
    const priced = await d.fnb.price(ctx.scope, items);
    if (isToolError(priced)) return priced;
    return d.fnb.placeOrder(ctx.scope, priced, ctx.traceId);
  });

  h.set('stay.get_info', async (_call, ctx) => {
    const view = await d.guest.stayView(ctx.scope, ctx.consent);
    return (
      view ??
      toolError(
        ToolErrorCode.NotAvailable,
        'No stay is currently registered for this room.',
        'Tell the guest you cannot see their booking and offer the front desk.',
      )
    );
  });
  h.set('stay.request_late_checkout', async (call, ctx) =>
    d.serviceRequests.create(
      ctx.scope,
      {
        category: 'housekeeping',
        subcategory: 'late_checkout',
        description: `Late checkout requested until ${String(call.args.requestedTime)}`,
        priority: 'normal',
      },
      (await resolve(ctx)).property.policy,
      annotationsOf(call),
      ctx.traceId,
    ),
  );
  h.set('stay.set_wakeup_call', async (call, ctx) =>
    d.serviceRequests.create(
      ctx.scope,
      {
        category: 'housekeeping',
        subcategory: 'wakeup_call',
        description:
          call.args.action === 'cancel'
            ? 'Cancel wake-up call'
            : `Wake-up call at ${String(call.args.time)}`,
        priority: 'normal',
      },
      (await resolve(ctx)).property.policy,
      annotationsOf(call),
      ctx.traceId,
    ),
  );

  h.set('property.search_knowledge', async (call, ctx) =>
    d.knowledge.search(ctx.scope, String(call.args.query)),
  );

  h.set('staff.connect', async (call, ctx) => {
    const r = await resolve(ctx);
    return {
      connecting: true,
      department: call.args.department ?? 'front_desk',
      target: r.property.escalation.frontDesk.target,
    };
  });

  h.set('staff.escalate_urgent', async (call, ctx) => {
    const r = await resolve(ctx);
    const e = await d.notifications.escalate(
      ctx.scope,
      r.property,
      call.args.category as never,
      String(call.args.summary),
      ctx.traceId,
    );
    return { escalationId: e.id, category: e.category, severity: e.severity, notified: e.notified };
  });

  h.set('preferences.set', async (call, ctx) => {
    await d.guest.setPreference(ctx.scope, call.args.key as never, String(call.args.value));
    return { saved: true, key: call.args.key };
  });

  return h;
}
