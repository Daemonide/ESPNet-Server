import path from "node:path";

import { config } from "../config.js";
import { JsonStore } from "../persistence/store.js";
import type { Player } from "../types.js";

export class PlayerRegistry {
  private players = new Map<string, Player>();

  private readonly store = new JsonStore<Player[]>(
    path.join(config.dataDir, "players.json"),
    [],
  );

  async init(): Promise<void> {
    const savedPlayers = await this.store.load();

    this.players.clear();

    for (const player of savedPlayers) {
      const normalizedPlayer: Player = {
        ...player,

        // Backward compatibility for players
        // created before matches/wins were added.
        matches: player.matches ?? 0,
        wins: player.wins ?? 0,

        available: player.available ?? true,
        controllerMac: player.controllerMac ?? null,
        team: player.team ?? null,
      };

      this.players.set(
        normalizedPlayer.id,
        normalizedPlayer,
      );
    }

    // Save normalized data so old players.json
    // gets upgraded with matches/wins.
    if (savedPlayers.length > 0) {
      this.save();
    }
  }

  list(): Player[] {
    return Array.from(this.players.values());
  }

  get(id: string): Player | null {
    return this.players.get(id) ?? null;
  }

  add(
    name: string,
    team: Player["team"] = null,
    controllerMac: string | null = null,
  ): Player {
    const player: Player = {
      id: crypto.randomUUID(),
      name,
      team,
      controllerMac,

      // New players start with zero stats.
      matches: 0,
      wins: 0,

      available: true,
      createdAt: Date.now(),
    };

    this.players.set(player.id, player);

    this.save();

    return player;
  }

  update(
    id: string,
    changes: Partial<
      Pick<
        Player,
        "name" |
        "team" |
        "controllerMac" |
        "available"
      >
    >,
  ): Player | null {
    const player = this.players.get(id);

    if (!player) {
      return null;
    }

    Object.assign(player, changes);

    this.save();

    return player;
  }

  remove(id: string): boolean {
    const removed = this.players.delete(id);

    if (removed) {
      this.save();
    }

    return removed;
  }

  setAvailability(
    id: string,
    available: boolean,
  ): Player | null {
    return this.update(id, { available });
  }

  availablePlayers(): Player[] {
    return this.list().filter(
      (player) => player.available,
    );
  }

  /**
   * Record the result of a completed match.
   *
   * Both players get their match count increased.
   * The winner gets one additional win.
   */
  recordMatchResult(
    playerRedId: string,
    playerBlueId: string,
    winner: "red" | "blue" | "draw" | null,
  ): boolean {
    const redPlayer = this.players.get(playerRedId);
    const bluePlayer = this.players.get(playerBlueId);

    if (!redPlayer || !bluePlayer) {
      return false;
    }

    redPlayer.matches += 1;
    bluePlayer.matches += 1;

    if (winner === "red") {
      redPlayer.wins += 1;
    } else if (winner === "blue") {
      bluePlayer.wins += 1;
    }

    this.save();

    return true;
  }

  private save(): void {
    this.store.save(this.list());
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}