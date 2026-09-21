-- Neutralise a local copy of masterdb so it cannot reach a real hotel.
--
-- The room-control tables do not merely describe devices, they address them: every
-- roomAutomationServices row carries the live URL of a customer's head-end plus a
-- working bearer token. Running that copy locally is not isolation - the destination
-- is in the row. This rewrites every endpoint to the in-repo mock and redacts every
-- credential, keeping paths, methods and bodies intact so routing logic still sees
-- the real shape.
--
-- Run against the LOCAL copy only, after every replication:
--   docker exec -i woohoo-db-local psql -U postgres -d masterdb < sanitise-local.sql
--
-- Nothing here is reversible in place; re-replicate to get the originals back.

-- Where the commands should point instead. Override with:
--   psql -v mock=http://localhost:9000 -f sanitise-local.sql
-- 8092 is the catch-all head-end in tools/room-runner; 8091 is mock-honeywell, which
-- speaks INNCOM only and would 404 on the interel, AMX and BACnet paths in this data.
\if :{?mock}
\else
  \set mock 'http://localhost:8092'
\endif

BEGIN;

-- Refuse to run anywhere that looks like production.
DO $$
BEGIN
  IF current_setting('server_version_num')::int > 0
     AND inet_server_addr() IS NOT NULL
     AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1', '172.17.0.1')
     AND current_database() <> 'masterdb'
  THEN
    RAISE EXCEPTION 'refusing to sanitise a non-local database';
  END IF;
END $$;

-- ------------------------------------------------------------------ helpers

-- Swap scheme+host for the mock, keep the path and query. A row with no scheme is
-- treated as a bare path.
CREATE OR REPLACE FUNCTION pg_temp.localise(url text, mock text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN url IS NULL OR btrim(url) = '' THEN url
    WHEN url ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://' THEN
      mock || coalesce(nullif(regexp_replace(url, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', ''), ''), '/')
    WHEN url LIKE '/%' THEN mock || url
    ELSE mock || '/' || url
  END
$$;

-- Keep header and body NAMES (code reads them) but blank anything that looks secret.
CREATE OR REPLACE FUNCTION pg_temp.redact(doc json)
RETURNS json LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN doc IS NULL THEN NULL
    WHEN json_typeof(doc) <> 'object' THEN doc
    ELSE (
      SELECT json_object_agg(
        key,
        CASE
          WHEN key ~* '(auth|token|key|password|secret|credential|bearer|cookie)'
            THEN 'REDACTED-LOCAL'
          ELSE value #>> '{}'
        END)
      FROM json_each(doc)
    )
  END
$$;

-- ------------------------------------------------------------------ keep the address

-- Where each command pointed before this script rewrites it. Without this the copy can no
-- longer answer "what does this actually call in the hotel?". Header NAMES are kept and
-- values are not: a working bearer token on a laptop is what this script exists to remove.
-- Run before the rewrite, and only for rows not already archived, so re-running is safe.
CREATE TABLE IF NOT EXISTS "roomAutomationServiceOrigins" (
  id            integer PRIMARY KEY,
  "apiMethod"   text,
  "apiUrl"      text,
  host          text,
  "headerNames" text[],
  "capturedAt"  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "roomAutomationServiceOrigins" (id, "apiMethod", "apiUrl", host, "headerNames")
SELECT s.id, s."apiMethod", s."apiUrl",
       split_part(split_part(s."apiUrl", '://', 2), '/', 1),
       CASE WHEN s."apiHeaders" IS NULL THEN '{}'::text[]
            ELSE ARRAY(SELECT key FROM json_each(s."apiHeaders")) END
  FROM "roomAutomationServices" s
 WHERE s."apiUrl" IS NOT NULL
   AND s."apiUrl" NOT LIKE :'mock' || '%'
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------ the commands

UPDATE "roomAutomationServices"
   SET "apiUrl"           = pg_temp.localise("apiUrl", :'mock'),
       "apiHeaders"       = pg_temp.redact("apiHeaders"),
       "interelPublicKey" = CASE WHEN "interelPublicKey" IS NULL THEN NULL ELSE 'REDACTED-LOCAL' END
 WHERE "apiUrl" IS NOT NULL
    OR "apiHeaders" IS NOT NULL
    OR "interelPublicKey" IS NOT NULL;

-- ------------------------------------------------------------------ vendor auth

UPDATE "roomAutomationAuths"
   SET "apiUrl"     = pg_temp.localise("apiUrl", :'mock'),
       "apiHeaders" = pg_temp.redact("apiHeaders"),
       "apiBody"    = pg_temp.redact("apiBody");

UPDATE interels
   SET "projectUrl" = pg_temp.localise("projectUrl", :'mock'),
       token        = 'REDACTED-LOCAL',
       "publicKey"  = 'REDACTED-LOCAL';

-- ------------------------------------------------------------------ per-room bindings

-- rooms.services is a json[] of {name, url, token, key}. Only the keys that are
-- already present are rewritten, so the document shape is unchanged.
UPDATE rooms
   SET services = (
     SELECT array_agg(
       (
         CASE WHEN s::jsonb ? 'url'   THEN s::jsonb || jsonb_build_object('url', :'mock' || '/mock') ELSE s::jsonb END
         || CASE WHEN s::jsonb ? 'token' THEN jsonb_build_object('token', 'REDACTED-LOCAL') ELSE '{}'::jsonb END
         || CASE WHEN s::jsonb ? 'key'   THEN jsonb_build_object('key',   'REDACTED-LOCAL') ELSE '{}'::jsonb END
       )::json
       ORDER BY ord)
     FROM unnest(services) WITH ORDINALITY AS u(s, ord)
   )
 WHERE services IS NOT NULL AND array_length(services, 1) > 0;

-- Shiji/Infrasys POS deep link - another live third party.
UPDATE rooms
   SET "infrasysUrl" = pg_temp.localise("infrasysUrl", :'mock')
 WHERE "infrasysUrl" IS NOT NULL AND btrim("infrasysUrl") <> '';

COMMIT;

-- ------------------------------------------------------------------ proof

\echo ''
\echo 'Remaining hosts in roomAutomationServices.apiUrl:'
SELECT split_part(split_part("apiUrl", '://', 2), '/', 1) AS host, count(*) AS commands
  FROM "roomAutomationServices"
 WHERE "apiUrl" IS NOT NULL
 GROUP BY 1 ORDER BY 2 DESC;

\echo 'Rows still carrying a credential (all counts must be 0):'
SELECT 'roomAutomationServices.apiHeaders' AS check, count(*) AS rows
  FROM "roomAutomationServices"
 WHERE "apiHeaders"::text ~* '(bearer |basic )[A-Za-z0-9._-]{16,}'
UNION ALL SELECT 'interels.token', count(*) FROM interels WHERE token <> 'REDACTED-LOCAL'
-- A redacted document still HAS a "password" key, so match the value, not the name.
UNION ALL SELECT 'roomAutomationAuths', count(*) FROM "roomAutomationAuths"
 WHERE "apiHeaders"::text ~* '(bearer |basic )[A-Za-z0-9._-]{16,}'
    OR EXISTS (
         SELECT 1 FROM json_each_text(coalesce("apiBody", '{}'::json)) kv
          WHERE kv.key ~* '(password|secret|token|key|auth)'
            AND kv.value <> 'REDACTED-LOCAL'
       )
UNION ALL SELECT 'rooms.services', count(*) FROM rooms
 WHERE services::text ~* '"token":"(?!REDACTED)';
