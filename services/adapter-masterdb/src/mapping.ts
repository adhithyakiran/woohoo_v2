import { CapabilityId, type Zone } from '@woohoo/contracts';

/**
 * The dictionary between two vocabularies that have never met.
 *
 * The agent emits `{capability: 'lighting.on_off', zone: 'bedroom', value: true}` and is
 * forbidden from knowing anything else (§33). The V1 catalogue stores rows labelled
 * "Bedroom On" against a BACnet object id. Neither side can reach the other, so this is
 * the translation - derived from the row's own columns rather than hand-written per
 * property, because 2,610 rooms is not a thing anyone is going to type out.
 *
 * Everything it cannot work out is reported rather than guessed. A wrong guess here puts
 * a command in the wrong room, which is precisely the class of bug §39.2 is about.
 */

/** One row of roomAutomationServices, as it comes out of Postgres. */
export interface RawCommand {
  id: number;
  roomId: number;
  serviceName: string;
  itemName: string;
  stateName: string;
  stateType: string;
  stateValue: string | null;
  apiMethod: string | null;
  apiUrl: string | null;
  apiHeaders: Record<string, string> | null;
  apiBody: unknown;
}

export interface MappedCommand {
  row: RawCommand;
  capability: string;
  zone?: Zone;
  /** The V1 item this came from. Two items can share one capability+zone; see `collisions`. */
  item: string;
  /**
   * The value this row produces. `null` means the row is a template that takes its
   * value from the operation - a setpoint, not a fixed state.
   */
  value: boolean | string | null;
}

export interface UnmappedCommand {
  row: RawCommand;
  reason: string;
}

export interface RoomMapping {
  roomId: number;
  commands: MappedCommand[];
  unmapped: UnmappedCommand[];
}

/** itemName carries the zone for per-zone lighting; anything else is room-wide. */
const ZONE_BY_ITEM: Record<string, Zone> = {
  bedroom: 'bedroom',
  bathroom: 'bathroom',
  entrance: 'entrance',
  foyer: 'entrance',
  livingroom: 'living',
  'living room': 'living',
  bedside: 'bedroom',
};

/**
 * Named lighting states that are not a zone. The vendor models each as a pair of
 * commands, so the "off" half becomes its own scene value rather than a boolean.
 */
const SCENE_ITEMS = new Set(['night', 'reading', 'relax', 'welcome', 'goodnight']);

/** Housekeeping requests that arrive dressed as devices. There is no capability for these. */
const NOT_A_DEVICE = new Set(['mur', 'make up my room', 'makeupmyroom', 'mumr']);

const normalise = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** "Bedroom On" → true, "Deactivate DnD" → false. stateValue is authoritative when set. */
function booleanFor(row: RawCommand): boolean | null {
  const explicit = normalise(row.stateValue);
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;

  const name = normalise(row.stateName);
  if (/\b(on|open|activate|activated)\b/.test(name)) return true;
  if (/\b(off|close|deactivate|deactivated)\b/.test(name)) return false;
  return null;
}

function zoneFor(itemName: string): Zone | undefined {
  const item = normalise(itemName);
  for (const [key, zone] of Object.entries(ZONE_BY_ITEM)) {
    if (item === key || item.startsWith(`${key} `)) return zone;
  }
  return undefined;
}

/**
 * One row → one capability operation, or a reason it cannot be one.
 *
 * stateType is the strongest signal (toggle / fanmode / temperature); itemName decides
 * which device within a toggle.
 */
export function mapCommand(row: RawCommand): MappedCommand | UnmappedCommand {
  const item = normalise(row.itemName);
  const type = normalise(row.stateType);

  if (NOT_A_DEVICE.has(item)) {
    return {
      row,
      reason:
        'housekeeping request, not a device - belongs on the service-request path, not an adapter',
    };
  }

  if (type === 'temperature') {
    // The body carries a {{temperature}} placeholder: the value comes from the operation.
    return { row, capability: CapabilityId.ClimateSetpoint, zone: zoneFor(item), item: row.itemName, value: null };
  }

  if (type === 'fanmode') {
    const speed = normalise(row.stateValue);
    if (!['low', 'medium', 'high', 'auto', 'off'].includes(speed)) {
      return { row, reason: `unrecognised fan speed "${row.stateValue}"` };
    }
    return { row, capability: CapabilityId.ClimateMode, item: row.itemName, value: speed };
  }

  if (type !== 'toggle') {
    return { row, reason: `unrecognised stateType "${row.stateType}"` };
  }

  const on = booleanFor(row);
  if (on === null) {
    return { row, reason: `cannot tell whether "${row.stateName}" turns something on or off` };
  }

  if (item === 'dnd' || item === 'do not disturb') {
    return { row, capability: CapabilityId.Dnd, item: row.itemName, value: on };
  }

  if (item === 'curtains' || item === 'curtain' || item.endsWith('drapes')) {
    return {
      row,
      capability: CapabilityId.CurtainsOpenClose,
      zone: zoneFor(item),
      item: row.itemName,
      value: on,
    };
  }

  if (item.endsWith('tv')) {
    return { row, capability: CapabilityId.TvControl, zone: zoneFor(item), item: row.itemName, value: on };
  }

  if (SCENE_ITEMS.has(item)) {
    // A scene has no boolean: the vendor's "Night Off" is a second scene, not a negation.
    return {
      row,
      capability: CapabilityId.LightingScene,
      item: row.itemName,
      value: on ? item : `${item}_off`,
    };
  }

  // "Master" means every light in the room - lighting with no zone, which is exactly how
  // a zoneless operation is already interpreted.
  if (item === 'master' || item === 'all') {
    return { row, capability: CapabilityId.LightingOnOff, item: row.itemName, value: on };
  }

  const zone = zoneFor(item);
  if (zone) {
    return { row, capability: CapabilityId.LightingOnOff, zone, item: row.itemName, value: on };
  }

  return { row, reason: `no capability for item "${row.itemName}"` };
}

export const isMapped = (m: MappedCommand | UnmappedCommand): m is MappedCommand =>
  'capability' in m;

/**
 * Distinct V1 items that landed on the same capability+zone+value.
 *
 * "Bedroom" and "BedSide" are two lamps a guest can see and point at, but the capability
 * model has one bedroom zone and no way to say which. `resolve` therefore has to pick,
 * and picking silently is how "turn on the bedroom light" lights the wrong lamp. The
 * ambiguity is reported at onboarding instead.
 */
export function collisions(mapping: RoomMapping): Array<{ key: string; items: string[] }> {
  const byKey = new Map<string, Set<string>>();
  for (const c of mapping.commands) {
    const key = `${c.capability}${c.zone ? `/${c.zone}` : ''}:${String(c.value)}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(c.item);
  }
  return [...byKey]
    .filter(([, items]) => items.size > 1)
    .map(([key, items]) => ({ key: key.split(':')[0]!, items: [...items].sort() }));
}

export function mapRoom(roomId: number, rows: RawCommand[]): RoomMapping {
  const commands: MappedCommand[] = [];
  const unmapped: UnmappedCommand[] = [];
  for (const row of rows) {
    const result = mapCommand(row);
    if (isMapped(result)) commands.push(result);
    else unmapped.push(result);
  }
  return { roomId, commands, unmapped };
}

/**
 * Find the row that satisfies an operation.
 *
 * A zoneless request matches a zoneless row first and falls back to any zone, so
 * "turn the lights off" works in a room whose rows are all per-zone.
 */
export function resolve(
  mapping: RoomMapping,
  op: { capability: string; zone?: Zone; value: number | string | boolean },
): MappedCommand | undefined {
  const candidates = mapping.commands.filter((c) => c.capability === op.capability);
  if (!candidates.length) return undefined;

  const zoneMatches = op.zone
    ? candidates.filter((c) => c.zone === op.zone)
    : candidates.filter((c) => c.zone === undefined);

  // A zoned request against a room that does not model zones for this capability.
  //
  // Room 549 has one thermostat, stored with no zone; the router fills in `bedroom`
  // whether or not the guest said it, so refusing meant "I cannot set the temperature"
  // in a room with a working thermostat. Falling back is only safe when the room has NO
  // zoned rows for the capability - then the room-wide row IS the one serving every zone.
  // If the room does model zones and simply lacks the one asked for, that stays a refusal.
  const hasZonedRows = candidates.some((c) => c.zone !== undefined);
  const pool = zoneMatches.length
    ? zoneMatches
    : op.zone && !hasZonedRows
      ? candidates
      : op.zone
        ? []
        : candidates;

  // A template row takes any value, so it only wins when nothing matches exactly.
  const exact = pool.find((c) => c.value !== null && sameValue(c.value, op.value));
  return exact ?? pool.find((c) => c.value === null);
}

function sameValue(rowValue: boolean | string, opValue: number | string | boolean): boolean {
  if (typeof rowValue === 'boolean') return rowValue === toBoolean(opValue);
  return normalise(rowValue) === normalise(String(opValue));
}

function toBoolean(v: number | string | boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['true', 'on', 'open', '1', 'yes'].includes(normalise(v));
}

/**
 * Fill a template body. Setpoint rows store {"value":"{{temperature}}"} and the number
 * only exists at call time.
 */
export function renderBody(body: unknown, value: number | string | boolean): unknown {
  if (body === null || body === undefined) return body;
  const text = JSON.stringify(body);
  if (!text.includes('{{')) return body;
  const filled = text.replace(/"\{\{\s*\w+\s*\}\}"/g, JSON.stringify(value)).replace(
    /\{\{\s*\w+\s*\}\}/g,
    String(value),
  );
  return JSON.parse(filled);
}
