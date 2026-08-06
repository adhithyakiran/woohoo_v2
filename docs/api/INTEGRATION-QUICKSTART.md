# Woohoo V2 — Integration Quickstart

Copy-paste starting points for sending a transcript to the Woohoo service and handling the reply.

**Everything below runs against a local service with no API key, no database and no internet:**

```bash
npm install
npm run gateway     # WebSocket + HTTP on :8443
```

Test devices are seeded automatically: `d_412a` (room 412, Deluxe), `d_511a` (room 511, Suite),
`d_512a` (room 512, Suite with a disabled capability).

---

## Which surface do I use?

| You are building | Use | Why |
|---|---|---|
| **The in-room Android device** | **WebSocket** | Persistent connection, server push, and the `ack` that makes it feel instant |
| A web console, test harness, or guest-facing chat | **`POST /v1/turn`** | Request/response, trivial to call, identical behaviour |
| **Staff / admin screens** | *Nothing exists yet* | See the last section |

Both surfaces run the **identical** pipeline, so behaviour cannot differ between them.

---

## 1. Android — Kotlin + OkHttp

OkHttp is already in your `build.gradle`, so there is no new dependency.

```kotlin
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class WoohooClient(
    private val deviceId: String,
    private val url: String = "wss://gateway.example.com:8443",
    private val onAck:    (String) -> Unit,   // play immediately from the phrase pack
    private val onSpeak:  (String) -> Unit,   // synthesise + play
    private val onScreen: (String) -> Unit,   // render on the display
    private val onError:  (String, String) -> Unit,
) {
    private val http = OkHttpClient.Builder()
        // Keep the socket alive. Hotel Wi-Fi drops connections without a close frame.
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var ws: WebSocket? = null
    private var retries = 0

    fun connect() {
        val req = Request.Builder().url(url).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                retries = 0
                // hello MUST be the first frame. Anything else gets NOT_AUTHENTICATED.
                webSocket.send(
                    JSONObject()
                        .put("type", "hello")
                        .put("deviceId", deviceId)
                        .put("firmware", BuildConfig.VERSION_NAME)
                        .toString()
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = JSONObject(text)
                when (msg.getString("type")) {
                    "ready"  -> { /* msg.room, msg.property, msg.assistantName */ }
                    // ack arrives BEFORE the answer — play it the moment it lands.
                    "ack"    -> onAck(msg.getString("filledPause"))
                    "speak"  -> onSpeak(msg.getString("text"))
                    "screen" -> onScreen(msg.getString("text"))
                    "error"  -> onError(msg.getString("code"), msg.getString("detail"))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, r: Response?) {
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }
        })
    }

    /**
     * Call this with whatever your speech recogniser produced.
     * Pass the REAL confidence: below 0.6 the service asks the guest to repeat
     * instead of guessing at an action. Hardcoding it makes us guess when we shouldn't.
     */
    fun sendTurn(transcript: String, asrConfidence: Double) {
        ws?.send(
            JSONObject()
                .put("type", "turn")
                .put("transcript", transcript)
                .put("asrConfidence", asrConfidence)
                .toString()
        )
    }

    fun sendBargeIn() {
        ws?.send(JSONObject().put("type", "barge_in").toString())
    }

    /**
     * Exponential backoff with FULL jitter, capped at 60s.
     * The jitter is mandatory: without it, a property-wide Wi-Fi blip becomes a
     * synchronised reconnect storm from 300 devices and you cause your own outage.
     */
    private fun scheduleReconnect() {
        val capMs = minOf(1000L shl minOf(retries, 6), 60_000L)
        retries++
        val delay = (Math.random() * capMs).toLong()
        Handler(Looper.getMainLooper()).postDelayed({ connect() }, delay)
    }
}
```

### Wiring it to your existing pipeline

You do **not** need to change speech recognition yet. Keep Sensory for the wake word, keep the
existing Google STT call, and only change where the resulting text goes:

```kotlin
// was: send transcript to Dialogflow
// now:
woohoo.sendTurn(transcript, confidence)
```

### The three mistakes to avoid

1. **One connection, kept open.** Not one per turn. A TLS handshake per turn adds 200–400 ms to
   every single interaction, against a total budget of about 1.1 s.
2. **Play `ack` immediately.** It arrives before the real answer. That is what makes the device
   feel responsive while the agent is still working. Ignoring it makes a fast system feel slow.
3. **Send the real ASR confidence**, not a constant.

---

## 2. Web / test console — `POST /v1/turn`

```js
async function sendTurn(deviceId, transcript, asrConfidence = 0.95) {
  const res = await fetch('http://localhost:8443/v1/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, transcript, asrConfidence }),
  });
  return res.json();
}

const r = await sendTurn('d_511a', 'close the curtains and make it warmer');
console.log(r.speech);   // "Curtains closed. I've set it to 22.5 degrees."
```

Response:

```json
{
  "turnId": "turn_ms6e6b0a0",
  "speech": "Curtains closed. I've set it to 22.5 degrees.",
  "screen": null,
  "lane": "agentic",
  "escalated": false,
  "awaitingConfirmation": false,
  "degradationLevel": 0,
  "totalMs": 52,
  "calls": [
    { "tool": "curtains.set",            "tier": "T1", "verdict": "ALLOW", "ok": true },
    { "tool": "climate.set_temperature", "tier": "T1", "verdict": "ALLOW", "ok": true }
  ]
}
```

### Reading the response

| Field | What to do with it |
|---|---|
| `speech` | Show it / speak it. This is the answer. |
| `screen` | Render if present — it carries things audio can't, like an order total or an emergency number |
| `awaitingConfirmation` | **Treat as a modal state.** Something chargeable is frozen; the next turn must be "yes" or "no" |
| `escalated` | A human was paged. Surface it prominently |
| `calls[].verdict` | `ALLOW` \| `DENY` \| `CONFIRM` \| `ESCALATE`. A `DENY` is a normal outcome, not an error |
| `calls[].ok` | Authorised and *executed*. A call can be `ALLOW` but `ok: false` if the room system failed |

### Status codes

`200` for every completed turn, **including policy refusals**. `400` bad body, `404` unknown
device, `413` body over 16 KB, `500` internal fault.

### The two-turn confirmation flow

Anything that costs money takes two turns. Do not auto-confirm.

```js
let r = await sendTurn('d_412a', "I'd like a club sandwich and a beer");
// r.awaitingConfirmation === true
// r.speech === "I have 2 items ready to order. That's 1240 INR, charged to your
//               room. Shall I place it?"

r = await sendTurn('d_412a', 'yes');
// r.lane === 'confirm'
// r.speech === "Ordered — about 30 minutes. 1240 INR has gone to your room bill."
```

Saying "no", or letting it lapse past 90 seconds, discards it and charges nothing.

---

## 3. Things worth testing against

| Say this | What it demonstrates |
|---|---|
| `turn on the lights` | Fast path, ~30 ms, no AI call |
| `it's freezing in here` | Reads current state (19.5 °C) and decides 22.5 °C |
| `it's too cold and fix the shower` | Two intents in one sentence |
| `set the temperature to 35 degrees` | Policy refusal, `R6.out_of_bounds` |
| `close the curtains` on `d_412a` vs `d_511a` | Same words, different rooms, different outcomes |
| `who is staying in room 402` | Cross-guest refusal |
| `I'm having chest pain` | Escalation with emergency wording, `escalated: true` |

---

## 4. Staff / admin UI — read this before planning

**There is no API for you yet.** The two routes above are the entire HTTP surface and both are
device-facing. There is no authentication and no staff endpoint of any kind.

The logic exists and is tested — listing and assigning service requests, acknowledging
escalations, searching what the assistant did and why, property and room admin, capability kill
switches — but none of it is reachable over HTTP.

**If you are building a guest-facing surface** (a web chat, an in-room tablet UI, a demo console),
use `POST /v1/turn` today. It works and it is the same pipeline the device uses.

**If you are building staff or admin screens**, they are blocked on roughly a week of work, and it
needs two decisions first:

1. **REST or GraphQL?**
2. **Which identity provider** for staff login — Cognito, Auth0, Google Workspace, or something
   already in use?

If your sprint has already started, an OpenAPI spec can be produced first so you can mock against
the contract while the implementation lands behind it.

---

## Reference

- **Full protocol reference** — `docs/api/Woohoo-V2-API-Reference.pdf` (26 pages), written to be
  handed to an integrator directly.
- **Why it is designed this way** — `docs/architecture/Woohoo-V2-Agentic-Architecture.pdf`.
- **Presenting it** — `docs/brief/Woohoo-V2-Team-Briefing.pdf`.
