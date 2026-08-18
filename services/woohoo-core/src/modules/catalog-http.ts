import type { PropertyConfig } from '@woohoo/contracts';
import type { CatalogRepository, DeviceRecord, RoomRecord } from './catalog.js';

/**
 * Catalog backed by an external service — architecture doc §22.
 *
 * The point of the CatalogRepository interface is that the platform does not care where room
 * and device records live. This implementation puts them behind HTTP so another team's database
 * can be the source of truth without a single change above this file.
 *
 * Reads are cached briefly. Device resolution happens on every turn, and a room's record changes
 * roughly never, so going to the network each time would add latency to the voice path in
 * exchange for freshness nobody needs. Writes invalidate immediately.
 *
 * Expected endpoints (all JSON):
 *
 *   GET  {base}/properties/:propertyId  -> PropertyConfig
 *   GET  {base}/rooms/:roomId           -> RoomRecord
 *   GET  {base}/devices/:deviceId       -> DeviceRecord
 *   GET  {base}/properties/:id/rooms    -> RoomRecord[]
 *   PUT  {base}/properties/:propertyId  -> 2xx
 *   PUT  {base}/rooms/:roomId           -> 2xx
 *   PUT  {base}/devices/:deviceId       -> 2xx
 *
 * A 404 means "not configured" and is returned as undefined; every other failure throws, because
 * silently treating an outage as "no such room" would revoke a working device mid-stay.
 */
export interface HttpCatalogOptions {
  baseUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Sent as Authorization if the upstream needs it. */
  token?: string;
}

export class CatalogUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogUnavailable';
  }
}

export class HttpCatalogRepository implements CatalogRepository {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly token?: string;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(opts: HttpCatalogOptions = {}) {
    const base = opts.baseUrl ?? process.env.WOOHOO_CATALOG_URL ?? '';
    if (!base) throw new CatalogUnavailable('WOOHOO_CATALOG_URL is not set');
    this.baseUrl = base.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.WOOHOO_CATALOG_TIMEOUT_MS ?? 3000);
    this.ttlMs = opts.cacheTtlMs ?? Number(process.env.WOOHOO_CATALOG_TTL_MS ?? 30_000);
    this.token = opts.token ?? process.env.WOOHOO_CATALOG_TOKEN;
  }

  async getProperty(propertyId: string): Promise<PropertyConfig | undefined> {
    return this.get<PropertyConfig>('/properties/' + encodeURIComponent(propertyId));
  }

  async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    return this.get<RoomRecord>('/rooms/' + encodeURIComponent(roomId));
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.get<DeviceRecord>('/devices/' + encodeURIComponent(deviceId));
  }

  async listRooms(propertyId: string): Promise<RoomRecord[]> {
    const rooms = await this.get<RoomRecord[]>(
      '/properties/' + encodeURIComponent(propertyId) + '/rooms',
    );
    return rooms ?? [];
  }

  async upsertProperty(cfg: PropertyConfig): Promise<void> {
    await this.put('/properties/' + encodeURIComponent(cfg.propertyId), cfg);
  }

  async upsertRoom(room: RoomRecord): Promise<void> {
    await this.put('/rooms/' + encodeURIComponent(room.roomId), room);
  }

  async upsertDevice(device: DeviceRecord): Promise<void> {
    await this.put('/devices/' + encodeURIComponent(device.deviceId), device);
  }

  /** Admin listing. Optional upstream — an empty result just means fewer details in the UI. */
  async allDevices(): Promise<DeviceRecord[]> {
    try {
      return (await this.get<DeviceRecord[]>('/devices')) ?? [];
    } catch {
      return [];
    }
  }

  private async get<T>(path: string): Promise<T | undefined> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T | undefined;

    const res = await this.fetch('GET', path);
    // 404 is a real answer: this id is not configured.
    if (res.status === 404) {
      this.cache.set(path, { at: Date.now(), value: undefined });
      return undefined;
    }
    if (!res.ok) {
      throw new CatalogUnavailable('catalog GET ' + path + ' returned ' + res.status);
    }

    const value = (await res.json()) as T;
    this.cache.set(path, { at: Date.now(), value });
    return value;
  }

  private async put(path: string, body: unknown): Promise<void> {
    const res = await this.fetch('PUT', path, body);
    if (!res.ok) {
      throw new CatalogUnavailable('catalog PUT ' + path + ' returned ' + res.status);
    }
    // A stale read straight after a write is the one case the TTL must not cover.
    this.cache.clear();
  }

  private async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = 'Bearer ' + this.token;

    try {
      return await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new CatalogUnavailable(method + ' ' + this.baseUrl + path + ' failed: ' + String(err));
    }
  }
}
