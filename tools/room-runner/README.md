# room-runner

Fires the room-automation commands that live in the local `masterdb` copy, so "did the
command for room 549 reach the device" is something you watch rather than infer.

```bash
npm run head-end                          # catch-all vendor, port 8092
npm run room -- rooms --property 167      # rooms that have commands
npm run room -- show 2389                 # the catalog for one room
npm run room -- fire 2389 "Master On"     # fire one
npm run room -- test 2389                 # fire everything, summarise
```

## Why this works at all

`roomAutomationServices` is not a description of what a room can do - it *is* the
request. One row per state a device can be put into, carrying `apiMethod`, `apiUrl`,
`apiHeaders` and `apiBody`. Room 2389's "Master On" is literally:

```
PUT /v1/protocols/bacnet/local/objects/79742578/properties/85
{"anyOfValue":[{"isArray":false,"type":"unsigned_integer","value":6}]}
```

So the runner does not translate anything. It reads the row and sends it.

## The catch-all head-end

`mock-honeywell` speaks INNCOM properly, which is right for adapter development and
wrong here: this data addresses four vendors - interel, interel cloud, AMX over AWS
IoT, schneider over BACnet - and would 404 on every one of those paths. `head-end.js`
answers anything, records it, and shapes the reply like the vendor whose path it
matched, so a working integration is distinguishable from a broken one:

| path contains | reply |
| --- | --- |
| `/interelrestapi`, `/roomcontrol` | `{"Result":"Success","ResultCode":0}` |
| `/control/devices` | `{"status":"success","code":200,"data":{…}}` |
| `/bacnet/` | the property document, echoing the written value |
| `/topics` | `{"messageId":"mock-N"}` (AWS IoT publish) |
| `…/token` | `{"access_token":"mock-local-token"}` |

```
GET    localhost:8092/_captured   what arrived, newest first
DELETE localhost:8092/_captured   clear it
HEAD_END_LATENCY_MS=40 HEAD_END_FAILURE_RATE=0   misbehaviour knobs
```

## Safety

Every command is checked before it is sent: if `apiUrl` does not resolve to localhost,
the runner refuses it and says why, without opening a connection.

```
REFUSED GUARD TEST - <a customer head-end> is not local
                     run tools/db-viewer/sql/sanitise-local.sql first
```

This matters because the rows are production data and address production head-ends. A
local database does not isolate you; the destination is in the row. Run the sanitise
script after every replication. `ROOM_RUNNER_ALLOW_REMOTE=yes` overrides the guard -
there is no legitimate reason to set it against this data.

## Connection

Defaults to the local copy (`localhost:5433/masterdb`, user `postgres`). Override with
`TARGET_DB_HOST`, `TARGET_DB_PORT`, `TARGET_DB_NAME`, `TARGET_DB_USER`,
`TARGET_DB_PASSWORD` - the same names [tools/db-viewer](../db-viewer) uses.
