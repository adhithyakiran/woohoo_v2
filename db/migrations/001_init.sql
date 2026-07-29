-- Woohoo V2 — initial schema (architecture doc §35, §36, §53).
--
-- Row-level security is applied on every tenant-scoped table. It is a BACKSTOP, not the primary
-- control: the primary control is that every query goes through a repository that carries the
-- tenant. RLS is what saves you the day someone writes a query that forgets (§53).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenancy & catalogue

CREATE TABLE tenant (
  tenant_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cell          TEXT NOT NULL DEFAULT 'in',
  kms_key_arn   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE property (
  property_id   TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenant(tenant_id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  default_language TEXT NOT NULL,
  -- Whole PropertyConfig document; the authored artefact from Appendix C.
  config        JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX property_tenant_idx ON property(tenant_id);

CREATE TABLE room_type (
  room_type_id  TEXT NOT NULL,
  property_id   TEXT NOT NULL REFERENCES property(property_id) ON DELETE CASCADE,
  -- Manifest attaches to ROOM TYPE, not room. Eight per property is a day's work;
  -- three hundred is a project (§35).
  manifest      JSONB NOT NULL,
  manifest_version TEXT NOT NULL,
  PRIMARY KEY (property_id, room_type_id)
);

CREATE TABLE room (
  room_id       TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES property(property_id) ON DELETE CASCADE,
  room_number   TEXT NOT NULL,
  room_type_id  TEXT NOT NULL,
  -- The vendor's own reference. NOT the hotel room number (§39.2) — assuming they match
  -- is a classic onboarding bug that surfaces as actions landing in the wrong room.
  vendor_room_id TEXT NOT NULL,
  disabled_capabilities TEXT[] NOT NULL DEFAULT '{}',
  FOREIGN KEY (property_id, room_type_id) REFERENCES room_type(property_id, room_type_id)
);
CREATE UNIQUE INDEX room_property_number_idx ON room(property_id, room_number);
CREATE INDEX room_vendor_idx ON room(property_id, vendor_room_id);

-- The voice device is a SEPARATE entity from the room, bound revocably and re-verifiably.
-- Collapsing them is the V1 shortcut that makes a relocated device an invisible bug (§22, §35).
CREATE TABLE device (
  device_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenant(tenant_id),
  property_id   TEXT NOT NULL REFERENCES property(property_id),
  room_id       TEXT NOT NULL REFERENCES room(room_id),
  certificate_serial TEXT NOT NULL UNIQUE,
  bound_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  binding_verified_at TIMESTAMPTZ,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  firmware      TEXT
);
CREATE INDEX device_room_idx ON device(room_id);
CREATE INDEX device_binding_stale_idx ON device(binding_verified_at NULLS FIRST);

-- ---------------------------------------------------------------- operations

CREATE TABLE service_request (
  request_id    TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  category      TEXT NOT NULL,
  subcategory   TEXT,
  description   TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'open',
  deferred      BOOLEAN NOT NULL DEFAULT false,
  dispatch_at   TEXT,
  sla_due_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sr_open_idx ON service_request(room_id, status) WHERE status NOT IN ('completed','cancelled');
CREATE INDEX sr_sla_idx ON service_request(sla_due_at) WHERE status = 'open';

CREATE TABLE fnb_menu_item (
  menu_item_id  TEXT NOT NULL,
  property_id   TEXT NOT NULL REFERENCES property(property_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  keywords      TEXT[] NOT NULL DEFAULT '{}',
  price_amount  NUMERIC(12,2) NOT NULL,
  price_currency TEXT NOT NULL,
  category      TEXT NOT NULL,
  available     BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (property_id, menu_item_id)
);

CREATE TABLE fnb_order (
  order_id      TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  items         JSONB NOT NULL,
  total_amount  NUMERIC(12,2) NOT NULL,
  total_currency TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'placed',
  folio_ref     TEXT,
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fnb_order_room_idx ON fnb_order(room_id);

-- ---------------------------------------------------------------- guest data (most sensitive)
-- Separate schema and, in AWS, a per-tenant CMK so erasure and key destruction are surgical (§57).

CREATE SCHEMA guest_data;

CREATE TABLE guest_data.stay (
  stay_ref      TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  checkout_at   TEXT NOT NULL,
  room_type_label TEXT NOT NULL,
  wifi_ssid     TEXT,
  wifi_password TEXT,
  -- Populated only with personalisation consent (§55.2).
  display_name  TEXT,
  folio_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  folio_currency TEXT NOT NULL DEFAULT 'INR',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stay_room_idx ON guest_data.stay(room_id);

CREATE TABLE guest_data.consent (
  room_id       TEXT PRIMARY KEY,
  voice         BOOLEAN NOT NULL DEFAULT true,
  preferences   BOOLEAN NOT NULL DEFAULT false,
  personalisation BOOLEAN NOT NULL DEFAULT false,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notice_version TEXT
);

CREATE TABLE guest_data.preference (
  room_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, key)
);

-- ---------------------------------------------------------------- knowledge

CREATE TABLE knowledge_chunk (
  chunk_id      TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES property(property_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kb_property_idx ON knowledge_chunk(property_id);
-- pgvector is introduced only if the corpus outgrows keyword retrieval (§36):
--   CREATE EXTENSION vector; ALTER TABLE knowledge_chunk ADD COLUMN embedding vector(768);

-- ---------------------------------------------------------------- audit

-- Append-only. In AWS the durable copy is S3 with Object Lock in compliance mode, which is what
-- makes "immutable" a technical claim rather than a policy claim (§36, D18).
CREATE TABLE turn_record (
  turn_id       TEXT PRIMARY KEY,
  trace_id      TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  lane          TEXT NOT NULL,
  language      TEXT NOT NULL,
  degradation_level INT NOT NULL DEFAULT 0,
  transcript_redacted TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  prompt_version TEXT,
  model         TEXT,
  reasoning_summary TEXT,
  tool_calls    JSONB NOT NULL DEFAULT '[]',
  response_text TEXT,
  outcome       TEXT NOT NULL,
  escalated     BOOLEAN NOT NULL DEFAULT false,
  total_ms      INT,
  cost_usd      NUMERIC(12,6),
  started_at    TIMESTAMPTZ NOT NULL,
  sealed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX turn_room_time_idx ON turn_record(room_id, started_at DESC);
CREATE INDEX turn_property_time_idx ON turn_record(property_id, started_at DESC);
CREATE INDEX turn_escalated_idx ON turn_record(property_id, started_at DESC) WHERE escalated;

REVOKE UPDATE, DELETE ON turn_record FROM PUBLIC;

CREATE TABLE escalation (
  escalation_id TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL,
  summary       TEXT NOT NULL,
  notified      TEXT[] NOT NULL DEFAULT '{}',
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  requires_ack_within_s INT NOT NULL
);
-- The thing to alarm on: an escalation nobody acknowledged (§67).
CREATE INDEX escalation_unacked_idx ON escalation(raised_at) WHERE acknowledged_at IS NULL;

-- ---------------------------------------------------------------- row-level security

ALTER TABLE property         ENABLE ROW LEVEL SECURITY;
ALTER TABLE room             ENABLE ROW LEVEL SECURITY;
ALTER TABLE device           ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fnb_order        ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_record      ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation       ENABLE ROW LEVEL SECURITY;

-- app.tenant_id is set per connection/transaction by the repository layer.
CREATE POLICY tenant_isolation ON property
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON device
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON service_request
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON fnb_order
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON turn_record
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON escalation
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON room
  USING (property_id IN (SELECT property_id FROM property));
