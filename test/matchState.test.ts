import { describe, it, expect, vi } from "vitest";
import { MatchStateManager, computeEmpEligibility, computeIntenseMode } from "../src/state/matchState.js";
import type { MatchState } from "../src/types.js";

function baseState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: "test",
    playerRedName: "Red",
    playerBlueName: "Blue",
    scoreRed: 0,
    scoreBlue: 0,
    timeRemainingMs: 900_000,
    matchDurationMs: 900_000,
    matchActive: true,
    isPaused: false,
    isIntenseMode: false,
    consecutiveGoalsRed: 0,
    consecutiveGoalsBlue: 0,
    winner: null,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  };
}

describe("computeIntenseMode", () => {
  it("is false when time remains above the threshold, even if tied", () => {
    expect(computeIntenseMode(baseState({ timeRemainingMs: 46_000 }))).toBe(false);
  });

  it("is true exactly at the 45s boundary when tied", () => {
    expect(computeIntenseMode(baseState({ timeRemainingMs: 45_000 }))).toBe(true);
  });

  it("is false when under the threshold but not tied", () => {
    expect(computeIntenseMode(baseState({ timeRemainingMs: 10_000, scoreRed: 2, scoreBlue: 1 }))).toBe(false);
  });

  it("is false when the match isn't active or is paused", () => {
    expect(computeIntenseMode(baseState({ timeRemainingMs: 10_000, matchActive: false }))).toBe(false);
    expect(computeIntenseMode(baseState({ timeRemainingMs: 10_000, isPaused: true }))).toBe(false);
  });
});

describe("computeEmpEligibility", () => {
  it("unlocks for a team on 2 consecutive goals", () => {
    const elig = computeEmpEligibility(baseState({ consecutiveGoalsRed: 2 }));
    expect(elig.red).toBe(true);
    expect(elig.blue).toBe(false);
  });

  it("unlocks for a team trailing by 2+", () => {
    const elig = computeEmpEligibility(baseState({ scoreRed: 0, scoreBlue: 2 }));
    expect(elig.red).toBe(true);
    expect(elig.blue).toBe(false);
  });

  it("does not unlock when neither condition is met", () => {
    const elig = computeEmpEligibility(baseState({ scoreRed: 1, scoreBlue: 1, consecutiveGoalsRed: 1 }));
    expect(elig.red).toBe(false);
    expect(elig.blue).toBe(false);
  });
});

describe("MatchStateManager", () => {
  // Only exercises start/goal/undo/adjustTime, which don't touch the tick
  // timer or history persistence — those are covered by init(), which these
  // tests deliberately skip to stay fast and filesystem-free.
  function makeManager() {
    const onIntenseChange = vi.fn();
    const events = {
      onGoal: vi.fn(),
      onIntenseChange,
      onMatchEnd: vi.fn(),
      onChange: vi.fn(),
    };
    const manager = new MatchStateManager(events);
    return { manager, events };
  }

  it("tracks consecutive goals per team and resets the other side's streak", () => {
    const { manager } = makeManager();
    manager.start();
    manager.goal("red");
    manager.goal("red");
    expect(manager.get().consecutiveGoalsRed).toBe(2);
    manager.goal("blue");
    expect(manager.get().consecutiveGoalsRed).toBe(0);
    expect(manager.get().consecutiveGoalsBlue).toBe(1);
    expect(manager.get().scoreRed).toBe(2);
    expect(manager.get().scoreBlue).toBe(1);
  });

  it("enters intense mode near the buzzer while tied, and exits when the lead breaks", () => {
    const { manager, events } = makeManager();
    manager.start();
    manager.adjustTime(-(900_000 - 40_000)); // 40s left, still 0-0
    expect(manager.get().isIntenseMode).toBe(true);
    expect(events.onIntenseChange).toHaveBeenCalledWith(true, expect.anything());

    manager.goal("red"); // 1-0 breaks the tie
    expect(manager.get().isIntenseMode).toBe(false);
    expect(events.onIntenseChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("undo reverses the most recent goal only", () => {
    const { manager } = makeManager();
    manager.start();
    manager.goal("red");
    manager.goal("blue");
    expect(manager.undoLastGoal()).toBe(true);
    expect(manager.get().scoreBlue).toBe(0);
    expect(manager.get().scoreRed).toBe(1);
    // A second undo with nothing queued is a no-op, not a crash.
    expect(manager.undoLastGoal()).toBe(false);
  });

  it("ignores goals once the match is no longer active", () => {
    const { manager } = makeManager();
    manager.reset();
    manager.goal("red");
    expect(manager.get().scoreRed).toBe(0);
  });
});
