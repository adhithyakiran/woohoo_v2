import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '@woohoo/core';
import { DeviceGateway } from './index.js';
import { identityOptionsFromEnv, verifyDeviceIdentity } from './device-identity.js';

/**
 * Device identity - integration review R9.
 *
 * The review's sentence to hold onto is "a body deviceId must not be sufficient proof of room
 * access". These tests pin three things: a client-asserted serial is never treated as proof, a
 * serial that contradicts the record is refused even with enforcement off, and enforcement off
 * is visibly off rather than silently open.
 */

const DEVICE = { deviceId: 'd_412a', certificateSerial: 'cert_412a' };
const OPEN = { required: false, trustedHeader: 'x-client-cert-serial' };
const STRICT = { required: true, trustedHeader: 'x-client-cert-serial' };
const noHeaders = { headers: {} };
const withSerial = (serial: string) => ({ headers: { 'x-client-cert-serial': serial } });

describe('a verified client certificate authorises the device it belongs to', () => {
  it('allows a serial that matches the record and marks it verified', () => {
    const v = verifyDeviceIdentity(withSerial('cert_412a'), DEVICE, STRICT);
    expect(v).toEqual({ ok: true, verified: true, serial: 'cert_412a' });
  });

  it('refuses a verified certificate belonging to a different device', () => {
    const v = verifyDeviceIdentity(withSerial('cert_someone_else'), DEVICE, STRICT);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(403);
      expect(v.error).toBe('CERTIFICATE_MISMATCH');
    }
  });

  it('refuses a certificate with no device record', () => {
    const v = verifyDeviceIdentity(withSerial('cert_ghost'), undefined, STRICT);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(404);
  });
});

describe('enforcement refuses callers that proved nothing', () => {
  it('rejects a request with no verified identity when required', () => {
    const v = verifyDeviceIdentity(noHeaders, DEVICE, STRICT);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(401);
      expect(v.detail).toMatch(/not proof of room access/);
    }
  });

  it('does not accept a client-asserted serial as a substitute for one', () => {
    // The device announces the correct serial. That is still not proof, because a serial is
    // an identifier rather than a secret.
    const v = verifyDeviceIdentity(noHeaders, DEVICE, STRICT, 'cert_412a');
    expect(v.ok, 'an asserted serial must not satisfy enforcement').toBe(false);
  });
});

describe('a device that contradicts its own record is always refused', () => {
  it('rejects a mismatched announced serial even with enforcement off', () => {
    const v = verifyDeviceIdentity(noHeaders, DEVICE, OPEN, 'cert_another_room');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('CERTIFICATE_MISMATCH');
  });

  it('allows an announced serial that agrees with the record', () => {
    const v = verifyDeviceIdentity(noHeaders, DEVICE, OPEN, 'cert_412a');
    expect(v.ok).toBe(true);
  });
});

describe('open mode is open, and says so', () => {
  it('allows an unverified caller but does not call it verified', () => {
    const v = verifyDeviceIdentity(noHeaders, DEVICE, OPEN);
    expect(v).toEqual({ ok: true, verified: false });
  });

  it('defaults to not required, so a local stack keeps working', () => {
    const before = process.env.WOOHOO_REQUIRE_DEVICE_AUTH;
    delete process.env.WOOHOO_REQUIRE_DEVICE_AUTH;
    try {
      expect(identityOptionsFromEnv().required).toBe(false);
    } finally {
      if (before !== undefined) process.env.WOOHOO_REQUIRE_DEVICE_AUTH = before;
    }
  });

  it('is enabled by the documented flag', () => {
    const before = process.env.WOOHOO_REQUIRE_DEVICE_AUTH;
    process.env.WOOHOO_REQUIRE_DEVICE_AUTH = '1';
    try {
      expect(identityOptionsFromEnv().required).toBe(true);
    } finally {
      if (before === undefined) delete process.env.WOOHOO_REQUIRE_DEVICE_AUTH;
      else process.env.WOOHOO_REQUIRE_DEVICE_AUTH = before;
    }
  });
});

describe('the gateway applies it over the wire', () => {
  let gateway: DeviceGateway;
  let app: App;
  let port: number;

  beforeAll(async () => {
    app = await buildApp();
    gateway = new DeviceGateway({ app, port: 0, heartbeatMs: 60_000 });
    port = await gateway.start();
  });
  afterAll(async () => {
    await gateway.stop();
  });

  async function turn(headers: Record<string, string>) {
    const res = await fetch('http://127.0.0.1:' + port + '/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ deviceId: 'd_412a', transcript: 'turn on the lights' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('refuses a turn whose certificate belongs to another device', async () => {
    const seeded = await app.catalogRepo.getDevice('d_412a');
    expect(seeded, 'the seed should provide d_412a').toBeDefined();
    const res = await turn({ 'x-client-cert-serial': 'cert_not_this_device' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CERTIFICATE_MISMATCH');
  });

  it('accepts a turn whose certificate matches the record', async () => {
    const seeded = await app.catalogRepo.getDevice('d_412a');
    const res = await turn({ 'x-client-cert-serial': seeded!.certificateSerial });
    expect(res.status).toBe(200);
  });

  it('reports the enforcement mode on /health, so open mode is not invisible', async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/health');
    const body = (await res.json()) as { deviceAuth: string };
    expect(['required', 'disabled']).toContain(body.deviceAuth);
  });
});
