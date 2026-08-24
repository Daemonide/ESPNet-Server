# RoboSoccer Server — Architecture

How the central laptop server works: topology, ports, the UDP wire protocol,
state models, the HTTP/WebSocket API, and the two power-up sequences end to
end. This is the TypeScript rewrite of the arena server described in
`PRD.pdf` / `STATUS AND TO DO.pdf`. The original Rust implementation this
project evolved from (a different, earlier laser-tag project) lives on the
[`legacy`](../../tree/legacy) branch.

## 1. Topology

```
                         ┌─────────────────────────────────────────┐
                         │           Laptop Server (Node)           │
                         │                                           │
   UDP 8888 (listen) ───►│  net/udp.ts   ── DeviceRegistry           │
   UDP 8889 (unicast)◄───│               ── MatchStateManager        │──► HTTP 8880
   UDP 8889 (broadcast)◄─│               ── game/powerups.ts         │    (REST + WS
     "discovery, 2s"     │               ── game/ambiance.ts         │     + static
                         │               ── audio/spotify.ts (opt.)  │     dashboard)
                         └─────────────────────────────────────────┘
                                   ▲        ▲        ▲        ▲
                                   │        │        │        │
                        ┌──────────┘   ┌────┘   ┌────┘   ┌────┘
                  Controller 1    Controller 2  Controller 3  Truck 1/2/3
                  (Red, ESP32)    (Blue, ESP32) (P3, ESP32)   (ESP32)
                  Kicker+EMP btn                                Servo kicker
                                                              Lighting Rig
                                                              (ESP32, WS2812B)
```

7 ESP32 nodes total: 3 controllers, 3 trucks, 1 lighting rig. Controllers and
trucks never talk to each other directly — every action (kick, EMP) is
requested from a controller, validated by the server, and only then
dispatched to the paired/target hardware. The server is the single source of
truth for game state, pairing, and power-up eligibility.

## 2. Ports & timing

| Thing | Value | Where |
|---|---|---|
| HTTP + WebSocket (dashboard, REST, `/ws`) | `8880` | `src/http/server.ts` |
| UDP server listen (all ESP32 → server traffic) | `8888` | `src/net/udp.ts` |
| UDP server → ESP32 (unicast reply/cmd) | sender IP : `8889` | `src/net/udp.ts` |
| Discovery broadcast | `255.255.255.255:8889`, every 2s | `src/net/udp.ts` |
| Heartbeat interval (firmware-side) | every 2s | PRD §2.1 |
| Offline threshold | no heartbeat for 6s → `isOnline=false` | `config.offlineThresholdMs` |
| Kicker cooldown | 15s | `config.kickerCooldownMs` |
| EMP power-cut duration | 3000ms | `config.empDurationMs` |
| Intense-mode threshold | ≤45s remaining, tied score | `config.intenseThresholdMs` |
| Match duration | 15 minutes | `config.matchDurationMs` |

All of the above are env-overridable — see `.env.example`.

## 3. UDP message dictionary

Plain pipe-delimited ASCII text (not JSON) — matches the ESP32 firmware's
existing parsing style and keeps packets tiny. Parsing lives in
`src/net/messages.ts` and is total: a malformed/truncated/garbled packet
always becomes `{ kind: 'unknown' }`, it never throws. See §7 for why that
matters.

| Message | Direction | Description |
|---|---|---|
| `DISCOVER_SERVER` | ESP32 → Server | Device wants to join the network |
| `ESPNet-Server-Online` | Server → ESP32 | Discovery reply / periodic presence broadcast |
| `HEARTBEAT\|mac\|ip\|batt\|nodeType\|team` | ESP32 → Server | Liveness ping every 2s. `batt`/`nodeType`/`team` are optional — a bare `HEARTBEAT\|mac\|ip` still works |
| `EVENT\|KICK_REQ\|mac` | Controller → Server | Player pressed the kicker button |
| `EVENT\|EMP_REQ\|mac\|targetTeam` | Controller → Server | Player pressed the EMP button |
| `CMD\|KICK_FIRE` | Server → Truck | Actuate the kicker servo (0°→90°→0°) |
| `CMD\|POWER_CUT\|ms` | Server → Target controller | Pull the MOSFET gate low for `ms` |
| `CMD\|SET_LED\|ON\|OFF\|BLINK` | Server → Controller | Power-up ready indicator LED |
| `CMD\|LIGHT_FX\|pattern[\|rgbHex]` | Server → Lighting node | Arena LED animation |

**Note on `HEARTBEAT`'s `team` field:** the PRD has the device self-report
its team, but §6 also says the referee assigns team/pairing from the
dashboard. The registry resolves this by only letting a heartbeat *seed* an
unset `team`/`nodeType` — a REST-assigned value always wins and is never
overwritten by a later heartbeat. See §7.

**Known limitation — no delivery ACK.** UDP is fire-and-forget; nothing in
the dictionary confirms a `CMD` was received. The server mitigates this with
one short-delay resend (`UdpFleet.sendWithRetry`, ~120ms later) for
`KICK_FIRE`/`POWER_CUT`, which is safe to duplicate (see §7). If tighter
delivery confirmation is ever needed, a natural extension is
`CMD|ACK|<original>` echoed back by firmware — not implemented here since no
firmware currently sends it.

## 4. State models

```ts
// src/types.ts
interface DeviceNode {
  mac: string; ip: string;
  nodeType: 'controller' | 'truck' | 'lighting' | null;
  team: 'red' | 'blue' | null;
  pairedMac: string | null;       // controller <-> truck link
  isOnline: boolean; lastSeen: number; firstSeen: number;
  batteryPct: number | null; label: string | null;
  kickerCooldownUntil: number | null;
  powerupEmpReady: boolean;       // unlocked by match rules, consumed on use
  powerCutUntil: number | null;   // set while this controller is EMP'd
}

interface MatchState {
  matchId: string; playerRedName: string; playerBlueName: string;
  scoreRed: number; scoreBlue: number;
  timeRemainingMs: number; matchDurationMs: number;
  matchActive: boolean; isPaused: boolean; isIntenseMode: boolean;
  consecutiveGoalsRed: number; consecutiveGoalsBlue: number;
  winner: 'red' | 'blue' | 'draw' | null;
  startedAt: number | null; endedAt: number | null;
}
```

Both are held in memory (`DeviceRegistry`, `MatchStateManager`) and persisted
to `data/devices.json` / `data/matches.json` via `JsonStore` — atomic
(tmp-file + rename) and debounced, so a crash mid-write can't corrupt the
file and a burst of events doesn't hammer the disk.

EMP eligibility (`computeEmpEligibility` in `state/matchState.ts`) is a pure
function of `MatchState`: a team unlocks EMP on **2 consecutive goals** or
**trailing by 2+** (PRD §3.2). Once unlocked it stays ready until consumed —
it is not revoked if the score changes back before it's used (a deliberate
simplification; arcade power-ups that could vanish mid-turn would feel
unfair).

Intense mode (`computeIntenseMode`) is `matchActive && !isPaused &&
timeRemainingMs <= 45000 && scoreRed === scoreBlue` — recomputed on every
tick, goal, and manual time adjustment, not just once a second, so a referee
override reflects instantly rather than up to 1s later.

## 5. HTTP + WebSocket API

All REST bodies are JSON, validated with `zod` (bad input → `400`, never a
crash). WebSocket clients connect to `/ws` and receive a `state` snapshot on
every registry/match change, plus discrete `audio_event` / `light_event`
messages the dashboard's Web Audio synth reacts to.

| Method & path | Purpose |
|---|---|
| `GET /api/status` | Server health: device/online counts, WS client count |
| `GET /api/devices` | Full fleet list |
| `PUT /api/devices/:mac/team` `{team}` | Referee-assign team (`red\|blue\|null`) |
| `PUT /api/devices/:mac/node-type` `{nodeType}` | Manually set/correct node type |
| `PUT /api/devices/:mac/label` `{label}` | Friendly name, e.g. "Controller 1 (Red)" |
| `DELETE /api/devices/:mac` | Remove from registry |
| `POST /api/pairing` `{controllerMac, truckMac}` | Link a controller to its truck |
| `DELETE /api/pairing/:mac` | Unpair |
| `GET /api/match/state` | `{devices, match}` — same shape as the WS `state` event |
| `GET /api/match/history` | Completed-match ledger |
| `POST /api/match/start` `{playerRedName?, playerBlueName?}` | New match, clock running |
| `POST /api/match/pause` / `/resume` | Timer control |
| `POST /api/match/reset` | Abandon match, zero everything |
| `POST /api/match/time` `{deltaMs}` | Referee ±1M (or any delta) |
| `POST /api/match/goal` `{team}` | Register a goal |
| `POST /api/match/undo` | Reverse the most recent goal (single-level) |
| `POST /api/powerups/kick` `{mac}` | Trigger the same validated path as `EVENT\|KICK_REQ` (referee override / no-hardware testing) |
| `POST /api/powerups/emp` `{mac, targetTeam}` | Same, for EMP |
| `GET /auth/spotify/login` / `GET /auth/spotify/callback` | Spotify OAuth (no-op if unconfigured) |

WebSocket event shapes (`src/types.ts::ServerEvent`):

```ts
{ type: 'state'; devices: DeviceNode[]; match: MatchState }
{ type: 'audio_event'; event: 'goal_red' | 'goal_blue' | 'kick_fired' | 'emp_fired'
                              | 'intense_start' | 'intense_end' | 'match_start' | 'match_end' | 'warmup' }
{ type: 'light_event'; pattern: 'IDLE'|'WARMUP'|'GOAL_RED'|'GOAL_BLUE'|'INTENSE'|'EMP_FLASH'|'WINNER_RED'|'WINNER_BLUE'|'WINNER_DRAW'; rgbHex?: string }
{ type: 'powerup_rejected'; action: 'kick'|'emp'; mac: string; reason: string }
{ type: 'history'; entries: MatchHistoryEntry[] }
```

## 6. Sequence walkthroughs

### Kicker (PRD §3.1)

```
Player A → Controller A: presses kicker button
Controller A → Server:    UDP  EVENT|KICK_REQ|<macA>
Server:                   evaluateKick(controller, pairedTruck, now)
                             - off cooldown?  - paired?  - truck online?
  [rejected] Server → WS:  powerup_rejected {reason}         (no hardware command sent)
  [ok]       Server:       set kickerCooldownUntil = now + 15s
             Server → Truck:  UDP  CMD|KICK_FIRE   (sent twice, ~120ms apart)
             Truck:            actuate servo 0° → 90° → 0°
             Server → WS:      audio_event { event: 'kick_fired' }
```

### Opponent EMP power-cut (PRD §3.2)

```
Player A → Controller A: presses EMP button (LED is green = ready)
Controller A → Server:    UDP  EVENT|EMP_REQ|<macA>|<targetTeam>
Server:                   evaluateEmp(controller, targetController, now)
                             - powerupEmpReady?  - target online?  - not already frozen?
  [rejected] Server → WS:  powerup_rejected {reason}
  [ok]       Server:       powerupEmpReady = false (consumed)
             Server:       powerCutUntil = now + 3000ms
             Server → Target: UDP  CMD|POWER_CUT|3000   (sent twice)
             Target ESP32:     pull MOSFET gate low for 3000ms (hardware defaults
                                Normally Closed, so a reboot mid-cut just restores
                                power early — see §7, this is not a bug)
             Server (+3050ms): clear powerCutUntil if nothing re-armed it
             Server → WS:      audio_event {'emp_fired'}, light_event {'EMP_FLASH'}
             Server → Lighting: UDP CMD|LIGHT_FX|EMP_FLASH
```

## 7. Fault tolerance: ESP32 restarts

ESP32 nodes will brown out, crash, or get power-cycled mid-match — normal
for battery-powered RC hardware — and none of it should require special
handling from a referee.

- **Identity is MAC-keyed, never IP-keyed.** A reboot means a fresh DHCP
  lease (new IP) and a fresh `DISCOVER_SERVER → HEARTBEAT` bootstrap, but
  the registry key (MAC) is stable, so the device reappears as the *same*
  row, not a duplicate.
- **Heartbeat-reported `team`/`nodeType` only seed a null field, never
  overwrite a set one.** Otherwise a referee's manual team reassignment
  would silently revert on the device's very next heartbeat, two seconds
  later — see §3.
- **Server-side flags survive device memory loss.** Cooldowns, pairing, and
  power-up ready flags live only in `DeviceRegistry`, never trusted from the
  device. A rebooted controller has no memory of its own cooldown state and
  doesn't need any.
- **Offline detection tolerates a normal boot cycle.** The 6s threshold (3
  missed 2s heartbeats) is wider than a typical ~2-5s ESP32 boot + WiFi
  reconnect, so a routine reboot just shows briefly offline (accurate) and
  flips back with no registry churn.
- **In-flight commands during a reboot are best-effort, not silently
  swallowed.** `evaluateKick`/`evaluateEmp` check `isOnline` before
  dispatch and reject with a visible reason rather than firing blind; the
  one-retry send absorbs a single dropped packet. Re-sending `KICK_FIRE` is
  a harmless no-op if the servo already fired; re-sending `POWER_CUT|3000`
  just restarts the same 3s window — neither is a safety issue.
- **A power-cut interrupted by the target's own reboot is expected, not a
  bug.** The MOSFET is hardware-wired Normally Closed, so a rebooting
  controller regains passthrough power regardless of the server's
  `powerCutUntil` bookkeeping. The server doesn't fight this; it just
  doesn't let a stale timestamp block a *future* legitimate EMP.
- **Persistence never treats a reboot gap as data loss.** Devices load from
  `devices.json` at boot with `isOnline` forced `false` and flip back on
  their first heartbeat; pairing, team, and match history are untouched by
  any individual node's reboot.

## 8. What changed vs. the Rust reference, and why

`Daemonide/ESPNet-Server` is a different, earlier project (laser tag) but
shares the UDP discovery/heartbeat lifecycle and the general shape this
server reuses. Deliberate departures:

| Rust original | This server | Why |
|---|---|---|
| `.unwrap()` on every `RwLock` access | No panics on bad state — `Map` access is synchronous/single-threaded in Node, no lock needed at all | A poisoned lock in the original takes the whole process down; Node's single-threaded event loop removes the failure mode entirely |
| `String::split('|')` indexed per-branch, ad hoc length checks | Centralized `parseInbound`, always returns a typed result, never throws | One place to get UDP parsing right instead of N ad hoc branches |
| Synchronous `fs::write` on every event, while holding the lock | Debounced + atomic (tmp+rename) `JsonStore` | Removes both the corruption risk (crash mid-write) and the I/O-under-lock stall |
| Blocking stdin reader spawned inside the async runtime for a terminal UI | Removed — the web dashboard is the only console | The blocking read is unrelated to arena logic and doesn't belong in the request path |
| Flat `team` + `tagged_out: bool` device model | Full `DeviceNode` (nodeType, pairing, cooldowns, EMP state) per PRD v2.0 | RoboSoccer's 7-node topology and two power-ups need it |
| No tests | `vitest` unit tests for the power-up rules and match-state transitions | These are exactly the places an off-by-one (cooldown boundary, intense-mode boundary) would slip through unnoticed |

## 9. File map

```
src/
  config.ts              env-driven ports/timings
  types.ts                DeviceNode, MatchState, message/event shapes
  engine.ts                composition root: wires registry+match+udp+ws+spotify
  persistence/store.ts     atomic + debounced JSON file store
  state/deviceRegistry.ts  fleet registry, MAC-keyed, online sweep, pairing
  state/matchState.ts      score/clock/intense-mode/EMP-eligibility, 1s tick
  net/messages.ts          UDP dictionary parse/encode (total, never throws)
  net/udp.ts               dgram socket, discovery, dispatch, retry-send
  game/powerups.ts         pure kick/EMP eligibility rules (unit tested)
  game/ambiance.ts         goal/intense/EMP/match-end → audio+light event mapping
  audio/spotify.ts         OAuth + duck/resume/play, safe no-op if unconfigured
  http/server.ts           Express app, static dashboard, route mounting
  http/ws.ts               WebSocket broadcast hub
  http/routes/*.ts         REST endpoints
public/                    dashboard (no build step): index.html, app.js, style.css
test/                      vitest unit tests
data/                      gitignored runtime JSON persistence
```

## 10. Firmware (not in this repo)

The 3 ESP32 firmware images (Controller, Truck, Lighting — PRD §"C") stay in
C++/Arduino/PlatformIO; a microcontroller can't run Node. This server only
defines and validates the wire contract in §3 — see `GAMEPLAN.md` for the
firmware track.
