import { z } from "zod";
import type { NodeType, Team } from "../types.js";

// Loose-but-safe MAC/IP validation: reject garbage before it ever reaches the
// registry, but don't be so strict that a slightly-odd but real packet gets
// dropped. Malformed input becomes `{ kind: 'unknown' }`, never a throw.
const macSchema = z.string().regex(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/);
const ipSchema = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/);

function parseNodeType(raw: string | undefined): NodeType | null {
  if (raw === "controller" || raw === "truck" || raw === "lighting") return raw;
  return null;
}

function parseTeam(raw: string | undefined): Team | null {
  if (raw === "red" || raw === "blue") return raw;
  return null;
}

function parseBattery(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

export type InboundMessage =
  | { kind: "discover" }
  | {
      kind: "heartbeat";
      mac: string;
      ip: string;
      batteryPct: number | null;
      nodeType: NodeType | null;
      team: Team | null;
    }
  | { kind: "kick_req"; mac: string }
  | { kind: "emp_req"; mac: string; targetTeam: Team }
  | { kind: "unknown"; raw: string };

/**
 * Parses the PRD §5.1 pipe-delimited UDP dictionary. Never throws — any
 * malformed/short/garbled packet becomes `{ kind: 'unknown' }` so a single
 * corrupt UDP datagram (packet loss/reordering, a half-booted ESP32 spraying
 * partial writes, etc.) can never take the listener loop down. The original
 * Rust server just indexed `parts[N]` after a length check per-branch; this
 * is the same idea but centralized and total.
 */
export function parseInbound(raw: string): InboundMessage {
  const msg = raw.trim();
  if (msg.length === 0) return { kind: "unknown", raw };
  if (msg === "DISCOVER_SERVER") return { kind: "discover" };

  const parts = msg.split("|");

  if (parts[0] === "HEARTBEAT") {
    const macCandidate = parts[1];
    const ipCandidate = parts[2];
    const mac = macSchema.safeParse(macCandidate);
    const ip = ipSchema.safeParse(ipCandidate);
    if (!mac.success || !ip.success) return { kind: "unknown", raw };
    return {
      kind: "heartbeat",
      mac: mac.data,
      ip: ip.data,
      batteryPct: parseBattery(parts[3]),
      nodeType: parseNodeType(parts[4]),
      team: parseTeam(parts[5]),
    };
  }

  if (parts[0] === "EVENT" && parts[1] === "KICK_REQ") {
    const mac = macSchema.safeParse(parts[2]);
    if (!mac.success) return { kind: "unknown", raw };
    return { kind: "kick_req", mac: mac.data };
  }

  if (parts[0] === "EVENT" && parts[1] === "EMP_REQ") {
    const mac = macSchema.safeParse(parts[2]);
    const targetTeam = parseTeam(parts[3]);
    if (!mac.success || !targetTeam) return { kind: "unknown", raw };
    return { kind: "emp_req", mac: mac.data, targetTeam };
  }

  return { kind: "unknown", raw };
}

export const encodeServerOnline = (): string => "ESPNet-Server-Online";
export const encodeKickFire = (): string => "CMD|KICK_FIRE";
export const encodePowerCut = (ms: number): string => `CMD|POWER_CUT|${ms}`;
export const encodeSetLed = (state: "ON" | "OFF" | "BLINK"): string => `CMD|SET_LED|${state}`;
export const encodeLightFx = (pattern: string, rgbHex?: string): string =>
  rgbHex ? `CMD|LIGHT_FX|${pattern}|${rgbHex}` : `CMD|LIGHT_FX|${pattern}`;
