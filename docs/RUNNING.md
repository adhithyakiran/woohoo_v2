# Running Woohoo

Two ways in. Pick by what you actually need.

| You want to… | Use |
|---|---|
| Call the API from your app (Android, web UI, a script) | **A — the shared instance** |
| Change the code, or work offline / without waiting on anyone | **B — run it yourself** |

Both give you the same test console: a browser page showing every turn, what the
agent decided, which guardrails ran, and the calls that reached the room hardware.

---

## A — Use the shared instance

The service runs on an AWS box at `65.1.106.31`, port `8443`.

**That port is closed by default.** You need one of these before anything below works:

1. **An inbound rule** in the instance's AWS security group for TCP 8443, allowing
   your public IP. Ask whoever administers the AWS account. Find your IP at
   <https://ifconfig.me>. It probably changes when your router reconnects, so you may
   need this re-added.
2. **Or an SSH tunnel**, if you have been given SSH access to the box:

   ```bash
   ssh -i woohoo-dev.pem -L 8443:localhost:8443 ubuntu@65.1.106.31
   ```

   Leave that terminal open; the tunnel dies with it. The service is then at
   `http://localhost:8443` **on your machine only**.

### Check it works

```bash
curl http://65.1.106.31:8443/health
```

```json
{ "status": "ok", "provider": "gemini", "model": "gemini-2.5-flash", "adapter": "honeywell-inncom" }
```

No response at all means the port is closed to you — not that the service is down.
Those two look identical from a terminal, which is why the console has a
**Test reachability** button that tells them apart.

### Send a turn

```bash
curl -X POST http://65.1.106.31:8443/v1/turn \
  -H "content-type: application/json" \
  -d '{"deviceId":"d_511a","transcript":"turn on the lights"}'
```

The field is **`transcript`**. Not `text`, not `message` — a wrong name returns 400
and reads like the service is broken.

### Open the console

<http://65.1.106.31:8443/> (or `http://localhost:8443/` if you tunnelled).

Everything you need is in there, and it stays current with the code:

- **Connect** — every endpoint, plus working examples for curl, PowerShell,
  JavaScript, WebSocket, Kotlin/OkHttp. Set **Target host** to the address *you*
  use and they regenerate.
- **Rooms** — which rooms exist, how to add one, how to point the platform at a
  different database.
- **Timeline / Agent / Tools / Guardrails / Room API** — what happened inside any turn.

Turns you send from a terminal show up in the console live, tagged `external`. So
you can run a command and watch someone else's console fill in — useful when
debugging together.

---

## B — Run it yourself

No AWS, no keys, no permissions. About five minutes.

**Requires Node 22 or newer** (`node --version`).

```bash
git clone <repo-url> woohoo_v2
cd woohoo_v2
npm install
npm run gateway
```

Open <http://localhost:8443/>.

That is genuinely all of it. With no API key the agent runs on a deterministic mock
provider — every lane, every policy rule and the full console work, the replies are
just canned rather than generated. Fine for building a client against.

### Optional: the real model

```bash
# macOS / Linux
GEMINI_API_KEY=your-key npm run gateway

# Windows PowerShell
$env:GEMINI_API_KEY="your-key"; npm run gateway
```

The console header shows `LLM: GEMINI` or `LLM: MOCK`, so you always know which you
are looking at. Get a key from <https://aistudio.google.com/apikey> — don't reuse
someone else's.

### Optional: the room hardware simulator

By default the room automation is in-process. To exercise the real HTTP path to a
property controller — the one that has network latency, timeouts and partial
failures — run the mock head-end in a second terminal:

```bash
npm run mock-honeywell
```

then start the gateway pointed at it:

```bash
WOOHOO_ADAPTER=honeywell HONEYWELL_URL=http://localhost:8091 npm run gateway
```

The **Room API** tab then shows the actual calls: which object was addressed, the
value requested, and the value the controller reported afterwards.

To rehearse the failure that matters most — a controller that acknowledges a write
and doesn't perform it — start the mock with `MOCK_SILENT_FAILURE_RATE=1`. The
assistant should say *"I've asked for that — give it a moment"* and never claim
success. If it ever claims success there, that is a serious bug: report it.

### Checks

```bash
npm test          # 157 tests
npm run typecheck
```

---

## Which room to send to

| deviceId | Room | Why it differs |
|---|---|---|
| `d_412a` | 412, Deluxe | No curtains. Ask it to close them — it should say so plainly, not pretend. |
| `d_511a` | 511, Suite | Everything, three zones. |
| `d_512a` | 512, Suite | Curtains fitted but disabled by configuration — a different case from not having them. |

There is **no room parameter anywhere in the API**. The `deviceId` alone decides
which room is acted on. That is deliberate: it means no message and no model output
can ever address a room other than its own.

Adding your own rooms: **Rooms** tab in the console, or `POST /v1/admin/rooms` with
an admin token (printed in the service logs at startup).

---

## What comes back

```jsonc
{
  "speech":      "…",      // what to say to the guest — usually the only field a client needs
  "lane":        "fast",   // fast | agentic | clarify | confirm
  "calls":       [ … ],    // each tool asked for, its risk tier, and the policy verdict
  "guardrails":  [ … ],    // which safety control ran at each stage, and what it did
  "vendorCalls": [ … ],    // the actual room-hardware traffic
  "pipeline":    [ … ],    // per-stage timings, including every model round
  "totalMs":     2149
}
```

A `DENY` in `calls` means the action never reached the room. That is the platform
refusing, not the model deciding — and it is not something a cleverly worded request
can talk its way past.

---

## If something looks wrong

- **No response from the shared instance** — port closed to you, see A.
- **`400 BAD_REQUEST`** — field is `transcript`, not `text`.
- **Replies feel canned** — no API key; header will read `LLM: MOCK`.
- **`404 UNKNOWN_DEVICE`** — that `deviceId` is not provisioned; check the Rooms tab.
- **It claims it did something that did not happen** — stop and report it. That is
  the one failure this system treats as unacceptable, and there are tests specifically
  to prevent it.
