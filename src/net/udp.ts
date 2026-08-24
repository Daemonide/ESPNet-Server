import dgram from "node:dgram";
import { config } from "../config.js";
import type { DeviceRegistry } from "../state/deviceRegistry.js";
import { encodeServerOnline, parseInbound } from "./messages.js";
import type { Team } from "../types.js";

export interface UdpFleetHandlers {
  onKickRequest(mac: string): void;
  onEmpRequest(mac: string, targetTeam: Team): void;
}

/**
 * Single UDP socket for the whole fleet: listens on `config.udpPort` for
 * everything ESP32s send, and unicasts replies/commands back to the sender's
 * IP on `config.espPort` (mirrors the reference Rust server's port split).
 *
 * Malformed packets are logged and dropped, never thrown — see
 * `messages.ts` for why that matters for a UDP listener that has to survive
 * a whole arena's worth of flaky microcontrollers.
 */
export class UdpFleet {
  private socket: dgram.Socket;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly handlers: UdpFleetHandlers,
  ) {
    this.socket = dgram.createSocket("udp4");
  }

  async start(): Promise<void> {
    this.socket.on("message", (buf, rinfo) => this.handleMessage(buf, rinfo));
    this.socket.on("error", (err) => {
      console.error(`[udp] socket error: ${err.message}`);
    });

    await new Promise<void>((resolve) => {
      this.socket.bind(config.udpPort, "0.0.0.0", () => {
        this.socket.setBroadcast(true);
        resolve();
      });
    });
    console.log(`[udp] listening on 0.0.0.0:${config.udpPort}`);

    this.discoveryTimer = setInterval(() => this.broadcastDiscovery(), config.discoveryBroadcastIntervalMs);
    this.broadcastDiscovery();
  }

  private handleMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    const msg = parseInbound(buf.toString("utf-8"));

    switch (msg.kind) {
      case "discover":
        this.sendTo(rinfo.address, encodeServerOnline());
        break;
      case "heartbeat":
        this.registry.upsertFromHeartbeat(msg);
        break;
      case "kick_req":
        this.handlers.onKickRequest(msg.mac);
        break;
      case "emp_req":
        this.handlers.onEmpRequest(msg.mac, msg.targetTeam);
        break;
      case "unknown":
        console.warn(`[udp] unrecognized packet from ${rinfo.address}: ${msg.raw.slice(0, 64)}`);
        break;
    }
  }

  /** Unicast a command/reply to a device's ESP_PORT. Fire-and-forget (UDP has no delivery guarantee). */
  sendTo(ip: string, message: string): void {
    const payload = Buffer.from(message, "utf-8");
    this.socket.send(payload, config.espPort, ip, (err) => {
      if (err) console.error(`[udp] send to ${ip}:${config.espPort} failed: ${err.message}`);
    });
  }

  /**
   * Send a command with one short-delay retry to absorb a single dropped
   * packet (e.g. sent the instant a target ESP32 rebooted). The dictionary
   * has no ACK, so this is best-effort by design — see ARCHITECTURE.md.
   */
  sendWithRetry(ip: string, message: string, retryDelayMs = 120): void {
    this.sendTo(ip, message);
    setTimeout(() => this.sendTo(ip, message), retryDelayMs);
  }

  private broadcastDiscovery(): void {
    const payload = Buffer.from(encodeServerOnline(), "utf-8");
    this.socket.send(payload, config.espPort, "255.255.255.255", (err) => {
      if (err) console.error(`[udp] discovery broadcast failed: ${err.message}`);
    });
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }
}
