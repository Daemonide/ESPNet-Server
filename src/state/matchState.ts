import path from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { JsonStore } from "../persistence/store.js";

import type {
  MatchHistoryEntry,
  MatchState,
  Team,
} from "../types.js";

import type { SettingsRegistry } from "./settingsRegistry.js";

// -----------------------------------------------------------------------------
// Create a fresh match using the CURRENT backend settings.
// IMPORTANT:
// This function must only be called after SettingsRegistry.init()
// has completed.
// -----------------------------------------------------------------------------

function freshMatch(
  settings: SettingsRegistry,
): MatchState {
  const currentSettings = settings.get();

  const matchDurationMs =
    currentSettings.matchDurationMin * 60 * 1000;

  return {
    matchId: randomUUID(),

    playerRedName: "Red",
    playerBlueName: "Blue",

    scoreRed: 0,
    scoreBlue: 0,

    timeRemainingMs: matchDurationMs,
    matchDurationMs: matchDurationMs,

    matchActive: false,
    isPaused: false,

    isIntenseMode: false,

    consecutiveGoalsRed: 0,
    consecutiveGoalsBlue: 0,

    winner: null,

    startedAt: null,
    endedAt: null,
  };
}

// -----------------------------------------------------------------------------
// Intense mode
// -----------------------------------------------------------------------------

export function computeIntenseMode(
  state: MatchState,
  thresholdMs: number = config.intenseThresholdMs,
): boolean {
  return (
    state.matchActive &&
    !state.isPaused &&
    state.timeRemainingMs <= thresholdMs &&
    state.scoreRed === state.scoreBlue
  );
}

// -----------------------------------------------------------------------------
// EMP eligibility
// PRD §3.2:
// - 2 consecutive goals
// OR
// - trailing by 2 or more
// -----------------------------------------------------------------------------

export function computeEmpEligibility(
  state: MatchState,
): Record<Team, boolean> {
  return {
    red:
      state.consecutiveGoalsRed >= 2 ||
      state.scoreBlue - state.scoreRed >= 2,

    blue:
      state.consecutiveGoalsBlue >= 2 ||
      state.scoreRed - state.scoreBlue >= 2,
  };
}

// -----------------------------------------------------------------------------
// Match events
// -----------------------------------------------------------------------------

export interface MatchEvents {
  onGoal(
    team: Team,
    state: MatchState,
  ): void;

  onIntenseChange(
    isIntense: boolean,
    state: MatchState,
  ): void;

  onMatchEnd(
    state: MatchState,
  ): void;

  onChange(
    state: MatchState,
  ): void;
}

// -----------------------------------------------------------------------------
// Match State Manager
// -----------------------------------------------------------------------------

export class MatchStateManager {
  /*
   * IMPORTANT:
   *
   * Do NOT initialize this here:
   *
   * private state: MatchState = freshMatch(this.settings);
   *
   * because SettingsRegistry.init() has not run yet.
   *
   * The state is created inside init(), after settings have loaded.
   */
  private state!: MatchState;

  private tickTimer: NodeJS.Timeout | null = null;

  private history: MatchHistoryEntry[] = [];

  private historyStore: JsonStore<
    MatchHistoryEntry[]
  >;

  private lastGoalTeam: Team | null = null;

  constructor(
    private readonly events: MatchEvents,
    private readonly settings: SettingsRegistry,
  ) {
    /*
     * Only create the history store here.
     *
     * DO NOT call settings.get() here.
     */
    this.historyStore =
      new JsonStore<MatchHistoryEntry[]>(
        path.join(
          config.dataDir,
          "matches.json",
        ),
        [],
      );
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    /*
     * At this point Engine.init() has already executed:
     *
     * await this.settings.init();
     *
     * so settings.get() is now safe.
     */

    this.state =
      freshMatch(this.settings);

    this.history =
      await this.historyStore.load();

    this.tickTimer =
      setInterval(
        () => this.tick(),
        1000,
      );
  }

  // ---------------------------------------------------------------------------
  // Get current match
  // ---------------------------------------------------------------------------

  get(): MatchState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Get history
  // ---------------------------------------------------------------------------

  getHistory(): MatchHistoryEntry[] {
    return this.history;
  }

  async clearHistory(): Promise<void> {
  this.history = [];

  this.historyStore.save(this.history);

  await this.historyStore.flush();
}


async deleteHistoryEntry(matchId: string): Promise<boolean> {
  const originalLength = this.history.length;

  this.history = this.history.filter(
    (entry) => entry.matchId !== matchId,
  );

  if (this.history.length === originalLength) {
    return false;
  }

  this.historyStore.save(this.history);

  await this.historyStore.flush();

  return true;
}

  // ---------------------------------------------------------------------------
  // Start match
  // ---------------------------------------------------------------------------

  start(
    playerRedName?: string,
    playerBlueName?: string,
  ): void {
    /*
     * IMPORTANT:
     *
     * Every new match reads the latest saved settings.
     *
     * So if Settings page says:
     *
     * matchDurationMin = 5
     *
     * the match starts with:
     *
     * 5 * 60 * 1000 = 300000 ms
     */

    this.state =
      freshMatch(this.settings);

    if (playerRedName) {
      this.state.playerRedName =
        playerRedName;
    }

    if (playerBlueName) {
      this.state.playerBlueName =
        playerBlueName;
    }

    this.state.matchActive = true;

    this.state.startedAt =
      Date.now();

    this.recomputeIntense();

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Pause
  // ---------------------------------------------------------------------------

  pause(): void {
    if (!this.state.matchActive) {
      return;
    }

    this.state.isPaused = true;

    this.recomputeIntense();

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Resume
  // ---------------------------------------------------------------------------

  resume(): void {
    if (!this.state.matchActive) {
      return;
    }

    this.state.isPaused = false;

    this.recomputeIntense();

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  reset(): void {
    /*
     * Reset also uses the latest settings.
     */

    this.state =
      freshMatch(this.settings);

    this.lastGoalTeam = null;

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Adjust time
  // ---------------------------------------------------------------------------

  adjustTime(
    deltaMs: number,
  ): void {
    if (!this.state.matchActive) {
      return;
    }

    this.state.timeRemainingMs =
      Math.max(
        0,
        Math.min(
          this.state.matchDurationMs,
          this.state.timeRemainingMs +
            deltaMs,
        ),
      );

    this.recomputeIntense();

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Goal
  // ---------------------------------------------------------------------------

  goal(team: Team): void {
    if (!this.state.matchActive) {
      return;
    }

    if (team === "red") {
      this.state.scoreRed += 1;

      this.state.consecutiveGoalsRed +=
        1;

      this.state.consecutiveGoalsBlue =
        0;
    } else {
      this.state.scoreBlue += 1;

      this.state.consecutiveGoalsBlue +=
        1;

      this.state.consecutiveGoalsRed =
        0;
    }

    this.lastGoalTeam = team;

    this.events.onGoal(
      team,
      this.state,
    );

    this.recomputeIntense();

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Undo last goal
  // ---------------------------------------------------------------------------

  undoLastGoal(): boolean {
    if (!this.lastGoalTeam) {
      return false;
    }

    const team =
      this.lastGoalTeam;

    if (
      team === "red" &&
      this.state.scoreRed > 0
    ) {
      this.state.scoreRed -= 1;

      this.state.consecutiveGoalsRed =
        Math.max(
          0,
          this.state.consecutiveGoalsRed -
            1,
        );
    } else if (
      team === "blue" &&
      this.state.scoreBlue > 0
    ) {
      this.state.scoreBlue -= 1;

      this.state.consecutiveGoalsBlue =
        Math.max(
          0,
          this.state.consecutiveGoalsBlue -
            1,
        );
    }

    this.lastGoalTeam = null;

    this.recomputeIntense();

    this.emitChange();

    return true;
  }

  // ---------------------------------------------------------------------------
  // Recalculate intense mode
  // ---------------------------------------------------------------------------

  private recomputeIntense(): void {
    const currentSettings =
      this.settings.get();

    const thresholdMs =
      currentSettings.intenseModeTriggerSec *
      1000;

    const nowIntense =
      computeIntenseMode(
        this.state,
        thresholdMs,
      );

    if (
      nowIntense !==
      this.state.isIntenseMode
    ) {
      this.state.isIntenseMode =
        nowIntense;

      this.events.onIntenseChange(
        nowIntense,
        this.state,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Match clock
  // ---------------------------------------------------------------------------

  private tick(): void {
    if (
      !this.state.matchActive ||
      this.state.isPaused
    ) {
      return;
    }

    this.state.timeRemainingMs =
      Math.max(
        0,
        this.state.timeRemainingMs -
          1000,
      );

    this.recomputeIntense();

    if (
      this.state.timeRemainingMs === 0
    ) {
      this.endMatch();
    } else {
      this.emitChange();
    }
  }

  // ---------------------------------------------------------------------------
  // End match
  // ---------------------------------------------------------------------------

  private endMatch(): void {
    this.state.matchActive = false;

    this.state.isIntenseMode = false;

    this.state.endedAt =
      Date.now();

    this.state.winner =
      this.state.scoreRed ===
      this.state.scoreBlue
        ? "draw"
        : this.state.scoreRed >
          this.state.scoreBlue
          ? "red"
          : "blue";

    this.history.push({
      matchId:
        this.state.matchId,

      playerRedName:
        this.state.playerRedName,

      playerBlueName:
        this.state.playerBlueName,

      scoreRed:
        this.state.scoreRed,

      scoreBlue:
        this.state.scoreBlue,

      winner:
        this.state.winner,

      startedAt:
        this.state.startedAt,

      endedAt:
        this.state.endedAt,
    });

    this.historyStore.save(
      this.history,
    );

    this.events.onMatchEnd(
      this.state,
    );

    this.emitChange();
  }

  // ---------------------------------------------------------------------------
  // Emit state change
  // ---------------------------------------------------------------------------

  private emitChange(): void {
    this.events.onChange(
      this.state,
    );
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async flush(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(
        this.tickTimer,
      );

      this.tickTimer = null;
    }

    await this.historyStore.flush();
  }
}