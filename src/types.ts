// Shared domain types. These mirror the PRD's Rust `DeviceNode` / `MatchState`
// structs field-for-field (in camelCase) so the wire format and the docs stay
// in sync with the implementation.

export type NodeType = "controller" | "truck" | "lighting";

export type Team = "red" | "blue";

export interface DeviceNode {
  mac: string;
  ip: string;
  nodeType: NodeType | null;
  team: Team | null;
  /** Controller <-> Truck pairing. Only meaningful for nodeType === 'controller' | 'truck'. */
  pairedMac: string | null;
  isOnline: boolean;
  lastSeen: number; // epoch ms
  firstSeen: number; // epoch ms
  batteryPct: number | null;
  /** Referee-friendly label, e.g. "Controller 1 (Red)". Independent of team/pairing. */
  label: string | null;
  /** Cooldown expiry for the kicker power-up; null = never fired / cooldown elapsed. */
  kickerCooldownUntil: number | null;
  /** Unlocked by match rules (2 consecutive goals or trailing by 2); consumed on use. */
  powerupEmpReady: boolean;
  /** Set while this controller's remote power is cut by an opponent's EMP. */
  powerCutUntil: number | null;
}

export type MatchWinner = "red" | "blue" | "draw" | null;

export interface MatchState {
  matchId: string;
  playerRedName: string;
  playerBlueName: string;
  scoreRed: number;
  scoreBlue: number;
  timeRemainingMs: number;
  matchDurationMs: number;
  matchActive: boolean;
  isPaused: boolean;
  isIntenseMode: boolean;
  consecutiveGoalsRed: number;
  consecutiveGoalsBlue: number;
  winner: MatchWinner;
  startedAt: number | null;
  endedAt: number | null;
}

export interface MatchHistoryEntry {
  matchId: string;
  playerRedName: string;
  playerBlueName: string;
  scoreRed: number;
  scoreBlue: number;
  winner: MatchWinner;
  startedAt: number | null;
  endedAt: number;
}

export type AudioEvent =
  | "warmup"
  | "match_start"
  | "goal_red"
  | "goal_blue"
  | "intense_start"
  | "intense_end"
  | "kick_fired"
  | "emp_fired"
  | "match_end";

export type LightPattern =
  | "IDLE"
  | "WARMUP"
  | "GOAL_RED"
  | "GOAL_BLUE"
  | "INTENSE"
  | "EMP_FLASH"
  | "WINNER_RED"
  | "WINNER_BLUE"
  | "WINNER_DRAW";

export interface LightEvent {
  pattern: LightPattern;
  rgbHex?: string;
}

/** Outbound push to dashboard WebSocket clients. */
export type ServerEvent =
  | { type: "state"; devices: DeviceNode[]; match: MatchState }
  | { type: "audio_event"; event: AudioEvent }
  | { type: "light_event"; pattern: LightPattern; rgbHex?: string }
  | { type: "powerup_rejected"; action: "kick" | "emp"; mac: string; reason: string }
  | { type: "history"; entries: MatchHistoryEntry[] };


// -----------------------------------------------------------------------------
// Player Management
// -----------------------------------------------------------------------------

export interface Player {
  id: string;
  name: string;
  team: Team | null;
  controllerMac: string | null;

  matches: number;
  wins: number;

  available: boolean;
  createdAt: number;
}

export interface QueuedMatch {
  id: string;
  playerRedId: string;
  playerBlueId: string;
  createdAt: number;
}