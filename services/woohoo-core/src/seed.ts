import { PropertyConfigSchema, type PropertyConfig } from '@woohoo/contracts';
import type { CatalogRepository } from './modules/catalog.js';
import type { InMemoryFnbRepository } from './modules/fnb.js';
import type { InMemoryGuestRepository } from './modules/guest.js';
import type { InMemoryKnowledgeRepository } from './modules/knowledge.js';

/**
 * Demo property — the fixture the whole Docker-less path runs against.
 *
 * Two room types deliberately differ in capability so that capability filtering (§33) is
 * exercised by default rather than only in a dedicated test: the suite has curtains and
 * scenes, the deluxe does not.
 */

export const DEMO_PROPERTY: PropertyConfig = PropertyConfigSchema.parse({
  propertyId: 'p_blr_whitefield',
  tenantId: 't_demo_apac',
  name: 'Demo Hotel Whitefield',
  cell: 'in',
  timezone: 'Asia/Kolkata',
  languages: ['en-IN', 'hi-IN'],
  defaultLanguage: 'en-IN',
  brand: {
    voiceId: 'mock-voice-en-in',
    tone: 'warm, concise, professional',
    assistantName: 'Voice Genie',
    wakeWordModel: 'hello_voice_genie_v3',
  },
  automation: { vendor: 'simulator', roomRefMapping: 'vendor_room_id' },
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
    crisisHelplineDisplay: '+91-9152987821',
  },
  roomTypes: [
    {
      id: 'rt_deluxe_king',
      count: 180,
      capabilityManifest: {
        version: '3',
        zones: ['bedroom', 'bathroom'],
        capabilities: [
          { capability: 'lighting.on_off', zones: ['bedroom', 'bathroom'] },
          { capability: 'lighting.brightness', zones: ['bedroom'] },
          { capability: 'climate.setpoint', zones: ['bedroom'], minC: 18, maxC: 26 },
          { capability: 'climate.mode', zones: ['bedroom'] },
          { capability: 'dnd' },
          { capability: 'tv.power_volume_input' },
        ],
        scenes: ['sleep', 'welcome', 'work'],
      },
    },
    {
      id: 'rt_suite',
      count: 20,
      capabilityManifest: {
        version: '3',
        zones: ['bedroom', 'living', 'bathroom'],
        capabilities: [
          { capability: 'lighting.on_off', zones: ['bedroom', 'living', 'bathroom'] },
          { capability: 'lighting.brightness', zones: ['bedroom', 'living'] },
          { capability: 'lighting.scene', zones: ['living'] },
          { capability: 'climate.setpoint', zones: ['bedroom', 'living'], minC: 18, maxC: 26 },
          { capability: 'climate.mode', zones: ['bedroom', 'living'] },
          { capability: 'curtains.position', zones: ['bedroom', 'living'] },
          { capability: 'dnd' },
          { capability: 'tv.power_volume_input' },
          { capability: 'media.playback' },
        ],
        scenes: ['sleep', 'welcome', 'work', 'movie'],
      },
    },
  ],
  roomOverrides: [
    { roomRef: 'r_512', disable: ['curtains.position'], reason: 'motor awaiting replacement' },
  ],
  asr: { primary: 'mock', fallback: 'mock' },
  features: {
    fnbOrdering: true,
    geminiLiveChatLane: false,
    crossStayPreferences: false,
    personalisedGreeting: false,
  },
  compliance: {
    controller: 'Demo Hotels Pvt Ltd',
    transcriptRetentionDays: 30,
    noticeVersion: 'in-v2',
  },
});

export const DEMO_ROOMS = [
  { roomId: 'r_412', roomNumber: '412', roomTypeId: 'rt_deluxe_king', vendorRoomId: 'INN-0412' },
  { roomId: 'r_511', roomNumber: '511', roomTypeId: 'rt_suite', vendorRoomId: 'INN-0511' },
  { roomId: 'r_512', roomNumber: '512', roomTypeId: 'rt_suite', vendorRoomId: 'INN-0512' },
];

export const DEMO_DEVICES = [
  { deviceId: 'd_412a', roomId: 'r_412' },
  { deviceId: 'd_511a', roomId: 'r_511' },
  { deviceId: 'd_512a', roomId: 'r_512' },
];

export async function seedDemoProperty(deps: {
  catalogRepo: CatalogRepository;
  fnbRepo?: InMemoryFnbRepository;
  guestRepo?: InMemoryGuestRepository;
  knowledgeRepo?: InMemoryKnowledgeRepository;
}): Promise<void> {
  await deps.catalogRepo.upsertProperty(DEMO_PROPERTY);

  for (const r of DEMO_ROOMS) {
    await deps.catalogRepo.upsertRoom({ ...r, propertyId: DEMO_PROPERTY.propertyId });
  }
  for (const d of DEMO_DEVICES) {
    await deps.catalogRepo.upsertDevice({
      deviceId: d.deviceId,
      tenantId: DEMO_PROPERTY.tenantId,
      propertyId: DEMO_PROPERTY.propertyId,
      roomId: d.roomId,
      boundAt: Date.now(),
      certificateSerial: `cert_${d.deviceId}`,
      revoked: false,
    });
  }

  await deps.fnbRepo?.setMenu(DEMO_PROPERTY.propertyId, [
    {
      id: 'm_club',
      name: 'Club Sandwich',
      description: 'Triple-decker with chicken, egg and bacon.',
      price: { amount: 850, currency: 'INR' },
      category: 'mains',
      available: true,
      keywords: ['sandwich', 'club'],
    },
    {
      id: 'm_dosa',
      name: 'Masala Dosa',
      description: 'Crisp rice crepe with spiced potato, sambar and chutney.',
      price: { amount: 450, currency: 'INR' },
      category: 'mains',
      available: true,
      keywords: ['dosa', 'masala dosa', 'south indian'],
    },
    {
      id: 'm_beer',
      name: 'Kingfisher Premium',
      description: 'Chilled 330ml lager.',
      price: { amount: 390, currency: 'INR' },
      category: 'drinks',
      available: true,
      keywords: ['beer', 'lager', 'kingfisher'],
    },
    {
      id: 'm_caesar',
      name: 'Caesar Salad',
      description: 'Romaine, parmesan, garlic croutons.',
      price: { amount: 620, currency: 'INR' },
      category: 'starters',
      available: false,
      keywords: ['salad', 'caesar'],
    },
  ]);

  for (const room of DEMO_ROOMS) {
    await deps.guestRepo?.putStay({
      stayRef: `stay_tok_${room.roomId}`,
      tenantId: DEMO_PROPERTY.tenantId,
      propertyId: DEMO_PROPERTY.propertyId,
      roomId: room.roomId,
      checkoutAt: '11:00',
      roomTypeLabel: room.roomTypeId === 'rt_suite' ? 'Suite' : 'Deluxe King',
      wifiSsid: 'DemoHotel-Guest',
      wifiPassword: 'welcome2026',
      folioTotal: { amount: 0, currency: 'INR' },
    });
    await deps.guestRepo?.setConsent(room.roomId, {
      voice: true,
      preferences: false,
      personalisation: false,
    });
  }

  const kb = [
    {
      id: 'kb_pool',
      title: 'Swimming pool',
      body: 'The rooftop pool is open from 6am to 9pm daily. Towels are provided at the poolside desk.',
      sourceRef: 'property-handbook#pool',
    },
    {
      id: 'kb_breakfast',
      title: 'Breakfast',
      body: 'Breakfast is served in Terrace Restaurant on level 2 from 6:30am to 10:30am on weekdays and until 11am at weekends.',
      sourceRef: 'property-handbook#fnb',
    },
    {
      id: 'kb_gym',
      title: 'Fitness centre',
      body: 'The gym on level 3 is open 24 hours to in-house guests. Access is with your room key.',
      sourceRef: 'property-handbook#gym',
    },
    {
      id: 'kb_checkout',
      title: 'Checkout',
      body: 'Standard checkout is 11am. Late checkout until 2pm is subject to availability and may be chargeable.',
      sourceRef: 'property-handbook#checkout',
    },
    {
      id: 'kb_airport',
      title: 'Airport transfer',
      body: 'Kempegowda International Airport is about 55 minutes away. The concierge can arrange a car.',
      sourceRef: 'property-handbook#transport',
    },
  ];
  for (const c of kb) {
    await deps.knowledgeRepo?.put({
      ...c,
      propertyId: DEMO_PROPERTY.propertyId,
      updatedAt: Date.now(),
    });
  }
}
