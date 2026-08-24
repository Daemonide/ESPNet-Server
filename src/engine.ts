import { config } from "./config.js";
import { DeviceRegistry } from "./state/deviceRegistry.js";
import { MatchStateManager, computeEmpEligibility } from "./state/matchState.js";
import { UdpFleet } from "./net/udp.js";
import { WsHub } from "./http/ws.js";
import { SpotifyClient } from "./audio/spotify.js";
import { evaluateKick, evaluateEmp } from "./game/powerups.js";
import {
  goalAmbiance,
  intenseAmbiance,
  empAmbiance,
  matchEndAmbiance,
  matchStartAmbiance,
} from "./game/ambiance.js";
import { encodeKickFire, encodePowerCut, encodeLightFx } from "./net/messages.js";
import type { Server as HttpServer } from "node:http";
import type { Team } from "./types.js";

/**
 * Composition root: wires the device registry, match clock, UDP fleet,
 * WebSocket hub and Spotify client together. Kept as one place so the data
 * flow (UDP event -> game rule -> UDP command + WS broadcast) is legible
 * from a single file instead of scattered across handler callbacks.
 */
export class Engine {
  readonly registry = new DeviceRegistry();
  readonly spotify = new SpotifyClient();
  readonly match: MatchStateManager;
  udp!: UdpFleet;
  ws!: WsHub;

  constructor() {
    this.match = new MatchStateManager({
      onGoal: (team) => this.handleGoalAmbiance(team),
      onIntenseChange: (isIntense) => this.handleIntenseChange(isIntense),
      onMatchEnd: () => this.handleMatchEnd(),
      onChange: () => this.broadcastState(),
    });
  }

  async init(httpServer: HttpServer): Promise<void> {
    await this.registry.init();
    await this.match.init();
    await this.spotify.init();

    this.registry.onChange(() => this.broadcastState());

    this.udp = new UdpFleet(this.registry, {
      onKickRequest: (mac) => this.handleKickRequest(mac),
      onEmpRequest: (mac, team) => this.handleEmpRequest(mac, team),
    });
    await this.udp.start();

    this.ws = new WsHub(httpServer);

    // Periodic offline sweep — independent of heartbeat cadence so a node
    // that stops mid-stream (crash, not a clean disconnect) still ages out.
    setInterval(() => this.registry.sweepOffline(), 2000);
  }

  broadcastState(): void {
    this.ws.broadcast({ type: "state", devices: this.registry.list(), match: this.match.get() });
  }

  // --- Power-ups ---------------------------------------------------------

  handleKickRequest(controllerMac: string): void {
    const controller = this.registry.get(controllerMac);
    const truck = controller?.pairedMac ? this.registry.get(controller.pairedMac) : undefined;
    const result = evaluateKick(controller, truck, Date.now());

    if (!result.ok) {
      console.warn(`[powerup] kick rejected for ${controllerMac}: ${result.reason}`);
      this.ws.broadcast({ type: "powerup_rejected", action: "kick", mac: controllerMac, reason: result.reason });
      return;
    }

    this.registry.setKickerCooldown(controllerMac, Date.now() + config.kickerCooldownMs);
    const truckDevice = this.registry.get(result.truckMac);
    if (truckDevice) this.udp.sendWithRetry(truckDevice.ip, encodeKickFire());

    this.ws.broadcast({ type: "audio_event", event: "kick_fired" });
  }

  handleEmpRequest(controllerMac: string, targetTeam: Team): void {
    const controller = this.registry.get(controllerMac);
    const target = this.registry
      .list()
      .find((d) => d.nodeType === "controller" && d.team === targetTeam);
    const result = evaluateEmp(controller, target, Date.now());

    if (!result.ok) {
      console.warn(`[powerup] emp rejected for ${controllerMac}: ${result.reason}`);
      this.ws.broadcast({ type: "powerup_rejected", action: "emp", mac: controllerMac, reason: result.reason });
      return;
    }

    this.registry.setEmpReady(controllerMac, false); // consumed on use
    const until = Date.now() + config.empDurationMs;
    this.registry.setPowerCutUntil(result.targetMac, until);

    const targetDevice = this.registry.get(result.targetMac);
    if (targetDevice) this.udp.sendWithRetry(targetDevice.ip, encodePowerCut(config.empDurationMs));

    setTimeout(() => {
      // Only clear if nothing re-armed it in the meantime (idempotent).
      const dev = this.registry.get(result.targetMac);
      if (dev?.powerCutUntil === until) this.registry.setPowerCutUntil(result.targetMac, null);
    }, config.empDurationMs + 50);

    const { audio, light } = empAmbiance();
    this.ws.broadcast({ type: "audio_event", event: audio });
    this.ws.broadcast({ type: "light_event", ...light });
    this.dispatchLightFx(light.pattern);
  }

  // --- Ambiance ------------------------------------------------------------

  private handleGoalAmbiance(team: Team): void {
    const eligibility = computeEmpEligibility(this.match.get());
    for (const controller of this.registry.list()) {
      if (controller.nodeType !== "controller" || !controller.team) continue;
      if (eligibility[controller.team]) this.registry.setEmpReady(controller.mac, true);
    }

    const { audio, light } = goalAmbiance(team);
    void this.spotify.duck();
    this.ws.broadcast({ type: "audio_event", event: audio });
    this.ws.broadcast({ type: "light_event", ...light });
    this.dispatchLightFx(light.pattern);
    setTimeout(() => void this.spotify.resume(), 4000);
  }

  private handleIntenseChange(isIntense: boolean): void {
    const { audio, light } = intenseAmbiance(isIntense);
    this.ws.broadcast({ type: "audio_event", event: audio });
    this.ws.broadcast({ type: "light_event", ...light });
    this.dispatchLightFx(light.pattern);
  }

  private handleMatchEnd(): void {
    const { audio, light } = matchEndAmbiance(this.match.get());
    this.ws.broadcast({ type: "audio_event", event: audio });
    this.ws.broadcast({ type: "light_event", ...light });
    this.dispatchLightFx(light.pattern);
    this.ws.broadcast({ type: "history", entries: this.match.getHistory() });
  }

  announceMatchStart(): void {
    const { audio, light } = matchStartAmbiance();
    this.ws.broadcast({ type: "audio_event", event: audio });
    this.dispatchLightFx(light.pattern);
  }

  private dispatchLightFx(pattern: string): void {
    const lighting = this.registry.list().find((d) => d.nodeType === "lighting");
    if (lighting?.isOnline) {
      this.udp.sendTo(lighting.ip, encodeLightFx(pattern));
    }
  }

  async shutdown(): Promise<void> {
    await this.udp.stop();
    await this.registry.flush();
    await this.match.flush();
  }
}
