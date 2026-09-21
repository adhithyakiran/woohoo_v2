# Running the V1 room-automation bridge

How to drive a real production room - its rooms, its devices, its commands - entirely on
this machine, without a request ever leaving it.

## Once, per machine

```bash
npm install
docker desktop start                      # Docker must be running
cp tools/db-viewer/.env.example tools/db-viewer/.env   # then fill in SOURCE_DB_*
```

## Every time

Two long-running processes. Leave each in its own terminal.

```bash
# 1 - the fake head-end every command is pointed at (port 8092)
npm run head-end

# 2 - only when you want to browse or re-replicate the database (port 4180)
npm run db-viewer
```

The local Postgres runs in Docker as `woohoo-db-local` on port 5433 with
`--restart unless-stopped`, so it comes back on its own once Docker is up. Check it:

```bash
docker ps --filter name=woohoo-db-local
```

## The app - gateway test console

The product itself, with the full decision path of every turn.

```bash
WOOHOO_ADAPTER=masterdb WOOHOO_SEED_PROPERTY=167 npm run gateway
#   PowerShell: $env:WOOHOO_ADAPTER="masterdb"; $env:WOOHOO_SEED_PROPERTY="167"; npm run gateway
```

Open **http://localhost:8443**. The Device/room dropdown lists whatever property the
gateway loaded - pick room 549, type an utterance, press Send. Tabs show the timeline,
what the agent proposed, what policy allowed, and what reached the room.

The header says `LLM: MOCK` until a key is present:

```bash
GEMINI_API_KEY=... WOOHOO_ADAPTER=masterdb WOOHOO_SEED_PROPERTY=167 npm run gateway
```

`GOOGLE_API_KEY` works too. Without one the deterministic mock provider runs, which is
enough to exercise routing, policy and the adapter - but not the agent's own reasoning.

## Drive a room from the terminal

```bash
export WOOHOO_ADAPTER=masterdb WOOHOO_SEED_PROPERTY=167   # Windows: set them inline

npm run turn -- --device d_8bf3edc84290edc3 "turn on the lights"
npm run turn -- --device d_8bf3edc84290edc3 --trace "set it to 21 degrees"
npm run turn -- --device d_8c44cbab8fe582a4 "do not disturb"
npm run turn                                              # REPL, keeps session state
```

Property 167's devices:

| device | room | no. | vendor | note |
| --- | --- | --- | --- | --- |
| `d_8bf3edc84290edc3` | 2389 | 549 | schneider / BACnet | fully wired, use this one |
| `d_8c44cbab8fe582a4` | 3073 | 566 | interel cloud | curtains, DnD, scenes |
| `d_6bc98adb9e0bc40b` | 3401 | 101 | interel | **8 of 10 commands hit a ping endpoint** |
| `d_12c4a96f9b5e6914` | 3403 | 103 | interel | **9 of 10 commands hit a ping endpoint** |

## Room console - the same rooms with buttons

```bash
npm run room-console     # http://127.0.0.1:4181
```

Pick a room, press a capability, watch the request leave. Two views: **Capabilities**
(what the agent can ask for) and **Raw commands** (the V1 rows, fired as stored).

See what actually arrived:

```bash
curl -s localhost:8092/_captured | jq '.requests[0]'
curl -s -X DELETE localhost:8092/_captured      # clear between runs
```

## Inspect without a turn

```bash
npm run capability -- report --property 167              # what mapped, what did not
npm run capability -- import --property 167              # the V2 catalogue it produces
npm run capability -- conformance 2389                   # is this room fit to serve a guest
npm run capability -- apply 2389 lighting.on_off --zone bedroom --value true
npm run capability -- apply 2389 climate.setpoint --value 21

npm run room -- rooms --property 167                     # raw V1 commands, no capabilities
npm run room -- show 2389
npm run room -- test 2389                                # fire all of them
```

## Refresh the data from production

Browse and replicate at http://127.0.0.1:4180 (`npm run db-viewer`). Pick **None** in the
table picker, then these 18:

```
domains  propertyDetails  rooms  hubs  roomAutomationServices  roomAutomationAuths
interels  propertyDeviceMappings  users  groupUserHubMappings  locales  userTypes
features  groups  propertyServices  sipConfigures  TVActions  TVRoomMappings
```

**Then immediately:**

```bash
docker exec -i woohoo-db-local psql -U postgres -d masterdb < tools/db-viewer/sql/sanitise-local.sql
```

This is not optional. A fresh copy carries live hotel URLs and working bearer tokens; a
local database does not isolate you, because the destination is inside the row. Both the
adapter and the runner refuse non-localhost URLs, but the sanitise is what makes the data
safe rather than the guard.

Verify:

```bash
docker exec -i woohoo-db-local psql -U postgres -d masterdb \
  -c 'select split_part(split_part("apiUrl", $$://$$, 2), $$/$$, 1) as host, count(*)
        from "roomAutomationServices" group by 1;'
# expect: localhost:8092 | 14312
```

## Checks

```bash
npm test           # 188
npm run typecheck
```

## What you are looking at

- `"I've asked for that - give it a moment."` - correct. The adapter returns `pending`,
  never `applied`, because no row in the catalogue can read a device back. A confident
  "Done." would be a false confirmation.
- `NOT_AVAILABLE - room 3401 has no command for lighting.on_off in bedroom` - correct.
  That room has only a room-wide Master, no per-zone lights.
- `0 requests` at the head-end after a successful-looking turn - a bug. Say so.

## If nothing happens

| symptom | cause |
| --- | --- |
| `ECONNREFUSED ::1:5433` | Docker or the container is down - `docker desktop start` |
| every command `rejected - refusing to send to …` | sanitise never ran |
| turn succeeds, head-end silent | `npm run head-end` is not running |
| `no property 167 in masterdb` | the replication did not include `propertyDetails` |
