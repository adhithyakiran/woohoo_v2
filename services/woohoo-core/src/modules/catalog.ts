import {
  applyOverrides,
  PropertyConfigSchema,
  type CapabilityManifest,
  type PropertyConfig,
  type Scope,
  type VendorRoomRef,
} from '@woohoo/contracts';

/**
 * Property catalogue — architecture doc §35, §36.
 *
 * Source of truth for tenants, properties, room types, rooms, devices and capability
 * manifests. Read on nearly every turn and written rarely, so it is aggressively cacheable.
 *
 * Two modelling decisions from §35 are load-bearing here:
 *  - The voice device is a separate entity from the room, bound revocably. Collapsing them is
 *    the V1 shortcut that makes a relocated device an invisible bug (§22).
 *  - The capability manifest attaches to ROOM TYPE, not room, with per-room overrides. Eight
 *    manifests per property is a day's work; three hundred is a project.
 */

export interface RoomRecord {
  roomId: string;
  propertyId: string;
  /** The number a guest would say. Never used to address the vendor system. */
  roomNumber: string;
  roomTypeId: string;
  /** The vendor's own identifier, resolved at onboarding and verified (§39.2). */
  vendorRoomId: string;
}

export interface DeviceRecord {
  deviceId: string;
  tenantId: string;
  propertyId: string;
  /** Current room binding. Timestamped so drift can be detected rather than assumed. */
  roomId: string;
  boundAt: number;
  /** Last time the binding was confirmed against the automation system (§22). */
  bindingVerifiedAt?: number;
  certificateSerial: string;
  revoked: boolean;
}

/** What the device gateway resolves a certificate into, before any turn begins. */
export interface ResolvedDevice {
  scope: Scope;
  room: RoomRecord;
  property: PropertyConfig;
  manifest: CapabilityManifest;
  vendorRoom: VendorRoomRef;
}

export class DeviceRevokedError extends Error {}
export class DeviceUnknownError extends Error {}
export class BindingMismatchError extends Error {}

export interface CatalogRepository {
  getProperty(propertyId: string): Promise<PropertyConfig | undefined>;
  getRoom(roomId: string): Promise<RoomRecord | undefined>;
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  listRooms(propertyId: string): Promise<RoomRecord[]>;
  upsertProperty(cfg: PropertyConfig): Promise<void>;
  upsertRoom(room: RoomRecord): Promise<void>;
  upsertDevice(device: DeviceRecord): Promise<void>;
}

/**
 * In-memory implementation. The Postgres implementation behind the same interface is a drop-in;
 * keeping the boundary here is what lets the whole stack run and be tested without Docker.
 */
export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly properties = new Map<string, PropertyConfig>();
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly devices = new Map<string, DeviceRecord>();

  async getProperty(id: string) {
    return this.properties.get(id);
  }
  async getRoom(id: string) {
    return this.rooms.get(id);
  }
  async getDevice(id: string) {
    return this.devices.get(id);
  }
  async listRooms(propertyId: string) {
    return [...this.rooms.values()].filter((r) => r.propertyId === propertyId);
  }
  async upsertProperty(cfg: PropertyConfig) {
    this.properties.set(cfg.propertyId, PropertyConfigSchema.parse(cfg));
  }
  async upsertRoom(room: RoomRecord) {
    this.rooms.set(room.roomId, room);
  }
  async upsertDevice(device: DeviceRecord) {
    this.devices.set(device.deviceId, device);
  }
}

export class CatalogService {
  /** Resolution is cached because it must not cost a database hit per turn (§7). */
  private readonly cache = new Map<string, { at: number; value: ResolvedDevice }>();
  private readonly ttlMs: number;

  constructor(
    private readonly repo: CatalogRepository,
    opts: { cacheTtlMs?: number } = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? 60_000;
  }

  /**
   * device_id → {tenant, property, room, manifest}. This is where principle P2 begins: the
   * scope every downstream component uses is derived here from the authenticated device
   * identity, and never from anything the model or the guest said.
   */
  async resolveDevice(deviceId: string, now = Date.now()): Promise<ResolvedDevice> {
    const hit = this.cache.get(deviceId);
    if (hit && now - hit.at < this.ttlMs) return hit.value;

    const device = await this.repo.getDevice(deviceId);
    if (!device) throw new DeviceUnknownError(`Unknown device ${deviceId}`);
    if (device.revoked) throw new DeviceRevokedError(`Device ${deviceId} is revoked`);

    const room = await this.repo.getRoom(device.roomId);
    if (!room) throw new BindingMismatchError(`Device ${deviceId} is bound to a room that no longer exists`);

    const property = await this.repo.getProperty(device.propertyId);
    if (!property) throw new DeviceUnknownError(`Unknown property ${device.propertyId}`);
    if (room.propertyId !== property.propertyId) {
      throw new BindingMismatchError(`Device ${deviceId} room/property binding disagrees`);
    }

    const manifest = this.manifestFor(property, room);
    const resolved: ResolvedDevice = {
      scope: {
        tenantId: device.tenantId,
        propertyId: device.propertyId,
        roomId: device.roomId,
        deviceId: device.deviceId,
      },
      room,
      property,
      manifest,
      vendorRoom: { vendorRoomId: room.vendorRoomId, propertyId: property.propertyId },
    };
    this.cache.set(deviceId, { at: now, value: resolved });
    return resolved;
  }

  /** Room type manifest with per-room overrides applied. Overrides may only remove (§33). */
  manifestFor(property: PropertyConfig, room: RoomRecord): CapabilityManifest {
    const type = property.roomTypes.find((t) => t.id === room.roomTypeId);
    if (!type) {
      throw new BindingMismatchError(
        `Room ${room.roomId} references unknown room type ${room.roomTypeId}`,
      );
    }
    const override = property.roomOverrides.find((o) => o.roomRef === room.roomId);
    return override ? applyOverrides(type.capabilityManifest, override.disable) : type.capabilityManifest;
  }

  invalidate(deviceId?: string): void {
    if (deviceId) this.cache.delete(deviceId);
    else this.cache.clear();
  }

  /**
   * Room-binding verification (§22). A device moved during a refurbishment will otherwise
   * control the wrong room while the audit log records it as correct — a bug that surfaces
   * nowhere unless you build detection for it.
   */
  async verifyBinding(
    deviceId: string,
    observedVendorRoomId: string,
    now = Date.now(),
  ): Promise<{ ok: boolean; expected: string; observed: string }> {
    const resolved = await this.resolveDevice(deviceId, now);
    const expected = resolved.vendorRoom.vendorRoomId;
    const ok = expected === observedVendorRoomId;
    if (ok) {
      const device = await this.repo.getDevice(deviceId);
      if (device) await this.repo.upsertDevice({ ...device, bindingVerifiedAt: now });
    }
    return { ok, expected, observed: observedVendorRoomId };
  }

  getRepository(): CatalogRepository {
    return this.repo;
  }
}
