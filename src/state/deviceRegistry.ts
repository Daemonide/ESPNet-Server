import path from "node:path";
import { config } from "../config.js";
import { JsonStore } from "../persistence/store.js";
import type { DeviceNode, NodeType, Team } from "../types.js";

type Listener = () => void;

/**
 * In-memory fleet registry, keyed by MAC address (stable across reboots,
 * unlike IP which changes on every DHCP re-lease).
 *
 * Fault-tolerance rules (see ARCHITECTURE.md "ESP32 restarts" section):
 *  - A heartbeat only ever *seeds* nodeType/team when they're still unset.
 *    It never overwrites a value the referee assigned via REST, even though
 *    the wire format lets the device report both on every packet.
 *  - powerup/cooldown/pairing state lives here only, never trusted from the
 *    device, so a device's own memory loss on reboot is a non-event.
 */
export class DeviceRegistry {
  private devices = new Map<string, DeviceNode>();
  private store: JsonStore<DeviceNode[]>;
  private listeners = new Set<Listener>();

  constructor() {
    this.store = new JsonStore<DeviceNode[]>(
      path.join(config.dataDir, "devices.json"),
      [],
    );
  }

  async init(): Promise<void> {
    const loaded = await this.store.load();
    for (const dev of loaded) {
      // Nothing is "online" until it proves itself with a fresh heartbeat.
      this.devices.set(dev.mac, { ...dev, isOnline: false });
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.store.save([...this.devices.values()]);
    for (const l of this.listeners) l();
  }

  list(): DeviceNode[] {
    return [...this.devices.values()].sort((a, b) => a.mac.localeCompare(b.mac));
  }

  get(mac: string): DeviceNode | undefined {
    return this.devices.get(mac);
  }

  findByPattern(nodeType: NodeType): DeviceNode[] {
    return this.list().filter((d) => d.nodeType === nodeType);
  }

  /** Handle a HEARTBEAT|mac|ip|batt|nodeType|team packet. */
  upsertFromHeartbeat(input: {
    mac: string;
    ip: string;
    batteryPct: number | null;
    nodeType: NodeType | null;
    team: Team | null;
  }): void {
    const now = Date.now();
    const existing = this.devices.get(input.mac);

    if (existing) {
      existing.ip = input.ip;
      existing.lastSeen = now;
      existing.isOnline = true;
      if (input.batteryPct !== null) existing.batteryPct = input.batteryPct;
      // Seed-only: never clobber a referee-assigned value.
      if (existing.nodeType === null && input.nodeType !== null) {
        existing.nodeType = input.nodeType;
      }
      if (existing.team === null && input.team !== null) {
        existing.team = input.team;
      }
    } else {
      const fresh: DeviceNode = {
        mac: input.mac,
        ip: input.ip,
        nodeType: input.nodeType,
        team: input.team,
        pairedMac: null,
        isOnline: true,
        lastSeen: now,
        firstSeen: now,
        batteryPct: input.batteryPct,
        label: null,
        kickerCooldownUntil: null,
        powerupEmpReady: false,
        powerCutUntil: null,
      };
      this.devices.set(input.mac, fresh);
    }
    this.notify();
  }

  /** Periodic sweep: flip is_online false for anything past the grace window. Returns true if anything changed. */
  sweepOffline(): boolean {
    const now = Date.now();
    let changed = false;
    for (const dev of this.devices.values()) {
      if (dev.isOnline && now - dev.lastSeen > config.offlineThresholdMs) {
        dev.isOnline = false;
        changed = true;
      }
    }
    if (changed) this.notify();
    return changed;
  }

  setNodeType(mac: string, nodeType: NodeType | null): boolean {
    const dev = this.devices.get(mac);
    if (!dev) return false;
    dev.nodeType = nodeType;
    this.notify();
    return true;
  }

  setTeam(mac: string, team: Team | null): boolean {
    const dev = this.devices.get(mac);
    if (!dev) return false;
    dev.team = team;
    this.notify();
    return true;
  }

  setLabel(mac: string, label: string | null): boolean {
    const dev = this.devices.get(mac);
    if (!dev) return false;
    dev.label = label;
    this.notify();
    return true;
  }

  /** Pair a controller MAC with a truck MAC (bidirectional link). */
  pair(controllerMac: string, truckMac: string): boolean {
    const controller = this.devices.get(controllerMac);
    const truck = this.devices.get(truckMac);
    if (!controller || !truck) return false;
    controller.pairedMac = truckMac;
    truck.pairedMac = controllerMac;
    this.notify();
    return true;
  }

  unpair(mac: string): boolean {
    const dev = this.devices.get(mac);
    if (!dev || !dev.pairedMac) return false;
    const other = this.devices.get(dev.pairedMac);
    if (other) other.pairedMac = null;
    dev.pairedMac = null;
    this.notify();
    return true;
  }

  remove(mac: string): boolean {
    const dev = this.devices.get(mac);
    if (!dev) return false;
    if (dev.pairedMac) {
      const other = this.devices.get(dev.pairedMac);
      if (other) other.pairedMac = null;
    }
    this.devices.delete(mac);
    this.notify();
    return true;
  }

  setKickerCooldown(mac: string, until: number | null): void {
    const dev = this.devices.get(mac);
    if (!dev) return;
    dev.kickerCooldownUntil = until;
    this.notify();
  }

  setEmpReady(mac: string, ready: boolean): void {
    const dev = this.devices.get(mac);
    if (!dev) return;
    dev.powerupEmpReady = ready;
    this.notify();
  }

  setPowerCutUntil(mac: string, until: number | null): void {
    const dev = this.devices.get(mac);
    if (!dev) return;
    dev.powerCutUntil = until;
    this.notify();
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}
