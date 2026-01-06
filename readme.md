# ESPNet Server

UDP-based server for managing ESP32 laser tag devices. Built in Rust with Axum for HTTP/WebSocket and Tokio for async UDP networking.

For the client use [ESPNet Client](https://github.com/Daemonide/ESPNet-Client)

For the frontend use [ESPNet Server Frontend](https://github.com/Daemonide/ESPNet-Server-Frontend)

## What is this?

Backend server that coordinates ESP32 devices running custom laser tag software. Handles device discovery, heartbeats, game state management, and provides a REST API + WebSocket interface for the React frontend.

## Features

- **UDP device discovery** - Automatic ESP32 node detection via broadcast
- **Heartbeat monitoring** - Tracks device online/offline status
- **WebSocket broadcasts** - Real-time updates to all connected web clients
- **Team-based laser tag** - Red vs Blue game logic with win conditions
- **Device management** - Remote restart, WiFi reset, callsign assignment
- **Persistent state** - Saves device registry and game state to JSON

## Tech Stack

- Rust (async/await with Tokio)
- Axum (HTTP + WebSocket server)
- UDP networking for ESP32 communication
- JSON file storage for persistence

## Network Protocol

### ESP32 → Server (UDP port 8888)

```
DISCOVER_SERVER              # Device wants to join network
HEARTBEAT|<MAC>|<IP>         # Keep-alive ping (every 4s)
EVENT|TAG|<MAC>              # Laser tag hit detected
```

### Server → ESP32 (UDP port 8889)

```
ESPNet-Server-Online         # Response to discovery
HEARTBEAT_ACK                # Heartbeat acknowledgment
RESTART                      # Reboot the ESP32
WIFI_RESET                   # Clear WiFi credentials and restart
```

## Setup

### Prerequisites

- Rust 1.70+ with Cargo
- All ESP32 devices on same network as server

### Installation

Clone the repo and build:

```bash
cargo build --release
```

### Running

Start the server:

```bash
cargo run --release
```

Server will bind to:
- `0.0.0.0:8080` - HTTP/WebSocket (for React frontend)
- `0.0.0.0:8888` - UDP (for ESP32 communication)

## Project Structure

```
src/
└── main.rs          # Main server logic with UDP + HTTP handlers
persistence.json  # Persistent device registry
```

## API Endpoints

### HTTP REST API

```
POST   /api/assign/:mac/:callsign    # Assign NATO callsign to device
PUT    /api/team/:mac/:team          # Set device team (red/blue/none)
DELETE /api/device/:mac              # Remove device from registry
POST   /api/toggle_tag/:mac          # Manually toggle tag state
POST   /api/reset_game               # Reset entire game
POST   /api/reset_tags               # Clear all tag states
POST   /api/restart/:mac             # Restart specific device
POST   /api/wifi_reset/:mac          # Clear WiFi on device
```

### WebSocket

```
GET /ws                              # WebSocket for real-time updates
```

WebSocket broadcasts device list and game state on every change. Victory messages sent when a team wins.

## Game Logic

### Teams
- Devices can be assigned to `red`, `blue`, or `none` team
- Only devices with teams participate in the game

### Tagging
- When an ESP32 sends `EVENT|TAG|<MAC>`, that device is marked as tagged out
- Win condition: All devices on one team are tagged → other team wins
- Victory broadcasts via WebSocket with `{"type": "victory", "winner": "red"}`

### State Persistence
- Device registry saved to `persistence.json`
- Auto-loads on server restart

## Configuration

To change ports, edit `main.rs`:

```rust
let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;  // HTTP port
let socket = UdpSocket::bind("0.0.0.0:8888").await?;                  // UDP port
```

ESP32 firmware sends to port **8888** and listens on **8889**.

## Device Lifecycle

1. **Discovery** - ESP32 broadcasts `DISCOVER_SERVER` on network
2. **Registration** - Server adds device to registry with MAC address
3. **Heartbeat** - Device sends status every 4 seconds
4. **Online/Offline** - Marked offline if no heartbeat for 15+ seconds
5. **Removal** - Can be deleted via `/api/device/:mac`


