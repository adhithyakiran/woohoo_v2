import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { App, TurnResponse } from '@woohoo/core';
import {
  listConfigured,
  provisionRoom,
  ProvisioningError,
  RoomProvisionSchema,
} from '@woohoo/core';
import { CONSOLE_HTML } from './console.js';

/**
 * Device Gateway — architecture doc §8 ①, §10.3, §19.
 *
 * Separate from woohoo-core from day one, and NOT for scale: it holds thousands of long-lived
 * stateful connections with a different runtime shape and a different deploy cadence. If it
 * shipped inside the monolith, every backend deploy would disconnect the whole fleet and the
 * reconnect storm would be self-inflicted (§10.3).
 *
 * This implementation covers the control plane — identity resolution, scope derivation, rate
 * limiting, reconnect/resume and the screen protocol. The audio path (binary Opus frames →
 * ASR adapter) is stubbed: transcripts arrive as control messages instead, which is exactly
 * what the device simulator sends. See the README for what that defers.
 */

export interface GatewayOptions {
  port?: number;
  app: App;
  /** Max turns per device per hour, mirroring the PDP's own limit as a cheap early gate. */
  maxTurnsPerHour?: number;
  heartbeatMs?: number;
}

/**
 * Token guarding the provisioning endpoints.
 *
 * Generated when unset rather than defaulting to open: this instance is one firewall rule away
 * from the public internet and /v1/admin/rooms can bind a device to any room. The generated
 * value is printed at startup and shown in the console, so it costs a local operator nothing
 * while being useless to anyone who has only found the port.
 */
const ADMIN_TOKEN =
  process.env.WOOHOO_ADMIN_TOKEN?.trim() || 'gen_' + randomBytes(12).toString('hex');
export const adminTokenIsGenerated = !process.env.WOOHOO_ADMIN_TOKEN?.trim();

/** The provisioning token, for startup logging and the console. Never sent to the model. */
export function adminToken(): string {
  return ADMIN_TOKEN;
}

/** The seeded property. Everything is single-property until a second one exists to test with. */
const DEFAULT_PROPERTY = process.env.WOOHOO_PROPERTY_ID?.trim() || 'p_blr_whitefield';

/** Read a bounded request body. A transcript is a sentence and a room is a small object. */
async function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('body too large');
  }
  return raw;
}

interface Connection {
  ws: WebSocket;
  deviceId: string;
  connectedAt: number;
  lastSeen: number;
  turnTimestamps: number[];
  alive: boolean;
}

/** Control-frame protocol (§19). Binary frames would carry Opus; text frames carry these. */
export type ClientMessage =
  | { type: 'hello'; deviceId: string; firmware?: string; certificateSerial?: string }
  | { type: 'turn'; transcript: string; asrConfidence?: number }
  | { type: 'barge_in' }
  | { type: 'health'; rssi?: number; wakeFalseAccepts?: number }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'ready'; property: string; room: string; assistantName: string; phrasePackVersion: string }
  | { type: 'ack'; filledPause: string }
  | { type: 'speak'; text: string; turnId: string }
  | { type: 'screen'; text: string }
  | { type: 'error'; code: string; detail: string }
  | { type: 'pong' };

export class DeviceGateway {
  private readonly connections = new Map<WebSocket, Connection>();
  /** Live turn-feed subscribers (the console). Any turn from any transport is broadcast
   *  here, so a curl from a terminal shows up in the UI without polling. */
  private readonly feed = new Set<ServerResponse>();
  private wss?: WebSocketServer;
  private http?: Server;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly opts: GatewayOptions) {}

  /** Resolves with the port actually bound, which differs from the request when port 0 is used. */
  start(): Promise<number> {
    const requested = this.opts.port ?? 8443;
    return new Promise((resolve) => {
      // One HTTP server carries both surfaces on one port, which is also how it must look in
      // production: hotel networks pass 443 and little else (§22), so asking for a second
      // port is asking for a firewall change nobody will make.
      this.http = createServer((req, res) => void this.onHttp(req, res));
      this.wss = new WebSocketServer({ server: this.http });
      this.wss.on('connection', (ws) => this.onConnection(ws));

      this.http.listen(requested, () => {
        const addr = this.http!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : requested);
      });

      // Dead-peer detection. Hotel Wi-Fi drops connections without a close frame constantly,
      // and without this the connection table grows until the process falls over.
      const interval = this.opts.heartbeatMs ?? 30_000;
      this.heartbeat = setInterval(() => {
        for (const [ws, conn] of this.connections) {
          if (!conn.alive) {
            ws.terminate();
            this.connections.delete(ws);
            continue;
          }
          conn.alive = false;
          ws.ping();
        }
      }, interval);
      this.heartbeat.unref?.();
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const ws of this.connections.keys()) ws.close();
    this.connections.clear();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => this.http?.close(() => resolve()) ?? resolve());
  }

  /** One shape for the HTTP response, the WS push and the live feed, so they cannot drift. */
  private turnPayload(result: TurnResponse, transport: 'http' | 'ws') {
    return {
      kind: 'turn.completed' as const,
      turnId: result.turnId,
      at: new Date().toISOString(),
      transport,
      transcript: result.transcript,
      speech: result.speech,
      screen: result.screen,
      lane: result.lane,
      escalated: result.escalated,
      awaitingConfirmation: result.awaitingConfirmation,
      degradationLevel: result.degradationLevel,
      totalMs: result.totalMs,
      costUsd: Number(result.costUsd.toFixed(6)),
      reasoning: result.reasoning,
      // Per-call outcomes. Arguments stay out: they can carry guest content, and the audit
      // record is the place for those.
      calls: result.calls.map((c) => ({
        tool: c.tool,
        tier: c.verdict.tier,
        verdict: c.verdict.kind,
        ruleId: c.verdict.ruleId,
        reason: c.verdict.reason,
        ok: Boolean(c.result?.ok),
        error: c.result?.error?.error,
        latencyMs: c.result?.latencyMs,
      })),
      pipeline: result.pipeline,
      guardrails: result.guardrails,
      // The head-end traffic behind those calls: object addressed, value asked for, value
      // the controller reported back. This is the layer that fails in a real hotel, and
      // capability-level logging hides it completely.
      vendorCalls: result.vendorCalls,
    };
  }

  /** Push a turn to every live-feed subscriber. Never allowed to break the turn itself. */
  private broadcast(payload: unknown): void {
    if (!this.feed.size) return;
    const frame = 'data: ' + JSON.stringify(payload) + String.fromCharCode(10, 10);
    for (const res of this.feed) {
      try { res.write(frame); } catch { this.feed.delete(res); }
    }
  }

  /**
   * HTTP surface — architecture doc §19.
   *
   * The WebSocket remains the production device path: a TLS handshake per turn costs 200–400ms
   * against a 1,100ms p50 budget, and only a persistent connection can carry server-initiated
   * pushes (screen updates, late BMS confirmations that land after the agent has spoken).
   *
   * This request/response surface exists because it is far easier to integrate and test
   * against — curl, the Android team's first spike, and any non-voice caller. It runs the
   * identical orchestrator path, so behaviour cannot drift between the two.
   */
  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // CORS. A browser-based caller — the web UI, or this console pointed at another host —
    // cannot read a cross-origin response without these, and the failure surfaces in the
    // browser as an opaque network error that looks like the server being down.
    //
    // Permissive because there is nothing here to protect with an origin check: the turn
    // endpoint is unauthenticated, so an origin allowlist would be security theatre. The
    // control that matters is the firewall, and eventually device authentication.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const json = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        ...cors,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      res.end(payload);
    };

    // Test console. Served from the gateway itself so it works over an SSH tunnel with no
    // separate host, no build step and no CDN — the interesting behaviour of this system
    // (lane, verdicts, rule IDs) is invisible in a raw HTTP response.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(CONSOLE_HTML);
      return;
    }

    // Live turn feed. Lets the console show turns that originated anywhere — a curl from a
    // terminal, the Android app, another service — without polling.
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write('retry: 2000' + String.fromCharCode(10, 10));
      this.feed.add(res);
      const keepalive = setInterval(() => {
        try { res.write(': keepalive' + String.fromCharCode(10, 10)); } catch { /* closed */ }
      }, 20_000);
      keepalive.unref?.();
      req.on('close', () => { clearInterval(keepalive); this.feed.delete(res); });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(200, {
        status: 'ok',
        connections: this.connections.size,
        uptimeS: Math.round(process.uptime()),
        // Surfaced so it is obvious at a glance whether the real model is wired up —
        // "why is it behaving like a pattern matcher" is otherwise a slow thing to notice.
        provider: this.opts.app.llm.name,
        model: this.opts.app.llm.model,
        // Same reasoning for the room adapter: a stack quietly running the in-process
        // simulator looks identical to one driving real hardware until someone walks
        // into the room and finds the lights did not move.
        adapter: this.opts.app.adapter.vendor,
      });
      return;
    }

    // ── provisioning (control plane) ──────────────────────────────────────
    // Deliberately not on the MCP tool surface: anything the agent can call is something it
    // can be argued into calling, and "make a room with every capability and bind my device"
    // is exactly what an attacker would ask for.
    if (url.pathname === '/v1/admin/rooms') {
      const supplied = (req.headers['x-admin-token'] as string | undefined)?.trim();
      if (supplied !== ADMIN_TOKEN) {
        json(401, {
          error: 'UNAUTHORISED',
          detail: 'Send the admin token in the x-admin-token header. It is printed in the '
            + 'service logs at startup and shown in the console Rooms tab.',
        });
        return;
      }

      const propertyId = url.searchParams.get('propertyId') ?? DEFAULT_PROPERTY;

      if (req.method === 'GET') {
        try {
          json(200, await listConfigured(this.opts.app.catalogRepo, this.opts.app.catalog, propertyId));
        } catch (err) {
          const status = err instanceof ProvisioningError ? err.status : 500;
          json(status, { error: 'LIST_FAILED', detail: String(err instanceof Error ? err.message : err) });
        }
        return;
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(400, { error: 'BAD_REQUEST', detail: 'Body was not valid JSON.' });
          return;
        }

        const parsed = RoomProvisionSchema.safeParse(body);
        if (!parsed.success) {
          json(400, {
            error: 'INVALID_ROOM',
            detail: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
          });
          return;
        }

        try {
          const room = await provisionRoom(
            this.opts.app.catalogRepo,
            this.opts.app.catalog,
            parsed.data,
            propertyId,
          );
          json(201, { created: room });
        } catch (err) {
          const status = err instanceof ProvisioningError ? err.status : 500;
          json(status, {
            error: 'PROVISION_FAILED',
            detail: String(err instanceof Error ? err.message : err),
          });
        }
        return;
      }

      json(405, { error: 'METHOD_NOT_ALLOWED', detail: 'Use GET to list or POST to create.' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/turn') {
      let raw = '';
      try {
        for await (const chunk of req) {
          raw += chunk;
          // Bound the body: a transcript is a sentence, not a payload.
          if (raw.length > 16_384) {
            json(413, { error: 'PAYLOAD_TOO_LARGE', detail: 'Body exceeds 16KB.' });
            return;
          }
        }
      } catch {
        json(400, { error: 'BAD_REQUEST', detail: 'Could not read the request body.' });
        return;
      }

      let body: { deviceId?: string; transcript?: string; asrConfidence?: number };
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        json(400, { error: 'BAD_REQUEST', detail: 'Body was not valid JSON.' });
        return;
      }

      if (!body.deviceId || !body.transcript) {
        json(400, {
          error: 'BAD_REQUEST',
          detail: 'deviceId and transcript are both required.',
        });
        return;
      }

      try {
        // Announce arrival before doing the work, so an observer sees the request land and
        // sees it running rather than only learning about it once it is already over.
        this.broadcast({
          kind: 'turn.received',
          at: new Date().toISOString(),
          transport: 'http',
          deviceId: body.deviceId,
          transcript: body.transcript,
        });

        const result = await this.opts.app.orchestrator.handleTurn({
          deviceId: body.deviceId,
          transcript: body.transcript,
          asrConfidence: body.asrConfidence ?? 0.95,
        });

        const payload = this.turnPayload(result, 'http');
        this.broadcast(payload);
        json(200, payload);
      } catch (err) {
        // An unknown or revoked device is a client error, not a server fault.
        const message = err instanceof Error ? err.message : String(err);
        const unknownDevice = /unknown device|revoked|binding/i.test(message);
        json(unknownDevice ? 404 : 500, {
          error: unknownDevice ? 'UNKNOWN_DEVICE' : 'TURN_FAILED',
          detail: message,
        });
      }
      return;
    }

    json(404, { error: 'NOT_FOUND', detail: `No route for ${req.method} ${url.pathname}.` });
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private onConnection(ws: WebSocket): void {
    ws.on('pong', () => {
      const c = this.connections.get(ws);
      if (c) {
        c.alive = true;
        c.lastSeen = Date.now();
      }
    });

    ws.on('message', (raw) => {
      void this.onMessage(ws, raw.toString());
    });

    ws.on('close', () => this.connections.delete(ws));
    ws.on('error', () => this.connections.delete(ws));
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { type: 'error', code: 'BAD_FRAME', detail: 'Frame was not valid JSON.' });
      return;
    }

    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'hello') {
      await this.onHello(ws, msg);
      return;
    }

    const conn = this.connections.get(ws);
    // Every other frame requires an established identity. Nothing is processed for a device
    // that has not resolved to a tenant, property and room.
    if (!conn) {
      this.send(ws, { type: 'error', code: 'NOT_AUTHENTICATED', detail: 'Send hello first.' });
      return;
    }
    conn.lastSeen = Date.now();

    switch (msg.type) {
      case 'turn':
        await this.onTurn(ws, conn, msg);
        break;
      case 'health':
        // Telemetry belongs on the separate MQTT channel in production (§19) so that telemetry
        // backpressure can never reach the voice path. Accepted here for the single-process dev stack.
        break;
      case 'barge_in':
        break;
    }
  }

  private async onHello(ws: WebSocket, msg: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    try {
      // In production the device identity comes from the validated mTLS client certificate,
      // not from the frame. The resolution below is the same either way — this is the single
      // point where device_id becomes {tenant, property, room} (§7, P2).
      const resolved = await this.opts.app.catalog.resolveDevice(msg.deviceId);

      this.connections.set(ws, {
        ws,
        deviceId: msg.deviceId,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        turnTimestamps: [],
        alive: true,
      });

      this.send(ws, {
        type: 'ready',
        property: resolved.property.name,
        room: resolved.room.roomNumber,
        assistantName: resolved.property.brand.assistantName,
        phrasePackVersion: `${resolved.property.brand.voiceId}@${resolved.property.defaultLanguage}`,
      });
    } catch (err) {
      this.send(ws, {
        type: 'error',
        code: 'UNKNOWN_DEVICE',
        detail: err instanceof Error ? err.message : 'Device could not be resolved.',
      });
      ws.close();
    }
  }

  private async onTurn(
    ws: WebSocket,
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'turn' }>,
  ): Promise<void> {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    conn.turnTimestamps = conn.turnTimestamps.filter((t) => t >= hourAgo);

    if (conn.turnTimestamps.length >= (this.opts.maxTurnsPerHour ?? 30)) {
      this.send(ws, {
        type: 'error',
        code: 'RATE_LIMITED',
        detail: 'Too many requests from this device in the last hour.',
      });
      return;
    }
    conn.turnTimestamps.push(now);

    this.broadcast({
      kind: 'turn.received',
      at: new Date().toISOString(),
      transport: 'ws',
      deviceId: conn.deviceId,
      transcript: msg.transcript,
    });

    // Acknowledge immediately from the cached phrase pack. This is the §20.4 filled pause and
    // it is why perceived latency is ~600ms even when the agentic lane takes far longer.
    this.send(ws, {
      type: 'ack',
      filledPause: this.opts.app.orchestrator.filledPause(conn.turnTimestamps.length),
    });

    try {
      const res = await this.opts.app.orchestrator.handleTurn({
        deviceId: conn.deviceId,
        transcript: msg.transcript,
        asrConfidence: msg.asrConfidence ?? 0.95,
      });
      this.send(ws, { type: 'speak', text: res.speech, turnId: res.turnId });
      if (res.screen) this.send(ws, { type: 'screen', text: res.screen });
      // WebSocket turns appear in the live feed too, so the console shows device traffic
      // regardless of which transport produced it.
      this.broadcast(this.turnPayload(res, 'ws'));
    } catch (err) {
      this.send(ws, {
        type: 'error',
        code: 'TURN_FAILED',
        detail: err instanceof Error ? err.message : 'The turn could not be completed.',
      });
    }
  }
}
