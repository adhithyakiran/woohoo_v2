import { describe, expect, it } from 'vitest';
import { CapabilityId } from '@woohoo/contracts';

import {
  collisions,
  isMapped,
  mapCommand,
  mapRoom,
  renderBody,
  resolve,
  type RawCommand,
} from './mapping.js';

/** A row shaped like the ones in roomAutomationServices. */
const row = (over: Partial<RawCommand> = {}): RawCommand => ({
  id: 1,
  roomId: 2389,
  serviceName: 'schneider',
  itemName: 'Bedroom',
  stateName: 'Bedroom On',
  stateType: 'toggle',
  stateValue: 'true',
  apiMethod: 'PUT',
  apiUrl: 'http://localhost:8092/v1/protocols/bacnet/local/objects/79742578/properties/85',
  apiHeaders: null,
  apiBody: { anyOfValue: [{ isArray: false, type: 'unsigned_integer', value: 6 }] },
  ...over,
});

const mapped = (r: RawCommand) => {
  const result = mapCommand(r);
  if (!isMapped(result)) throw new Error(`expected a mapping, got: ${result.reason}`);
  return result;
};

describe('deriving a capability from a row', () => {
  it('reads the zone out of itemName', () => {
    expect(mapped(row())).toMatchObject({
      capability: CapabilityId.LightingOnOff,
      zone: 'bedroom',
      value: true,
    });
    expect(mapped(row({ itemName: 'Bathroom', stateName: 'Bathroom Off', stateValue: 'false' }))).toMatchObject({
      zone: 'bathroom',
      value: false,
    });
    expect(mapped(row({ itemName: 'Foyer', stateName: 'Foyer On' })).zone).toBe('entrance');
  });

  it('treats Master as the whole room - lighting with no zone', () => {
    const m = mapped(row({ itemName: 'Master', stateName: 'Master On' }));
    expect(m.capability).toBe(CapabilityId.LightingOnOff);
    expect(m.zone).toBeUndefined();
  });

  it('maps named lighting states to scenes, because "Night Off" is not a negation', () => {
    expect(mapped(row({ itemName: 'Night', stateName: 'Night On' }))).toMatchObject({
      capability: CapabilityId.LightingScene,
      value: 'night',
    });
    expect(mapped(row({ itemName: 'Night', stateName: 'Night Off', stateValue: 'false' })).value).toBe(
      'night_off',
    );
  });

  it('maps dnd, curtains and fan speed', () => {
    expect(mapped(row({ itemName: 'DnD', stateName: 'Activate DnD' })).capability).toBe(CapabilityId.Dnd);
    expect(mapped(row({ itemName: 'Curtains', stateName: 'Open Curtains' }))).toMatchObject({
      capability: CapabilityId.CurtainsOpenClose,
      value: true,
    });
    expect(
      mapped(row({ itemName: 'Fanmode', stateName: 'Change Fanmode', stateType: 'fanmode', stateValue: 'medium' })),
    ).toMatchObject({ capability: CapabilityId.ClimateMode, value: 'medium' });
  });

  it('marks a setpoint row as taking its value from the operation', () => {
    const m = mapped(
      row({ itemName: 'Set Temperature', stateName: 'Temperature', stateType: 'temperature', stateValue: null }),
    );
    expect(m.capability).toBe(CapabilityId.ClimateSetpoint);
    expect(m.value).toBeNull();
  });

  it('falls back to the state name when stateValue is empty', () => {
    expect(mapped(row({ stateValue: null, stateName: 'Bedroom Off' })).value).toBe(false);
    expect(mapped(row({ stateValue: '', stateName: 'Activate DnD', itemName: 'DnD' })).value).toBe(true);
  });
});

describe('what it refuses to guess', () => {
  it('will not invent a capability for a housekeeping request', () => {
    const result = mapCommand(row({ itemName: 'MuR', stateName: 'Activate MUR' }));
    expect(isMapped(result)).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/housekeeping/);
  });

  it('reports an unknown item rather than picking something plausible', () => {
    const result = mapCommand(row({ itemName: 'Jacuzzi', stateName: 'Jacuzzi On' }));
    expect(isMapped(result)).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/no capability for item/);
  });

  it('reports a state name it cannot read as on or off', () => {
    const result = mapCommand(row({ stateName: 'Scene 4', stateValue: null }));
    expect(isMapped(result)).toBe(false);
  });
});

describe('resolving an operation to a row', () => {
  const mapping = mapRoom(2389, [
    row({ id: 34, itemName: 'Bedroom', stateName: 'Bedroom On', stateValue: 'true' }),
    row({ id: 35, itemName: 'Bedroom', stateName: 'Bedroom Off', stateValue: 'false' }),
    row({ id: 36, itemName: 'Bathroom', stateName: 'Bathroom On', stateValue: 'true' }),
    row({ id: 21, itemName: 'Master', stateName: 'Master On', stateValue: 'true' }),
    row({
      id: 15568,
      itemName: 'Set Temperature',
      stateName: 'Temperature',
      stateType: 'temperature',
      stateValue: null,
    }),
  ]);

  it('picks the row for the zone and value asked for', () => {
    expect(resolve(mapping, { capability: CapabilityId.LightingOnOff, zone: 'bedroom', value: true })?.row.id).toBe(34);
    expect(resolve(mapping, { capability: CapabilityId.LightingOnOff, zone: 'bedroom', value: false })?.row.id).toBe(35);
    expect(resolve(mapping, { capability: CapabilityId.LightingOnOff, zone: 'bathroom', value: true })?.row.id).toBe(36);
  });

  it('treats a zoneless request as the room-wide row', () => {
    expect(resolve(mapping, { capability: CapabilityId.LightingOnOff, value: true })?.row.id).toBe(21);
  });

  it('uses the template row for any setpoint value', () => {
    expect(resolve(mapping, { capability: CapabilityId.ClimateSetpoint, value: 21 })?.row.id).toBe(15568);
    expect(resolve(mapping, { capability: CapabilityId.ClimateSetpoint, value: 18 })?.row.id).toBe(15568);
  });

  it('returns nothing rather than a near miss', () => {
    expect(resolve(mapping, { capability: CapabilityId.LightingOnOff, zone: 'living', value: true })).toBeUndefined();
    expect(resolve(mapping, { capability: CapabilityId.Dnd, value: true })).toBeUndefined();
  });
});

describe('template bodies', () => {
  it('substitutes the operation value into a placeholder', () => {
    const body = { anyOfValue: [{ isArray: false, type: 'float', value: '{{temperature}}' }] };
    expect(renderBody(body, 21)).toEqual({ anyOfValue: [{ isArray: false, type: 'float', value: 21 }] });
  });

  it('substitutes into a nested vendor envelope', () => {
    const body = { room_info: { room_id: 'abc' }, command: { action: 'setpoint', value: '{{temperature}}' } };
    expect(renderBody(body, 23)).toEqual({
      room_info: { room_id: 'abc' },
      command: { action: 'setpoint', value: 23 },
    });
  });

  it('leaves a body with no placeholder untouched', () => {
    const body = { curtainId: '0', state: 'Open' };
    expect(renderBody(body, true)).toEqual(body);
    expect(renderBody(null, 1)).toBeNull();
  });
});

describe('two devices under one capability', () => {
  it('reports the ambiguity rather than letting resolve pick in silence', () => {
    const mapping = mapRoom(3067, [
      row({ id: 1, itemName: 'Bedroom', stateName: 'Bedroom On', stateValue: 'true' }),
      row({ id: 2, itemName: 'BedSide', stateName: 'BedSide On', stateValue: 'true' }),
    ]);
    const clashes = collisions(mapping);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.key).toBe(`${CapabilityId.LightingOnOff}/bedroom`);
    expect(clashes[0]!.items).toEqual(['BedSide', 'Bedroom']);
  });

  it('says nothing when each capability has one device', () => {
    const mapping = mapRoom(2389, [
      row({ id: 1, itemName: 'Bedroom', stateName: 'Bedroom On', stateValue: 'true' }),
      row({ id: 2, itemName: 'Bedroom', stateName: 'Bedroom Off', stateValue: 'false' }),
      row({ id: 3, itemName: 'Bathroom', stateName: 'Bathroom On', stateValue: 'true' }),
    ]);
    expect(collisions(mapping)).toEqual([]);
  });
});

describe('a zoned request in a room that does not model zones', () => {
  const zoneless = mapRoom(2389, [
    row({ id: 15568, itemName: 'Set Temperature', stateName: 'Temperature', stateType: 'temperature', stateValue: null }),
    row({ id: 21, itemName: 'Master', stateName: 'Master On', stateValue: 'true' }),
  ]);

  it('serves it from the room-wide row - one thermostat is the bedroom thermostat', () => {
    expect(resolve(zoneless, { capability: CapabilityId.ClimateSetpoint, zone: 'bedroom', value: 21 })?.row.id).toBe(15568);
    expect(resolve(zoneless, { capability: CapabilityId.LightingOnOff, zone: 'bedroom', value: true })?.row.id).toBe(21);
  });

  it('still refuses when the room does model zones and lacks the one asked for', () => {
    const zoned = mapRoom(2389, [
      row({ id: 34, itemName: 'Bedroom', stateName: 'Bedroom On', stateValue: 'true' }),
      row({ id: 36, itemName: 'Bathroom', stateName: 'Bathroom On', stateValue: 'true' }),
    ]);
    expect(resolve(zoned, { capability: CapabilityId.LightingOnOff, zone: 'living', value: true })).toBeUndefined();
  });
});
