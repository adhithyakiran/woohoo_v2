# Woohoo V2 — session handoff

Paste this at the start of a new session to bring it up to speed.

---

## What this is

An in-room hotel voice assistant ("Alexa for hotels"), migrating from Dialogflow to an
agentic Gemini system. A guest speaks; the platform decides what may happen and drives the
room's automation hardware (Honeywell INNCOM / Interel).

**Repo:** `c:\Users\adhit\Documents\GitHub\woohoo_v2` — TypeScript monorepo, npm workspaces,
ESM, `tsx` (no build step), Zod, vitest. Node 22+.
**Remote:** `gitlab` → https://gitlab.com/adhithyakiran/woohoo_v2_agentic (branch `main`).

## Two principles everything follows

- **P1 — the model proposes, the platform disposes.** The LLM never executes anything. It
  emits tool proposals; a deterministic Policy Decision Point rules on each one.
- **P2 — scope is ambient, never argued.** Tenant/property/room come from the device identity.
  **No tool anywhere takes a room parameter.** Another room is not addressable, so "unlock room
  402" fails structurally rather than by refusal.

## Deployment

AWS EC2, Mumbai. **IP changes on every stop/start** (no Elastic IP) — last seen `13.233.72.62`.

```bash
# tunnel (port 8443 is closed in the security group; SSH is the only way in)
ssh -i cloud_deployment/woohoo-dev.pem -L 8443:localhost:8443 ubuntu@<IP>
# then open http://localhost:8443/

# redeploy from the repo root
tar -czf woohoo.tar.gz package.json package-lock.json tsconfig.json Dockerfile \
  docker-compose.yml .dockerignore packages services tools eval
scp -i cloud_deployment/woohoo-dev.pem woohoo.tar.gz deploy.sh ubuntu@<IP>:/opt/woohoo/
ssh -i cloud_deployment/woohoo-dev.pem ubuntu@<IP> "bash /opt/woohoo/deploy.sh"
```

`deploy.sh` is **gitignored** (holds the live Gemini key), writes `/opt/woohoo/.env`, brings up
`mock-honeywell` + `device-gateway`, waits for health, and fails loudly if the provider is not
Gemini. Always verify the tarball is complete before shipping — a `tar --exclude` once dropped
`services/woohoo-core/src/infra/` and caused `ERR_MODULE_NOT_FOUND` on the server:

```bash
comm -23 <(find packages services tools eval -type f \( -name "*.ts" -o -name "*.json" \) \
  ! -path "*/node_modules/*" | sort) \
  <(tar -tzf woohoo.tar.gz | grep -E "\.(ts|json)$" | sort)   # must print nothing
```

## Run locally

```bash
npm install
npm run gateway                 # http://localhost:8443/ — mock LLM + in-process room sim
npm test                        # 188 tests, 10 files
npm run typecheck

# real model
GEMINI_API_KEY=... npm run gateway

# real HTTP head-end path (two terminals)
npm run mock-honeywell
WOOHOO_ADAPTER=honeywell HONEYWELL_URL=http://localhost:8091 npm run gateway
```

Kill stray local servers on 8443 before opening the SSH tunnel — they silently block it.

## Layout

| Path | What it is |
|---|---|
| `packages/contracts/src/` | `tools.ts` (22 tools, strict Zod), `tiers.ts` (T0–T5), `capabilities.ts`, `adapter.ts`, `config.ts`, `turn-context.ts`. **No tool takes a room/tenant param.** |
| `packages/otel/src/index.ts` | Tracer, `serialiseSpans()`, and the `AsyncLocalStorage` vendor-call log (`withVendorLog` / `recordVendorCall`). |
| `services/policy-service/src/pdp.ts` | The PDP. Deterministic TypeScript, 11 rule families, never reads the prompt. |
| `services/woohoo-core/src/app.ts` | Composition root. Adapter + catalog selection by env. |
| `services/woohoo-core/src/agent/llm.ts` | Gemini provider. `buildContents()`, `wireName()`, retry with one shared deadline. |
| `services/woohoo-core/src/agent/runtime.ts` | The propose → policy → execute loop; accumulates `rounds`. |
| `services/woohoo-core/src/modules/orchestrator.ts` | Owns the turn. Lanes, degradation ladder, output guard, `templatedConfirmation()`. |
| `services/woohoo-core/src/modules/device-state.ts` | Verify-read, circuit breaker, shadow state. |
| `services/woohoo-core/src/modules/guardrails.ts` | Builds the 8-control per-turn guardrail report. |
| `services/woohoo-core/src/modules/provisioning.ts` | Runtime room creation. |
| `services/woohoo-core/src/modules/catalog-http.ts` | Catalog backed by an external service. |
| `services/adapter-honeywell/src/index.ts` | INNCOM adapter over HTTP; records every vendor call. |
| `services/mock-honeywell/src/main.ts` | Fake head-end: object addressing, latency, silent failures, drift. |
| `services/device-gateway/src/index.ts` | HTTP + WebSocket + SSE, CORS, admin routes. |
| `services/device-gateway/src/console.ts` | The whole test console as one `String.raw` literal. |

**Not mine — separate work, present in the tree:** `services/adapter-masterdb/`,
`tools/db-viewer/`, `tools/room-console/`, `tools/room-runner/`, `docs/RUNBOOK-masterdb.md`,
`services/woohoo-core/src/modules/false-confirmation.test.ts`. Ask before touching them.

## Endpoints (`services/device-gateway/src/index.ts`)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/turn` | `{deviceId, transcript, asrConfidence?}`. Field is **`transcript`**, not `text` (400 otherwise). |
| WS | `/` | `hello` → `ready` → `turn` → `ack` → `speak`. Device path. |
| GET | `/v1/events` | SSE. Every turn from every source; `turn.received` then `turn.completed`. |
| GET | `/health` | Reports `provider` and `adapter` — how you tell mock from real. |
| GET/POST | `/v1/admin/rooms` | Provisioning. Needs `x-admin-token`. |
| GET | `/` | Test console. |

CORS is permissive (`*`) — a browser client cannot call this otherwise.

## Env

`GEMINI_API_KEY` · `GEMINI_MODEL` · `GEMINI_TIMEOUT` · `WOOHOO_ADAPTER` (`honeywell` or unset
for the simulator) · `HONEYWELL_URL` · `WOOHOO_ADMIN_TOKEN` (generated + logged if unset) ·
`WOOHOO_CATALOG_URL` (hand rooms to another DB) · `PORT`. Template in `.env.example`.

## Test console (`/`)

Left: transport, device, ASR confidence, utterance, 16 scenario buttons.
Right: live turn feed, then tabs — **Timeline** (stage timings), **Agent** (routing + per-round
tokens/cost), **Tools** (tier, verdict, rule), **Guardrails** (8 controls, what each did),
**Room API** (head-end calls: object, requested vs observed), **Wire**, **Connect** (endpoints +
copyable curl/PowerShell/JS/WS/Kotlin, with an editable target host and a reachability probe),
**Rooms** (provisioning + external-DB contract).

Turns sent from anywhere appear in the feed tagged `external`.

## Bugs found and fixed — read before changing these

Every one of these shipped and was invisible from outside.

1. **Silent head-end failure reported as success.** Guest asked for 25°C, controller
   acknowledged and did nothing, assistant said *"I've set it to 19.5 degrees."* Three defects:
   the simulator returned `applied` when it knowingly skipped the write; the verify-read
   compared the re-read against the **adapter's own observed value** instead of the request
   (both saw the stale value and agreed); the guardrail counted `result.ok`, which is true for a
   pending change. Fixed in `adapter-simulator`, `device-state.ts`, `guardrails.ts`.
2. **Gemini conversation missing the model's own turn.** Tool results were sent as plain user
   text with no `functionCall` part, so the model re-proposed the same calls every round — 3×
   cost, and a closing reply that contradicted what happened. Now `buildContents()` replays
   proper `functionCall`/`functionResponse` pairs.
3. **Fast-lane denial erased.** Escalating to the agentic lane overwrote `calls`, so a PDP
   `DENY` was reported as "no tool calls proposed, nothing required authorisation".
4. **Console double-rendered every turn** — the SSE feed beats the HTTP response, and the
   ownership check assumed the opposite order. Cards are now keyed by `turnId`.
5. **A syntax error in the console** aborted the whole script; page rendered, everything
   dynamic was blank, server healthy. `console.test.ts` now parses every emitted script.
6. **Lossy tool-name round-trip** — `climate.set_temperature` → `climate.set.temperature`.
7. **compose empty-string substitution** produced a 0 ms timeout from an unset variable.

The lesson worth carrying: **every bug came from the seams** — tar excludes, compose variables,
tool-name encoding, timeout budgets, string templates — never from the agent logic. The safety
model held throughout, including while being fed mangled tool names.

## Known gaps

No speech (transcripts arrive as text) · no Android client · MCP semantics implemented but
**not the wire protocol** · **no persistence — all state dies on restart**, including
provisioned rooms · single instance, so one reboot takes every room offline · no auth on
`/v1/turn` · no staff/admin UI · edge gateway not in the actuation path.

## Docs

`docs/architecture/` (98pp PDF) · `docs/api/` · `docs/brief/` · `docs/android/` · `docs/ui/` ·
`docs/mcp/` · `docs/test-plan/` (19pp, 137 tests, 72 blockers) · `docs/DEPLOY-AWS.md` ·
`docs/RUNNING.md`.

## Working agreements

- **Do not push to git or commit** — the user does that themselves.
- Large heredocs get truncated by this shell; write files with the Write tool instead.
- `console.ts` is a `String.raw` literal: a backtick or `${` anywhere inside truncates the page.
  There is a test for it.
- Verify against the running server rather than asserting — the smoke output in `deploy.sh`
  prints the full decision path.
