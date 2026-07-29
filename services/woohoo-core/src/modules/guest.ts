import type { Consent, Money, Scope } from '@woohoo/contracts';

/**
 * Guest stay context and preferences — architecture doc §28, §41, §57.
 *
 * Two compliance properties are structural here:
 *  - The stay is TOKENISED. The agent sees "the guest in this room, checking out tomorrow",
 *    never a name, unless personalisation is explicitly enabled and consented (§55.2).
 *  - Stay-scoped data is hard-purged on checkout, which is why stay.checked_out is a
 *    reliability-critical event (§57).
 */

export interface StayRecord {
  /** Opaque token. Never the PMS confirmation number, never the guest's name. */
  stayRef: string;
  tenantId: string;
  propertyId: string;
  roomId: string;
  checkoutAt: string;
  roomTypeLabel: string;
  wifiSsid: string;
  wifiPassword: string;
  language?: string;
  /** Only populated when personalisation consent exists. */
  displayName?: string;
  folioTotal: Money;
}

export type PreferenceKey = 'preferred_temperature_c' | 'preferred_wake_time' | 'dietary_note';

export interface GuestRepository {
  getStay(roomId: string): Promise<StayRecord | undefined>;
  putStay(s: StayRecord): Promise<void>;
  purgeStay(roomId: string): Promise<void>;
  getPreferences(roomId: string): Promise<Partial<Record<PreferenceKey, string>>>;
  setPreference(roomId: string, key: PreferenceKey, value: string): Promise<void>;
  getConsent(roomId: string): Promise<Consent | undefined>;
  setConsent(roomId: string, c: Consent): Promise<void>;
}

export class InMemoryGuestRepository implements GuestRepository {
  private readonly stays = new Map<string, StayRecord>();
  private readonly prefs = new Map<string, Partial<Record<PreferenceKey, string>>>();
  private readonly consent = new Map<string, Consent>();

  async getStay(roomId: string) {
    return this.stays.get(roomId);
  }
  async putStay(s: StayRecord) {
    this.stays.set(s.roomId, s);
  }
  /** Hard delete. This is the mechanism behind the §57 retention schedule, not a soft flag. */
  async purgeStay(roomId: string) {
    this.stays.delete(roomId);
    this.prefs.delete(roomId);
  }
  async getPreferences(roomId: string) {
    return this.prefs.get(roomId) ?? {};
  }
  async setPreference(roomId: string, key: PreferenceKey, value: string) {
    const cur = this.prefs.get(roomId) ?? {};
    cur[key] = value;
    this.prefs.set(roomId, cur);
  }
  async getConsent(roomId: string) {
    return this.consent.get(roomId);
  }
  async setConsent(roomId: string, c: Consent) {
    this.consent.set(roomId, c);
  }
}

/** What the agent is allowed to see about the stay. Deliberately narrower than StayRecord. */
export interface StayView {
  checkoutAt: string;
  roomType: string;
  wifi: { ssid: string; password: string };
  folioTotal: Money;
  /** Present only with personalisation consent. */
  guestName?: string;
}

export class GuestService {
  constructor(private readonly repo: GuestRepository) {}

  async stayView(scope: Scope, consent: Consent): Promise<StayView | undefined> {
    const s = await this.repo.getStay(scope.roomId);
    if (!s) return undefined;
    return {
      checkoutAt: s.checkoutAt,
      roomType: s.roomTypeLabel,
      wifi: { ssid: s.wifiSsid, password: s.wifiPassword },
      folioTotal: s.folioTotal,
      ...(consent.personalisation && s.displayName ? { guestName: s.displayName } : {}),
    };
  }

  async preferences(scope: Scope, consent: Consent) {
    if (!consent.preferences) return {};
    return this.repo.getPreferences(scope.roomId);
  }

  async setPreference(scope: Scope, key: PreferenceKey, value: string): Promise<void> {
    await this.repo.setPreference(scope.roomId, key, value);
  }

  /** Driven by the stay.checked_out event. Losing that event means data outliving its basis. */
  async onCheckout(scope: Scope): Promise<void> {
    await this.repo.purgeStay(scope.roomId);
  }

  async consentFor(scope: Scope): Promise<Consent> {
    return (
      (await this.repo.getConsent(scope.roomId)) ?? {
        voice: true,
        preferences: false,
        personalisation: false,
      }
    );
  }

  getRepository(): GuestRepository {
    return this.repo;
  }
}
