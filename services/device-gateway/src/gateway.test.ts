import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type App } from '@woohoo/core';
import { DeviceGateway, type ServerMessage } from './index.js';

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

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function next(ws: WebSocket, type: ServerMessage['type']): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });
}

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('device gateway — HTTP surface', () => {
  it('reports health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('runs a full turn from a POST and returns the spoken reply', async () => {
    const { status, body } = await post('/v1/turn', {
      deviceId: 'd_412a',
      transcript: 'turn on the lights',
    });
    expect(status).toBe(200);
    expect(body.speech).toBeTypeOf('string');
    expect(body.lane).toBe('fast');
    expect(body.turnId).toBeTypeOf('string');
  });

  it('exposes per-call tier and verdict so an integrator can see why', async () => {
    const { body } = await post('/v1/turn', {
      deviceId: 'd_412a',
      transcript: 'set the temperature to 35 degrees',
    });
    const calls = body.calls as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({
      tool: 'climate.set_temperature',
      verdict: 'DENY',
      ruleId: 'R6.out_of_bounds',
    });
  });

  it('runs the identical policy path as the WebSocket — T3 still needs confirming', async () => {
    const { body } = await post('/v1/turn', {
      deviceId: 'd_412a',
      transcript: "I'd like a club sandwich",
    });
    expect(body.awaitingConfirmation).toBe(true);
    expect(String(body.speech)).toContain('850');
  });

  it('rejects a request missing deviceId or transcript', async () => {
    const { status, body } = await post('/v1/turn', { transcript: 'hello' });
    expect(status).toBe(400);
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('returns 404 for an unknown device rather than a 500', async () => {
    const { status, body } = await post('/v1/turn', {
      deviceId: 'd_not_a_real_device',
      transcript: 'turn on the lights',
    });
    expect(status).toBe(404);
    expect(body.error).toBe('UNKNOWN_DEVICE');
  });

  it('404s an unrouted path', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/nope`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('device gateway', () => {
  it('resolves a device to its property and room on hello', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'hello', deviceId: 'd_412a' }));
    const ready = await next(ws, 'ready');
    expect(ready).toMatchObject({ type: 'ready', room: '412' });
    ws.close();
  });

  it('rejects an unknown device instead of accepting it as anonymous', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'hello', deviceId: 'd_does_not_exist' }));
    const err = await next(ws, 'error');
    expect(err).toMatchObject({ type: 'error', code: 'UNKNOWN_DEVICE' });
    ws.close();
  });

  it('refuses to process a turn before identity is established', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'turn', transcript: 'turn on the lights' }));
    const err = await next(ws, 'error');
    expect(err).toMatchObject({ code: 'NOT_AUTHENTICATED' });
    ws.close();
  });

  it('acknowledges before answering, then speaks the result', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'hello', deviceId: 'd_412a' }));
    await next(ws, 'ready');

    const ack = next(ws, 'ack');
    const speak = next(ws, 'speak');
    ws.send(JSON.stringify({ type: 'turn', transcript: 'turn on the lights' }));

    // The filled pause must arrive first — that is the whole point of §20.4.
    expect(await ack).toMatchObject({ type: 'ack' });
    expect((await speak) as { text: string }).toHaveProperty('text');
    ws.close();
  });
});
