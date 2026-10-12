import type { IncomingMessage } from 'node:http';

/**
 * Device identity verification - integration review R9.
 *
 * The review is right that a body `deviceId` is not proof of room access, and right that
 * `certificateSerial` was accepted and never checked. Both are fixed here, but it is worth
 * being precise about what this does and does not achieve, because overclaiming on an auth
 * control is worse than not having one.
 *
 * A certificate serial is an identifier, not a secret. Comparing a serial the *client* sent
 * against the stored one proves nothing: anyone who can read a serial can send it. So the
 * serial is only trusted when it arrives in a header written by the TLS terminator from a
 * verified client certificate - which is how ALB, nginx and Envoy all expose mTLS. The
 * private key never leaves the device, and possession of it is what the TLS handshake proves.
 * This module is the authorisation half: given an identity the transport has already proven,
 * does it match the device record the request claims to be.
 *
 * A client-asserted serial is still used for one thing: contradiction. If a device announces
 * a serial that disagrees with its record, that is a mis-provisioned or cloned device, and
 * accepting it is how a hub ends up driving a room it was never bound to. That is refused
 * whether or not enforcement is on, because it is a correctness failure rather than a
 * policy one.
 */

/** Header the TLS terminator writes the verified client-certificate serial into. */
const DEFAULT_TRUSTED_HEADER = 'x-client-cert-serial';

export interface DeviceIdentityOptions {
  /**
   * Whether an unverified caller is refused. Off by default so a local console and the
   * device simulator keep working; documented as mandatory in production, and `/health`
   * reports which mode is live so a deployment cannot quietly run open.
   */
  required: boolean;
  trustedHeader: string;
}

export function identityOptionsFromEnv(): DeviceIdentityOptions {
  return {
    required: /^(1|true|yes)$/i.test(process.env.WOOHOO_REQUIRE_DEVICE_AUTH?.trim() ?? ''),
    trustedHeader:
      process.env.WOOHOO_CLIENT_CERT_HEADER?.trim().toLowerCase() || DEFAULT_TRUSTED_HEADER,
  };
}

export type IdentityVerdict =
  | { ok: true; verified: boolean; serial?: string }
  | { ok: false; status: number; error: string; detail: string };

function headerValue(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/**
 * Decide whether this request may act as `device`.
 *
 * `claimedSerial` is whatever the client asserted (the WebSocket hello frame); it is checked
 * for contradiction but never accepted as proof.
 */
export function verifyDeviceIdentity(
  req: Pick<IncomingMessage, 'headers'>,
  device: { deviceId: string; certificateSerial: string } | undefined,
  opts: DeviceIdentityOptions,
  claimedSerial?: string,
): IdentityVerdict {
  const presented = headerValue(req, opts.trustedHeader);

  // A device that contradicts its own record is refused regardless of enforcement: the
  // request is either mis-provisioned or forged, and neither should reach a room.
  if (device && claimedSerial && claimedSerial !== device.certificateSerial) {
    return {
      ok: false,
      status: 403,
      error: 'CERTIFICATE_MISMATCH',
      detail:
        'The certificate serial announced by this device does not match its record. The '
        + 'binding is stale or the identity is forged; re-provision rather than retry.',
    };
  }

  if (presented) {
    if (!device) {
      return {
        ok: false,
        status: 404,
        error: 'DEVICE_UNKNOWN',
        detail: 'No device record for this identity.',
      };
    }
    if (presented !== device.certificateSerial) {
      return {
        ok: false,
        status: 403,
        error: 'CERTIFICATE_MISMATCH',
        detail:
          'The verified client certificate belongs to a different device than the one this '
          + 'request claims to act as.',
      };
    }
    return { ok: true, verified: true, serial: presented };
  }

  if (opts.required) {
    return {
      ok: false,
      status: 401,
      error: 'DEVICE_UNVERIFIED',
      detail:
        'This deployment requires a verified device identity. Terminate TLS with client '
        + 'certificate verification and forward the serial in the '
        + opts.trustedHeader
        + ' header. A deviceId in the request body is not proof of room access.',
    };
  }

  // Open mode. Returned as `verified: false` rather than `true` so nothing downstream can
  // mistake a local convenience for an authenticated caller.
  return { ok: true, verified: false };
}
