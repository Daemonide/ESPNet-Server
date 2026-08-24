import type { AudioEvent, LightEvent, MatchState, Team } from "../types.js";

// Pure event-mapping functions per PRD §4 (audio/lighting state diagrams).
// No I/O here — the caller (composition root) fans these out over UDP/WS.

export function goalAmbiance(team: Team): { audio: AudioEvent; light: LightEvent } {
  return {
    audio: team === "red" ? "goal_red" : "goal_blue",
    light: { pattern: team === "red" ? "GOAL_RED" : "GOAL_BLUE" },
  };
}

export function intenseAmbiance(isIntense: boolean): { audio: AudioEvent; light: LightEvent } {
  return isIntense
    ? { audio: "intense_start", light: { pattern: "INTENSE" } }
    : { audio: "intense_end", light: { pattern: "IDLE" } };
}

export function empAmbiance(): { audio: AudioEvent; light: LightEvent } {
  return { audio: "emp_fired", light: { pattern: "EMP_FLASH" } };
}

export function matchEndAmbiance(state: MatchState): { audio: AudioEvent; light: LightEvent } {
  const pattern =
    state.winner === "red" ? "WINNER_RED" : state.winner === "blue" ? "WINNER_BLUE" : "WINNER_DRAW";
  return { audio: "match_end", light: { pattern } };
}

export function matchStartAmbiance(): { audio: AudioEvent; light: LightEvent } {
  return { audio: "match_start", light: { pattern: "IDLE" } };
}
