# RoboSoccer — Gameplan

Phased roadmap from where the project stands today to a working 7-node
arena. Phase 2 (server) is **done** as of this rewrite; Phases 1, 3, and 4
are what's left, tracked here as checkable milestones. See `ARCHITECTURE.md`
for how the finished server works.

## Phase 0 — Where things stood before this rewrite

- Reference repo `Daemonide/ESPNet-Server` (Rust): a *different* project
  (laser tag), UDP 8888/8889 + HTTP 8080, flat device model, no tests.
- Status doc's MVP: further along (port 8880, `MatchState`, `/api/goal`
  etc., client-side Web Audio synth) but still missing the 7-node model,
  kicker/EMP routing, pairing, and lighting/Spotify hooks.
- **Gap closed by this rewrite:** the TypeScript server in this repo now
  implements the full PRD v2.0 wire protocol, state model, and referee
  console — see Phase 2 below.

## Phase 1 — Hardware & firmware (C++/Arduino, unchanged track)

This stays outside the TypeScript server; a microcontroller runs firmware,
not Node. Tracked here because the server's wire contract (ARCHITECTURE.md
§3) is what the firmware must speak.

- [ ] Remote battery MOSFET wiring + cut test (3x controllers)
- [ ] Truck 3D-printed kicker servo mount + actuation range tuning
- [ ] WS2812B lighting strip driver on the lighting ESP32
- [ ] **Controller firmware** (×3): read kicker/EMP buttons → send
      `EVENT|KICK_REQ` / `EVENT|EMP_REQ`; listen for `CMD|SET_LED`; drive the
      MOSFET gate on `CMD|POWER_CUT`; send `HEARTBEAT` every 2s with
      `nodeType=controller` and its physical team label
- [ ] **Truck firmware** (×3): listen for `CMD|KICK_FIRE`, drive servo;
      `HEARTBEAT` every 2s with `nodeType=truck`
- [ ] **Lighting firmware** (×1): listen for `CMD|LIGHT_FX|pattern[|rgb]`,
      drive the WS2812B strip per the pattern table in ARCHITECTURE.md §5;
      `HEARTBEAT` every 2s with `nodeType=lighting`
- [ ] Confirm all 3 firmware images respond to `DISCOVER_SERVER` with a
      `HEARTBEAT` shortly after boot (validates the reconnect path in
      ARCHITECTURE.md §7 against real hardware, not just the simulated UDP
      smoke test used to validate the server side)

## Phase 2 — Server (this repo) — ✅ done

- [x] Project scaffold: TypeScript/Node, ESM, `tsx`/`tsc`, `vitest`
- [x] `DeviceNode`/`MatchState` types mirroring the PRD's structs
- [x] Atomic + debounced JSON persistence (`devices.json`, `matches.json`)
- [x] Device registry: MAC-keyed, online/offline sweep, pairing,
      seed-only heartbeat fields (never clobbers a referee override)
- [x] Match clock: 15-min countdown, consecutive-goal tracking, intense-mode
      condition, start/pause/resume/reset/±time/undo
- [x] UDP layer: discovery reply + periodic broadcast, heartbeat ingest,
      total/never-throws message parsing
- [x] Power-up engine: kicker cooldown+pairing+online checks, EMP
      eligibility+target+already-frozen checks, both unit tested
- [x] Ambiance engine: goal/intense/EMP/match-end → audio + light event
      fan-out, dispatched over both WebSocket (dashboard) and UDP (lighting
      rig)
- [x] Spotify client: OAuth flow + duck/resume, safe no-op when unconfigured
- [x] REST API + WebSocket hub (full endpoint list in ARCHITECTURE.md §5)
- [x] Referee/spectator dashboard: fleet health grid, scoreboard + timer
      controls, pairing matrix, match history, client-side Web Audio synth
- [x] Unit tests for the power-up rules and match-state transitions (23
      passing)
- [x] Smoke-tested end-to-end: simulated UDP discovery/heartbeat, REST
      pairing/match/goal/kick flows, verified in the dashboard live

**Remaining server polish** (not blocking Phase 1/3, pick up opportunistically):

- [ ] Multi-level goal undo (currently single-level by design; revisit if
      referees want a deeper history)
- [ ] Optional `CMD|ACK|<id>` if firmware ever wants tighter delivery
      confirmation than the current best-effort retry (ARCHITECTURE.md §3)
- [ ] RSSI reporting (PRD mentions it in the fleet health grid; not in the
      current heartbeat dictionary — would need a firmware-side addition)
- [ ] Packaging: `npm run build` + a process manager (pm2/systemd) or a
      Node single-executable-application build for arena-day deployment,
      matching the original's "single binary" delivery ethos

## Phase 3 — Dashboard, lighting & Spotify polish

- [ ] Wire the lighting pattern table (IDLE/WARMUP/GOAL_RED/GOAL_BLUE/
      INTENSE/EMP_FLASH/WINNER_*) end-to-end once Phase 1's lighting
      firmware exists — the server already dispatches `CMD|LIGHT_FX`, this
      is validating the visual result against PRD §4.2
- [ ] Spotify: register a Spotify app, set `SPOTIFY_CLIENT_ID/SECRET` in
      `.env`, complete the `/auth/spotify/login` flow once against a real
      account, confirm duck-on-goal/resume-after-4s in practice
- [ ] Dashboard: drag-and-drop pairing (currently dropdown-based — functional
      but PRD §6 suggested drag-and-drop as a nice-to-have)
- [ ] Dashboard: RSSI display once Phase 1 firmware reports it

## Phase 4 — Full arena integration & acceptance testing

Acceptance criteria straight from PRD §8, to be verified against real
hardware once Phase 1 is complete (the server-side logic behind each is
already built and unit tested):

- [ ] **Power-up roundtrip latency** < 100ms: button press → server
      validation → truck servo / opponent power-cut, over local 2.4GHz WiFi
- [ ] **Fail-safe reliability**: pull power on a controller mid-EMP,
      confirm the MOSFET's Normally-Closed default restores human control
      immediately (see ARCHITECTURE.md §7 for why the server doesn't fight
      this)
- [ ] **Audio-visual sync** within 50ms of goal registration (dashboard
      Web Audio synth + `CMD|LIGHT_FX` to the lighting rig)
- [ ] Full 7-node integration test: all 3 controllers + 3 trucks + 1
      lighting rig online simultaneously, paired, through a complete match
      including at least one kicker fire, one EMP, one intense-mode window,
      and a clean match end with history recorded
- [ ] Reboot-resilience drill: power-cycle a controller and a truck
      mid-match, confirm the dashboard shows the correct brief-offline →
      online transition and gameplay is unaffected (validates
      ARCHITECTURE.md §7 against real hardware, not just simulated UDP)
