import pg from 'pg';
import { PropertyConfigSchema, type PropertyConfig, type Zone } from '@woohoo/contracts';

import { collisions, mapRoom, type RawCommand, type RoomMapping } from './mapping.js';

/**
 * Turns a V1 property into the V2 catalogue - architecture doc §35.
 *
 * V1 has no concept of a room type: every room carries its own copy of every command, so
 * 2,610 rooms means 2,610 command sets. V2 attaches the capability manifest to the room
 * TYPE precisely so that eight manifests are a day's work where three hundred is a
 * project. The bridge is a fingerprint: rooms whose mapped capabilities are identical are
 * the same room type, whatever the sales brochure calls them.
 *
 * The device comes from `hubs` - the in-room unit - and stays a separate entity from the
 * room, bound revocably, because collapsing them is the V1 shortcut that makes a
 * relocated device an invisible bug (§22).
 */

export interface ImportedRoom {
  roomId: string;
  propertyId: string;
  roomNumber: string;
  roomTypeId: string;
  /** The masterdb rooms.id - what the adapter looks the command catalogue up by. */
  vendorRoomId: string;
}

export interface ImportedDevice {
  deviceId: string;
  tenantId: string;
  propertyId: string;
  roomId: string;
  certificateSerial: string;
  boundAt: number;
  revoked: boolean;
}

export interface ImportedProperty {
  property: PropertyConfig;
  rooms: ImportedRoom[];
  devices: ImportedDevice[];
  /** Per room: what could not be translated, so onboarding sees it rather than discovering it live. */
  warnings: string[];
}

interface PropertyRow {
  id: number;
  name: string;
  timeZone: string | null;
  domainId: number | null;
  domain: string | null;
  currency: string | null;
  countryCode: string | null;
}

interface RoomRow {
  id: number;
  roomNo: string;
  type: string | null;
  hubId: string | null;
  hubName: string | null;
  hubStatus: string | null;
}

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'x';

/**
 * A room type is defined by what the room can do. Two rooms with the same capabilities in
 * the same zones get the same manifest, and the count falls out of the grouping.
 */
function fingerprint(mapping: RoomMapping): string {
  return [
    ...new Set(mapping.commands.map((c) => `${c.capability}${c.zone ? `/${c.zone}` : ''}`)),
  ]
    .sort()
    .join('|');
}

function manifestFor(mapping: RoomMapping) {
  const zones = new Set<Zone>();
  const byCapability = new Map<string, Set<Zone>>();
  const scenes = new Set<string>();

  for (const cmd of mapping.commands) {
    if (cmd.zone) zones.add(cmd.zone);
    if (!byCapability.has(cmd.capability)) byCapability.set(cmd.capability, new Set());
    if (cmd.zone) byCapability.get(cmd.capability)!.add(cmd.zone);
    if (cmd.capability === 'lighting.scene' && typeof cmd.value === 'string') {
      scenes.add(cmd.value);
    }
  }

  const capabilities = [...byCapability].map(([capability, capZones]) => ({
    capability,
    ...(capZones.size ? { zones: [...capZones].sort() } : {}),
    // The policy bound the agent is told about up front, so it proposes a valid value first time.
    ...(capability === 'climate.setpoint' ? { minC: 18, maxC: 26 } : {}),
  }));

  return {
    version: '1',
    zones: zones.size ? [...zones].sort() : ['bedroom'],
    capabilities: capabilities.sort((a, b) => a.capability.localeCompare(b.capability)),
    ...(scenes.size ? { scenes: [...scenes].sort() } : {}),
  };
}

/** Every property that has at least one automation command. */
export async function propertiesWithAutomation(connection: pg.PoolConfig = {}): Promise<number[]> {
  const pool = new pg.Pool({ ...poolConfig(connection), max: 2 });
  try {
    const { rows } = await pool.query<{ id: number }>(
      `select distinct r."propertyId" as id
         from rooms r
         join "roomAutomationServices" s on s."roomId" = r.id and s."deletedAt" is null
        where r."propertyId" is not null
          and exists (select 1 from "propertyDetails" p where p.id = r."propertyId")
        order by 1`,
    );
    return rows.map((r) => r.id);
  } finally {
    await pool.end();
  }
}

function poolConfig(connection: pg.PoolConfig): pg.PoolConfig {
  return {
    host: process.env.TARGET_DB_HOST ?? 'localhost',
    port: Number(process.env.TARGET_DB_PORT ?? 5433),
    database: process.env.TARGET_DB_NAME ?? 'masterdb',
    user: process.env.TARGET_DB_USER ?? 'postgres',
    password: process.env.TARGET_DB_PASSWORD ?? 'postgres',
    application_name: 'adapter-masterdb/import',
    ...connection,
  };
}

export async function importProperty(
  propertyId: number,
  connection: pg.PoolConfig = {},
): Promise<ImportedProperty> {
  const pool = new pg.Pool({ ...poolConfig(connection), max: 3 });

  try {
    const { rows: props } = await pool.query<PropertyRow>(
      `select p.id, p.name, p."timeZone", p."domainId",
              d.name as domain, d.currency, d."countryCode"
         from "propertyDetails" p
         left join domains d on d.id = p."domainId"
        where p.id = $1`,
      [propertyId],
    );
    const prop = props[0];
    if (!prop) throw new Error(`no property ${propertyId} in masterdb`);

    const { rows: roomRows } = await pool.query<RoomRow>(
      `select r.id, r."roomNo", r.type, r."hubId",
              h.name as "hubName", h."connectionStatus" as "hubStatus"
         from rooms r
         left join hubs h on h.id = r."hubId"
        where r."propertyId" = $1
          and exists (select 1 from "roomAutomationServices" s
                       where s."roomId" = r.id and s."deletedAt" is null)
        order by r.id`,
      [propertyId],
    );
    if (!roomRows.length) throw new Error(`property ${propertyId} has no rooms with commands`);

    // A hub bound to more than one room cannot establish scope: P2 derives tenant, property
    // and room from the device identity, so a device that resolves to five rooms is a
    // command landing in the wrong one (§22, §39.2). Checked estate-wide, because two of
    // these span different properties and a per-property query cannot see that.
    const hubIds = roomRows.map((r) => r.hubId).filter((h): h is string => Boolean(h));
    const { rows: shared } = hubIds.length
      ? await pool.query<{ hubId: string; rooms: number; bound_to: string }>(
          `select r."hubId", count(*)::int as rooms,
                  string_agg(r."roomNo" || ' (property ' || r."propertyId" || ')', ', ') as bound_to
             from rooms r
            where r."hubId" = any($1::text[])
              and exists (select 1 from "roomAutomationServices" s
                           where s."roomId" = r.id and s."deletedAt" is null)
            group by 1
           having count(*) > 1`,
          [hubIds],
        )
      : { rows: [] };
    const ambiguousHubs = new Map(shared.map((h) => [h.hubId, h]));

    const { rows: commands } = await pool.query<RawCommand>(
      `select s.id, s."roomId", s."serviceName", s."itemName", s."stateName",
              s."stateType", s."stateValue", s."apiMethod", s."apiUrl",
              s."apiHeaders", s."apiBody"
         from "roomAutomationServices" s
         join rooms r on r.id = s."roomId"
        where r."propertyId" = $1 and s."deletedAt" is null
        order by s."roomId", s.sequence nulls last, s.id`,
      [propertyId],
    );

    const byRoom = new Map<number, RawCommand[]>();
    for (const cmd of commands) {
      if (!byRoom.has(cmd.roomId)) byRoom.set(cmd.roomId, []);
      byRoom.get(cmd.roomId)!.push(cmd);
    }

    const timezone = normaliseTimezone(prop.timeZone);
    const tenantId = `t_${slug(prop.domain ?? `domain_${prop.domainId}`)}`;
    const v2PropertyId = `p_${slug(prop.name)}_${prop.id}`;
    const warnings: string[] = [];
    if (!timezone) {
      warnings.push(
        `property ${prop.id}: timezone "${prop.timeZone ?? 'unset'}" is a display label, not an IANA zone - defaulted to ${DEFAULT_TIMEZONE}, which quiet hours depend on`,
      );
    }

    // Group rooms by what they can actually do.
    const types = new Map<string, { id: string; manifest: ReturnType<typeof manifestFor>; rooms: RoomRow[] }>();
    const roomTypeOf = new Map<number, string>();

    for (const room of roomRows) {
      const mapping = mapRoom(room.id, byRoom.get(room.id) ?? []);
      const key = fingerprint(mapping);
      let type = types.get(key);
      if (!type) {
        type = { id: `rt_${slug(room.type ?? 'standard')}_${types.size + 1}`, manifest: manifestFor(mapping), rooms: [] };
        types.set(key, type);
      }
      type.rooms.push(room);
      roomTypeOf.set(room.id, type.id);

      for (const u of mapping.unmapped) {
        warnings.push(`room ${room.id} (${room.roomNo}): ${u.row.itemName}/${u.row.stateName} - ${u.reason}`);
      }
      const pings = mapping.commands.filter((cmd) => /\/v\d+\/ping$/.test(cmd.row.apiUrl ?? ''));
      if (pings.length) {
        warnings.push(
          `room ${room.id} (${room.roomNo}): ${pings.length} of ${mapping.commands.length} commands point at a ping endpoint and control nothing`,
        );
      }
      for (const clash of collisions(mapping)) {
        warnings.push(
          `room ${room.id} (${room.roomNo}): ${clash.items.join(' and ')} both answer to ` +
            `${clash.key} - the agent cannot tell them apart and will drive whichever comes first`,
        );
      }
      if (!room.hubId) warnings.push(`room ${room.id} (${room.roomNo}): no hub - no device can bind`);
      const shares = room.hubId ? ambiguousHubs.get(room.hubId) : undefined;
      if (shares) {
        warnings.push(
          `room ${room.id} (${room.roomNo}): hub ${room.hubId} is also bound to ${shares.bound_to} ` +
            `- ${shares.rooms} rooms share one device identity, so no device is bound for any of them`,
        );
      }
    }

    const property = PropertyConfigSchema.parse({
      propertyId: v2PropertyId,
      tenantId,
      name: prop.name,
      cell: (prop.countryCode ?? 'IN').toUpperCase() === 'IN' ? 'in' : 'eu',
      timezone: timezone ?? DEFAULT_TIMEZONE,
      languages: ['en-IN'],
      defaultLanguage: 'en-IN',
      brand: {
        voiceId: 'mock-voice-en-in',
        tone: 'warm, concise, professional',
        assistantName: 'Woohoo',
        wakeWordModel: 'ok_woohoo_v1',
      },
      // One adapter covers every V1 vendor: the row carries the request.
      automation: { vendor: 'masterdb', roomRefMapping: 'vendor_room_id' },
      pms: { type: 'none', features: [] },
      policy: {
        climate: { minC: 18, maxC: 26, maxChangesPerHour: 6 },
        quietHours: {
          start: '22:00',
          end: '07:00',
          deferNonUrgentDispatch: true,
          suppressUnattendedActuation: true,
        },
        spend: {
          perStayCap: { amount: 15000, currency: 'INR' },
          perOrderCap: { amount: 6000, currency: 'INR' },
          confirmationRequiredAbove: { amount: 0, currency: 'INR' },
        },
        serviceRequests: {
          maxOpen: 10,
          maxOpenPerCategory: 3,
          slaMinutes: { housekeeping: 20, maintenance: 45, amenity: 15 },
        },
        tierCeiling: 'T3',
        disabledTools: [],
      },
      escalation: {
        frontDesk: { channel: 'staff_app', target: 'role:front_desk' },
        dutyManager: { channel: 'sms+staff_app', target: 'rota:duty_manager' },
        emergencyNumberDisplay: '112',
      },
      roomTypes: [...types.values()].map((t) => ({
        id: t.id,
        count: t.rooms.length,
        capabilityManifest: t.manifest,
      })),
      roomOverrides: [],
      asr: { primary: 'mock', fallback: 'mock' },
      features: {
        fnbOrdering: false,
        geminiLiveChatLane: false,
        crossStayPreferences: false,
        personalisedGreeting: false,
      },
      compliance: {
        controller: prop.domain ?? prop.name,
        transcriptRetentionDays: 30,
        noticeVersion: 'in-v2',
      },
    });

    const rooms: ImportedRoom[] = roomRows.map((r) => ({
      roomId: `r_${prop.id}_${r.roomNo}`,
      propertyId: v2PropertyId,
      roomNumber: r.roomNo,
      roomTypeId: roomTypeOf.get(r.id)!,
      // NOT the hotel room number (§39.2) - the adapter looks commands up by masterdb id.
      vendorRoomId: String(r.id),
    }));

    const devices: ImportedDevice[] = roomRows
      .filter((r) => r.hubId && !ambiguousHubs.has(r.hubId))
      .map((r) => ({
        deviceId: `d_${r.hubId}`,
        tenantId,
        propertyId: v2PropertyId,
        roomId: `r_${prop.id}_${r.roomNo}`,
        // V1 hubs have no certificates. The hub id stands in until real ones are issued.
        certificateSerial: `imported:${r.hubId}`,
        boundAt: Date.now(),
        revoked: false,
      }));

    return { property, rooms, devices, warnings };
  } finally {
    await pool.end();
  }
}

/**
 * masterdb stores display labels, not zones - "GMT+02:00 Amsterdam/Cairo" contains a
 * slash but names two cities in one string. Anything Intl cannot resolve is refused, so a
 * property lands on a known-wrong default loudly rather than a plausible-wrong one quietly.
 */
export function normaliseTimezone(tz: string | null): string | null {
  if (!tz) return null;
  const candidate = tz.trim();
  const name = /^[A-Za-z]+\/[A-Za-z_+-]+$/.test(candidate)
    ? candidate
    : (candidate.match(/([A-Za-z]+\/[A-Za-z_]+)/)?.[1] ?? null);
  if (!name) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return name;
  } catch {
    return null;
  }
}
