# adapter-masterdb

An `AutomationAdapter` over the V1 `roomAutomationServices` catalogue, so a V2 turn can
drive a room that was provisioned by V1.

```bash
npm run capability -- report --property 167
npm run capability -- apply 2389 lighting.on_off --zone bedroom --value true
npm run capability -- conformance 2389
```

## What it is

The other adapters speak a protocol. This one speaks a **table**. `roomAutomationServices`
holds, per room, the literal HTTP request for every state a device can be put into - for
whichever of interel / interel cloud / AMX / schneider / tis that property runs. One
adapter therefore covers every V1 property, and the vendor vocabulary still stops at this
file, as §39.1 requires.

The whole job is a dictionary between two vocabularies that have never met:

```
agent:  { capability: 'lighting.on_off', zone: 'bedroom', value: true }
                              ↓  mapping.ts
row 34: PUT /v1/protocols/bacnet/local/objects/79742578/properties/85
        {"anyOfValue":[{"isArray":false,"type":"unsigned_integer","value":6}]}
```

## How the mapping is derived

Per property is not an option - 2,610 rooms is not a thing anyone will type out - so the
rules read the row's own columns:

| signal | becomes |
| --- | --- |
| `stateType` `temperature` | `climate.setpoint`, value taken from the operation |
| `stateType` `fanmode` + `stateValue` | `climate.mode` low/medium/high |
| `itemName` Bedroom / Bathroom / Entrance / Foyer / Livingroom | `lighting.on_off` + that zone |
| `itemName` Master | `lighting.on_off` with **no** zone - the whole room |
| `itemName` Night / Reading | `lighting.scene` - `night` and `night_off`, because the vendor's "off" is a second scene, not a negation |
| `itemName` DnD / Curtains / …Tv | `dnd` / `curtains.open_close` / `tv.power_volume_input` |
| `stateValue` `true`/`false`, else "On"/"Off"/"Activate" in `stateName` | the boolean |

Setpoint rows store `{"value":"{{temperature}}"}`; `renderBody` fills the placeholder at
call time.

Anything the rules cannot work out is **reported, never guessed** - a wrong guess here
puts a command in the wrong room, the exact failure §39.2 is about.

## What it deliberately will not do

`readRoomState` reports every capability as `available: false`, and a successful write
returns `pending`, never `applied`.

That is not laziness. Not one row in all 14,312 reads a device's state - the catalogue is
100% writes - so the only state available is `currentState`, a string in Postgres saying
what was last *sent*. Returning that as an observation would manufacture precisely the
false confirmation the architecture exists to prevent. When vendor read endpoints are
added to the catalogue, `readRoomState` is the seam that already fits.

## Conformance

`conformanceSuite()` asks whether a room is fit to serve a guest, not whether a light
turns on - nothing here can answer that:

1. **every command maps to a capability** - anything unmapped is invisible to the agent
2. **commands address a device rather than a health check** - catches rooms whose commands
   point at `/v1/ping` and control nothing
3. **state can be read back** - fails for every room today, by design, until read
   endpoints exist

## Safety

`localOnly` defaults to **on**: any command whose URL is not localhost is rejected before
a connection opens. The rows are production data addressing production head-ends. Run
[sanitise-local.sql](../../tools/db-viewer/sql/sanitise-local.sql) after every replication.
