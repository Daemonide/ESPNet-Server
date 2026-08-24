import type { DeviceNode } from "../types.js";

// --- Pure rule functions -----------------------------------------------
// Kept dependency-free (no socket, no registry) so they're trivially unit
// testable. The stateful wrapper below is the only part that touches I/O.

export type KickRejectReason = "unknown_controller" | "cooldown" | "not_paired" | "target_offline";
export type KickResult = { ok: true; truckMac: string } | { ok: false; reason: KickRejectReason };

export function evaluateKick(
  controller: DeviceNode | undefined,
  truck: DeviceNode | undefined,
  now: number,
): KickResult {
  if (!controller) return { ok: false, reason: "unknown_controller" };
  if (controller.kickerCooldownUntil !== null && now < controller.kickerCooldownUntil) {
    return { ok: false, reason: "cooldown" };
  }
  if (!controller.pairedMac || !truck) return { ok: false, reason: "not_paired" };
  if (!truck.isOnline) return { ok: false, reason: "target_offline" };
  return { ok: true, truckMac: truck.mac };
}

export type EmpRejectReason =
  | "unknown_controller"
  | "not_eligible"
  | "no_target"
  | "target_already_frozen"
  | "target_offline";
export type EmpResult = { ok: true; targetMac: string } | { ok: false; reason: EmpRejectReason };

export function evaluateEmp(
  controller: DeviceNode | undefined,
  target: DeviceNode | undefined,
  now: number,
): EmpResult {
  if (!controller) return { ok: false, reason: "unknown_controller" };
  if (!controller.powerupEmpReady) return { ok: false, reason: "not_eligible" };
  if (!target) return { ok: false, reason: "no_target" };
  if (!target.isOnline) return { ok: false, reason: "target_offline" };
  if (target.powerCutUntil !== null && now < target.powerCutUntil) {
    return { ok: false, reason: "target_already_frozen" };
  }
  return { ok: true, targetMac: target.mac };
}
