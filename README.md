# RoboSoccer Server

Central laptop server for the RoboSoccer arena — a TypeScript rewrite of the
`ESPNet-Server` lineage, built to the PRD v2.0 spec (7 ESP32 nodes: 3
controllers, 3 trucks, 1 lighting rig; kicker + EMP power-ups; referee
dashboard; Spotify ambiance).

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for how it works (ports, wire
protocol, state models, API reference, ESP32-restart handling) and
**[GAMEPLAN.md](./GAMEPLAN.md)** for the full phased roadmap.

> The original Rust/laser-tag implementation this project evolved from has
> moved to the [`legacy`](../../tree/legacy) branch.

## Quick start

```bash
npm install
cp .env.example .env   # defaults work out of the box; Spotify is optional
npm run dev             # tsx watch — server on :8880 (HTTP/WS) and :8888 (UDP)
```

Open `http://localhost:8880` for the referee/spectator dashboard.

```bash
npm test    # vitest — power-up rules + match-state transitions
npm run build && npm start   # compiled production run
```

## Requirements

- Node.js 20+
- All ESP32 nodes on the same local network/subnet as the laptop (UDP
  broadcast discovery relies on this)

## Configuration

All tunables (ports, cooldowns, match duration, intense-mode threshold,
Spotify credentials) are environment variables — see `.env.example` for the
full list and defaults.

## No hardware yet?

The power-up and match-flow logic can be exercised entirely without ESP32s:

- `POST /api/powerups/kick` / `/api/powerups/emp` run the exact same
  validated engine path a real `EVENT|KICK_REQ`/`EVENT|EMP_REQ` UDP packet
  would.
- Any UDP client can simulate a device, e.g.:
  ```bash
  # simulate a controller heartbeat
  echo -n "HEARTBEAT|AA:BB:CC:DD:EE:01|127.0.0.1|91|controller|red" | nc -u -w0 localhost 8888
  ```
