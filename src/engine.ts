import { config } from "./config.js";

import { DeviceRegistry } from "./state/deviceRegistry.js";

import {
  MatchStateManager,
  computeEmpEligibility,
} from "./state/matchState.js";

import { PlayerRegistry } from "./state/playerRegistry.js";
import { QueueRegistry } from "./state/queueRegistry.js";
import { SettingsRegistry } from "./state/settingsRegistry.js";

import { UdpFleet } from "./net/udp.js";
import { WsHub } from "./http/ws.js";
import { SpotifyClient } from "./audio/spotify.js";

import {
  evaluateKick,
  evaluateEmp,
} from "./game/powerups.js";

import {
  goalAmbiance,
  intenseAmbiance,
  empAmbiance,
  matchEndAmbiance,
  matchStartAmbiance,
} from "./game/ambiance.js";

import {
  encodeKickFire,
  encodePowerCut,
  encodeLightFx,
} from "./net/messages.js";

import type { Server as HttpServer } from "node:http";
import type { Team } from "./types.js";

export class Engine {
  // -------------------------------------------------------------------------
  // Core state
  // -------------------------------------------------------------------------

  readonly registry = new DeviceRegistry();

  readonly players = new PlayerRegistry();

  readonly queue = new QueueRegistry();

  readonly settings = new SettingsRegistry();

  readonly spotify = new SpotifyClient();

  readonly match: MatchStateManager;

  // -------------------------------------------------------------------------
  // Network services
  // -------------------------------------------------------------------------

  udp!: UdpFleet;
  ws!: WsHub;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor() {
    this.match = new MatchStateManager(
      {
        onGoal: (team) => {
          this.handleGoalAmbiance(team);
        },

        onIntenseChange: (isIntense) => {
          this.handleIntenseChange(isIntense);
        },

        onMatchEnd: () => {
          this.handleMatchEnd();
        },

        onChange: () => {
          this.broadcastState();
        },
      },

      this.settings,
    );
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async init(httpServer: HttpServer): Promise<void> {
    // Device registry
    await this.registry.init();

    // Player registry
    await this.players.init();

    // Queue registry
    await this.queue.init();

    // Settings registry
    await this.settings.init();

    // Match state
    await this.match.init();

    // Spotify
    await this.spotify.init();

    this.registry.onChange(() => {
      this.broadcastState();
    });

    // -----------------------------------------------------------------------
    // UDP fleet
    // -----------------------------------------------------------------------

    this.udp = new UdpFleet(this.registry, {
      onKickRequest: (mac) => {
        this.handleKickRequest(mac);
      },

      onEmpRequest: (mac, team) => {
        this.handleEmpRequest(mac, team);
      },
    });

    await this.udp.start();

    // -----------------------------------------------------------------------
    // WebSocket
    // -----------------------------------------------------------------------

    this.ws = new WsHub(httpServer);

    // -----------------------------------------------------------------------
    // Offline device sweep
    // -----------------------------------------------------------------------

    setInterval(() => {
      this.registry.sweepOffline();
    }, 2000);
  }

  // -------------------------------------------------------------------------
  // Dashboard state
  // -------------------------------------------------------------------------

  broadcastState(): void {
    if (!this.ws) {
      return;
    }

    this.ws.broadcast({
      type: "state",
      devices: this.registry.list(),
      match: this.match.get(),
    });
  }

  // -------------------------------------------------------------------------
  // Power-ups
  // -------------------------------------------------------------------------

  handleKickRequest(
    controllerMac: string,
  ): void {
    const controller =
      this.registry.get(controllerMac);

    const truck =
      controller?.pairedMac
        ? this.registry.get(controller.pairedMac)
        : undefined;

    const result = evaluateKick(
      controller,
      truck,
      Date.now(),
    );

    if (!result.ok) {
      console.warn(
        `[powerup] kick rejected for ${controllerMac}: ${result.reason}`,
      );

      if (this.ws) {
        this.ws.broadcast({
          type: "powerup_rejected",
          action: "kick",
          mac: controllerMac,
          reason: result.reason,
        });
      }

      return;
    }

    this.registry.setKickerCooldown(
      controllerMac,
      Date.now() + config.kickerCooldownMs,
    );

    const truckDevice =
      this.registry.get(result.truckMac);

    if (truckDevice) {
      this.udp.sendWithRetry(
        truckDevice.ip,
        encodeKickFire(),
      );
    }

    if (this.ws) {
      this.ws.broadcast({
        type: "audio_event",
        event: "kick_fired",
      });
    }
  }

  handleEmpRequest(
    controllerMac: string,
    targetTeam: Team,
  ): void {
    const controller =
      this.registry.get(controllerMac);

    const target =
      this.registry
        .list()
        .find(
          (d) =>
            d.nodeType === "controller" &&
            d.team === targetTeam,
        );

    const result = evaluateEmp(
      controller,
      target,
      Date.now(),
    );

    if (!result.ok) {
      console.warn(
        `[powerup] emp rejected for ${controllerMac}: ${result.reason}`,
      );

      if (this.ws) {
        this.ws.broadcast({
          type: "powerup_rejected",
          action: "emp",
          mac: controllerMac,
          reason: result.reason,
        });
      }

      return;
    }

    this.registry.setEmpReady(
      controllerMac,
      false,
    );

    const until =
      Date.now() + config.empDurationMs;

    this.registry.setPowerCutUntil(
      result.targetMac,
      until,
    );

    const targetDevice =
      this.registry.get(result.targetMac);

    if (targetDevice) {
      this.udp.sendWithRetry(
        targetDevice.ip,
        encodePowerCut(
          config.empDurationMs,
        ),
      );
    }

    setTimeout(() => {
      const dev =
        this.registry.get(result.targetMac);

      if (
        dev?.powerCutUntil === until
      ) {
        this.registry.setPowerCutUntil(
          result.targetMac,
          null,
        );
      }
    }, config.empDurationMs + 50);

    const {
      audio,
      light,
    } = empAmbiance();

    if (this.ws) {
      this.ws.broadcast({
        type: "audio_event",
        event: audio,
      });

      this.ws.broadcast({
        type: "light_event",
        ...light,
      });
    }

    this.dispatchLightFx(
      light.pattern,
    );
  }

  // -------------------------------------------------------------------------
  // Match ambiance
  // -------------------------------------------------------------------------

  private handleGoalAmbiance(
    team: Team,
  ): void {
    const eligibility =
      computeEmpEligibility(
        this.match.get(),
      );

    for (
      const controller of
        this.registry.list()
    ) {
      if (
        controller.nodeType !== "controller" ||
        !controller.team
      ) {
        continue;
      }

      if (
        eligibility[
          controller.team
        ]
      ) {
        this.registry.setEmpReady(
          controller.mac,
          true,
        );
      }
    }

    const {
      audio,
      light,
    } = goalAmbiance(team);

    void this.spotify.duck();

    if (this.ws) {
      this.ws.broadcast({
        type: "audio_event",
        event: audio,
      });

      this.ws.broadcast({
        type: "light_event",
        ...light,
      });
    }

    this.dispatchLightFx(
      light.pattern,
    );

    setTimeout(
      () => {
        void this.spotify.resume();
      },
      4000,
    );
  }

  private handleIntenseChange(
    isIntense: boolean,
  ): void {
    const {
      audio,
      light,
    } = intenseAmbiance(
      isIntense,
    );

    if (this.ws) {
      this.ws.broadcast({
        type: "audio_event",
        event: audio,
      });

      this.ws.broadcast({
        type: "light_event",
        ...light,
      });
    }

    this.dispatchLightFx(
      light.pattern,
    );
  }

  private handleMatchEnd(): void {
    const {
      audio,
      light,
    } = matchEndAmbiance(
      this.match.get(),
    );

    if (this.ws) {
      this.ws.broadcast({
        type: "audio_event",
        event: audio,
      });

      this.ws.broadcast({
        type: "light_event",
        ...light,
      });

      this.ws.broadcast({
        type: "history",
        entries:
          this.match.getHistory(),
      });
    }

    this.dispatchLightFx(
      light.pattern,
    );
  }

  announceMatchStart(): void {
    const {
      audio,
      light,
    } = matchStartAmbiance();

    if (this.ws) {
      this.ws.broadcast({
        type: "audio_event",
        event: audio,
      });
    }

    this.dispatchLightFx(
      light.pattern,
    );
  }

  // -------------------------------------------------------------------------
  // Lighting
  // -------------------------------------------------------------------------

  private dispatchLightFx(
    pattern: string,
  ): void {
    if (!this.udp) {
      return;
    }

    const lighting =
      this.registry
        .list()
        .find(
          (d) =>
            d.nodeType === "lighting",
        );

    if (
      lighting?.isOnline
    ) {
      this.udp.sendTo(
        lighting.ip,
        encodeLightFx(pattern),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.udp) {
      await this.udp.stop();
    }

    await this.registry.flush();

    await this.players.flush();

    await this.queue.flush();

    await this.settings.flush();

    await this.match.flush();
  }
}