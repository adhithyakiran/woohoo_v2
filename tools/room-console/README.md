# room-console

The imported V1 rooms, with buttons. `http://127.0.0.1:4181`

```bash
npm run head-end       # port 8092 - must be running, it receives the commands
npm run room-console   # port 4181
```

Two views of one room, deliberately side by side:

- **Capabilities** - what the *agent* can ask for, after translation. Pressing a button
  runs the same path a guest utterance takes: capability → `MasterDbAdapter` → the room's
  own stored request. If it works here it works in a turn.
- **Raw commands** - the V1 rows underneath, fired exactly as stored. For when a
  capability is missing and you need to know whether the row exists at all.

The right-hand panel shows what actually crossed the wire - method, URL, body, reply,
timing - so the console never has to be taken on trust.

Rows whose URL is a health check are marked **PING - controls nothing**. Room 101 is 8 of
10 that way, which is a production config bug rather than anything about this tool.

## Safety

A command whose URL is not localhost is refused before a connection opens, by both this
server and the adapter. Run
[sanitise-local.sql](../db-viewer/sql/sanitise-local.sql) after every replication.

## Connection

`TARGET_DB_*` for the database (defaults to the local copy on 5433), `HEAD_END_URL` for
where commands go (defaults to `http://localhost:8092`), `ROOM_CONSOLE_PORT` for this
server.
