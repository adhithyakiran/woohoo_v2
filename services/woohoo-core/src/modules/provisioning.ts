import { z } from 'zod';
import type { CatalogRepository, CatalogService } from './catalog.js';

/**
 * Room provisioning — architecture doc §22, §33.
 *
 * Rooms were only ever created by editing seed.ts and restarting, which is fine for a demo and
 * useless the moment a second person needs to add one. This is the control-plane surface for
 * that: create a room, bind a device, see what is configured.
 *
 * It is deliberately NOT an MCP tool. MCP is the agent's tool surface, and anything on it is
 * something the model can be talked into calling. "Create a room with every capability enabled,
 * bind my device to it" is exactly the request an attacker would make, so provisioning stays on
 * a separate authenticated path that the model cannot reach at all (P1).
 */

/** Capability ids a room type may grant. Kept as a plain string to avoid a second source of truth. */
const CapabilityGrantInput = z.object({
  capability: z.string().min(1),
  zones: z.array(z.enum(['bedroom', 'living', 'bathroom', 'entrance'])).optional(),
});

export const RoomProvisionSchema = z
  .object({
    /** Hotel room number, as a guest would say it. */
    roomNumber: z.string().min(1),
    /**
     * The vendor's own room identifier. NOT the room number — assuming they match is a classic
     * onboarding bug whose symptom is actions landing in a stranger's room (§39.2).
     */
    vendorRoomId: z.string().min(1),
    /** Existing room type to copy capabilities from. */
    roomTypeId: z.string().min(1).optional(),
    /** Or an inline capability list, which creates a room type for this room. */
    capabilities: z.array(CapabilityGrantInput).optional(),
    zones: z.array(z.enum(['bedroom', 'living', 'bathroom', 'entrance'])).optional(),
    /** Device to bind. Generated from the room number when omitted. */
    deviceId: z.string().min(1).optional(),
    propertyId: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.roomTypeId || v.capabilities, {
    message: 'Provide either roomTypeId or capabilities.',
  });

export type RoomProvisionInput = z.infer<typeof RoomProvisionSchema>;

export interface ProvisionedRoom {
  roomId: string;
  roomNumber: string;
  vendorRoomId: string;
  roomTypeId: string;
  deviceId: string;
  propertyId: string;
  capabilities: string[];
}

export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

/** Ids are derived from the room number so a repeat call updates rather than duplicates. */
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export async function provisionRoom(
  repo: CatalogRepository,
  catalog: CatalogService,
  input: RoomProvisionInput,
  defaultPropertyId: string,
): Promise<ProvisionedRoom> {
  const propertyId = input.propertyId ?? defaultPropertyId;
  const property = await repo.getProperty(propertyId);
  if (!property) throw new ProvisioningError(`Unknown property ${propertyId}`, 404);

  const roomId = 'r_' + slug(input.roomNumber);
  const deviceId = input.deviceId ?? 'd_' + slug(input.roomNumber) + 'a';

  let roomTypeId = input.roomTypeId ?? '';
  if (input.roomTypeId) {
    if (!property.roomTypes.some((t) => t.id === input.roomTypeId)) {
      const known = property.roomTypes.map((t) => t.id).join(', ');
      throw new ProvisioningError(
        `Unknown roomTypeId ${input.roomTypeId}. Known types: ${known}`,
      );
    }
  } else {
    // An inline capability list creates a type dedicated to this room. Writing it into the
    // property keeps one source of truth: the manifest is still derived from the room type,
    // exactly as it is for seeded rooms, rather than a second parallel path.
    roomTypeId = 'rt_' + slug(input.roomNumber);
    const zones = input.zones ?? ['bedroom'];
    const existing = property.roomTypes.findIndex((t) => t.id === roomTypeId);
    const roomType: (typeof property.roomTypes)[number] = {
      id: roomTypeId,
      count: 1,
      capabilityManifest: {
        version: '1',
        zones,
        capabilities: (input.capabilities ?? []).map((c) => ({
          capability: c.capability,
          zones: c.zones ?? zones,
        })),
        scenes: [],
      },
    };

    if (existing >= 0) property.roomTypes[existing] = roomType;
    else property.roomTypes.push(roomType);
    await repo.upsertProperty(property);
  }

  await repo.upsertRoom({ roomId, propertyId, roomNumber: input.roomNumber, roomTypeId, vendorRoomId: input.vendorRoomId });
  await repo.upsertDevice({
    deviceId,
    tenantId: property.tenantId,
    propertyId,
    roomId,
    boundAt: Date.now(),
    certificateSerial: 'provisioned-' + deviceId,
    revoked: false,
  });

  // Resolution is cached per device; without this the new room is invisible for up to a minute
  // and the first call after provisioning fails for no visible reason.
  catalog.invalidate();

  const resolved = await catalog.resolveDevice(deviceId);
  return {
    roomId,
    roomNumber: input.roomNumber,
    vendorRoomId: input.vendorRoomId,
    roomTypeId,
    deviceId,
    propertyId,
    capabilities: resolved.manifest.capabilities.map((c) => c.capability),
  };
}

export interface ConfiguredRoom {
  roomId: string;
  roomNumber: string;
  vendorRoomId: string;
  roomTypeId: string;
  deviceIds: string[];
  capabilities: string[];
}

/** Everything currently addressable, for the console and for anyone integrating. */
export async function listConfigured(
  repo: CatalogRepository,
  catalog: CatalogService,
  propertyId: string,
): Promise<{ propertyId: string; roomTypes: string[]; rooms: ConfiguredRoom[] }> {
  const property = await repo.getProperty(propertyId);
  if (!property) throw new ProvisioningError(`Unknown property ${propertyId}`, 404);

  const rooms = await repo.listRooms(propertyId);
  const out: ConfiguredRoom[] = [];

  for (const room of rooms) {
    let capabilities: string[] = [];
    try {
      capabilities = catalog.manifestFor(property, room).capabilities.map((c) => c.capability);
    } catch {
      // A room pointing at a missing room type is a real misconfiguration; report it as such
      // rather than failing the whole listing.
      capabilities = ['<unknown room type ' + room.roomTypeId + '>'];
    }
    out.push({
      roomId: room.roomId,
      roomNumber: room.roomNumber,
      vendorRoomId: room.vendorRoomId,
      roomTypeId: room.roomTypeId,
      deviceIds: await devicesFor(repo, room.roomId),
      capabilities,
    });
  }

  return { propertyId, roomTypes: property.roomTypes.map((t) => t.id), rooms: out };
}

/**
 * The repository is keyed by device, not by room, so this walks the known device ids.
 *
 * Acceptable because the set is small and this runs on an admin path, never on a turn. A
 * Postgres-backed repository would answer it with an index instead.
 */
async function devicesFor(repo: CatalogRepository, roomId: string): Promise<string[]> {
  const anyRepo = repo as CatalogRepository & { allDevices?: () => Promise<Array<{ deviceId: string; roomId: string }>> };
  if (typeof anyRepo.allDevices !== 'function') return [];
  const devices = await anyRepo.allDevices();
  return devices.filter((d) => d.roomId === roomId).map((d) => d.deviceId);
}
