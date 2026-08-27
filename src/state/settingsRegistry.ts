import path from "node:path";

import { config } from "../config.js";
import { JsonStore } from "../persistence/store.js";

export interface GameSettings {
  matchDurationMin: number;
  intenseModeTriggerSec: number;
  goalLimit: number;

  winCondition:
    | "Most goals when time ends"
    | "First to N goals"
    | "Golden goal / sudden death";

  suddenDeathOnTie: boolean;
  autoPauseOnDisconnect: boolean;

  kickerCooldownSec: number;
  empCooldownSec: number;

  kickerEnabled: boolean;
  empEnabled: boolean;

  lightingMode:
    | "Match live (auto)"
    | "Always on"
    | "Off";

  confettiOnGoal: boolean;
  arenaShakeOnGoal: boolean;
  ledSweepInIntense: boolean;

  goalSound: boolean;
  intenseModeMusic: boolean;
  matchEndMusic: boolean;

  masterVolume: number;
}

const DEFAULT_SETTINGS: GameSettings = {
  matchDurationMin: config.matchDurationMs / 60_000,
  intenseModeTriggerSec: config.intenseThresholdMs / 1_000,
  goalLimit: 5,

  winCondition: "Most goals when time ends",

  suddenDeathOnTie: true,
  autoPauseOnDisconnect: true,

  kickerCooldownSec: config.kickerCooldownMs / 1_000,
  empCooldownSec: 45,

  kickerEnabled: true,
  empEnabled: true,

  lightingMode: "Match live (auto)",

  confettiOnGoal: true,
  arenaShakeOnGoal: true,
  ledSweepInIntense: true,

  goalSound: true,
  intenseModeMusic: true,
  matchEndMusic: true,

  masterVolume: 80,
};

export class SettingsRegistry {
  private settings: GameSettings = {
    ...DEFAULT_SETTINGS,
  };

  private readonly store =
    new JsonStore<GameSettings>(
      path.join(config.dataDir, "settings.json"),
      DEFAULT_SETTINGS,
    );

  async init(): Promise<void> {
    const saved = await this.store.load();

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
    };
  }

  get(): GameSettings {
    return {
      ...this.settings,
    };
  }

  update(
    changes: Partial<GameSettings>,
  ): GameSettings {
    this.settings = {
      ...this.settings,
      ...changes,
    };

    this.store.save(this.settings);

    return this.get();
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}