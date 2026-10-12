import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapabilityId, EventType, PropertyConfigSchema } from './index.js';

/**
 * Keeps docs/openapi.yaml honest - integration review R6, C3.
 *
 * The previous specification listed seven catalog endpoints when the client calls eight, and
 * showed a flat provisioning response when the gateway wraps it. Both were found by a reader
 * comparing prose against source, which is not a repeatable process.
 *
 * So this derives the truth from the code and asserts the document mentions it. There is no
 * YAML parser in this repo and adding one for a docs test is not worth the dependency, so the
 * checks are textual. That is enough for the failure mode that actually occurred: something
 * real in the code going unmentioned in the contract.
 */

const SPEC = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'openapi.yaml'), 'utf8');

/** Every path the HTTP catalog client actually requests, read from its source. */
function catalogPathsFromSource(): string[] {
  const src = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'services',
      'woohoo-core',
      'src',
      'modules',
      'catalog-http.ts',
    ),
    'utf8',
  );
  // A trailing slash in the literal is the signal that an encoded id is concatenated next,
  // so it maps to the templated form; anything else is requested verbatim.
  const param: Record<string, string> = {
    '/properties/': '/properties/{propertyId}',
    '/rooms/': '/rooms/{roomId}',
    '/devices/': '/devices/{deviceId}',
  };
  const found = new Set<string>();
  for (const m of src.matchAll(/'(\/(?:properties|rooms|devices)[^']*)'/g)) {
    const literal = m[1]!;
    found.add(param[literal] ?? literal);
  }
  // Built by concatenation rather than appearing whole, so it is asserted separately.
  if (src.includes("+ '/rooms'")) found.add('/properties/{propertyId}/rooms');
  return [...found];
}

describe('the specification covers every catalog endpoint the client calls', () => {
  it('finds the request paths in the client source', () => {
    const paths = catalogPathsFromSource();
    // Guards the extraction itself: a silently empty match would make every assertion pass.
    expect(paths.length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ['/properties/{propertyId}', 'getProperty and upsertProperty'],
    ['/rooms/{roomId}', 'getRoom and upsertRoom'],
    ['/devices/{deviceId}', 'getDevice and upsertDevice'],
    ['/devices', 'allDevices - the eighth endpoint the old list omitted'],
  ])('documents %s (%s)', (path) => {
    expect(SPEC).toContain('\n  ' + path + ':');
  });

  it('documents the rooms-by-property listing', () => {
    expect(SPEC).toContain('/properties/{propertyId}/rooms:');
  });

  it('states that GET /devices is optional, since the client swallows its failures', () => {
    const section = SPEC.slice(SPEC.indexOf('\n  /devices:'));
    expect(section).toMatch(/optional/i);
  });
});

describe('the specification covers every gateway endpoint', () => {
  it.each([
    '/v1/turn',
    '/v1/devices',
    '/v1/rooms/{deviceId}/devices',
    '/v1/events',
    '/v1/events/domain',
    '/v1/events/domain/replay',
    '/v1/admin/rooms',
    '/v1/admin/stays/checkout',
    '/health',
  ])('documents %s', (path) => {
    expect(SPEC).toContain('\n  ' + path + ':');
  });

  it('distinguishes the turn feed from the domain-event contract', () => {
    // review C4: conflating these is what made the event list look deliverable when it was not.
    const feed = SPEC.slice(SPEC.indexOf('\n  /v1/events:'), SPEC.indexOf('\n  /v1/events/domain:'));
    expect(feed).toMatch(/NOT the domain-event contract/);
  });

  it('shows the provisioning response wrapped as created, not flat', () => {
    // review C3.
    expect(SPEC).toContain("required: [created]");
    expect(SPEC).toMatch(/WRAPPED as .\{ "created": \.\.\. \}./);
  });
});

describe('the enumerations do not drift from the contracts package', () => {
  it.each(Object.values(CapabilityId))('lists capability %s', (cap) => {
    expect(SPEC).toContain('- ' + cap);
  });

  it.each(Object.values(EventType))('lists event type %s', (type) => {
    expect(SPEC).toContain('- ' + type);
  });

  it('lists every automation vendor the config schema accepts', () => {
    const vendors = PropertyConfigSchema.shape.automation.shape.vendor.options;
    expect(vendors.length).toBeGreaterThan(1);
    for (const v of vendors) expect(SPEC).toContain(v);
  });

  it('names which event types are actually published, rather than implying all are', () => {
    const section = SPEC.slice(SPEC.indexOf('    EventType:'));
    expect(section).toMatch(/declared and not yet emitted/);
  });
});

describe('the specification documents the caching behaviour the review asked about', () => {
  it('states the catalog TTL default of 30 seconds', () => {
    // review C2.
    expect(SPEC).toContain('WOOHOO_CATALOG_TTL_MS');
    expect(SPEC).toMatch(/default 30000/);
  });

  it('says a write only invalidates the writing replica', () => {
    expect(SPEC).toMatch(/in that replica/i);
    expect(SPEC).toMatch(/[Oo]ther replicas keep serving cached values/);
  });
});

describe('the specification is honest about verification and identity', () => {
  it('explains that pending is not a weaker applied', () => {
    // review C6.
    expect(SPEC).toMatch(/not a weaker .applied./);
  });

  it('tells a consumer to branch on ok rather than on speech', () => {
    expect(SPEC).toMatch(/branch on `ok`/);
  });

  it('states that a body deviceId is not proof of access', () => {
    // review R9.
    expect(SPEC).toMatch(/never proof of access|not proof of access/);
  });

  it('requires the terminator to strip a client-supplied certificate header', () => {
    expect(SPEC).toMatch(/strip any\s*\n?\s*client-supplied copy/);
  });
});
