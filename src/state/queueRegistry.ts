import path from "node:path";

import { config } from "../config.js";
import { JsonStore } from "../persistence/store.js";
import type { QueuedMatch } from "../types.js";

export class QueueRegistry {
  private queue = new Map<string, QueuedMatch>();

  private readonly store = new JsonStore<QueuedMatch[]>(
    path.join(config.dataDir, "queue.json"),
    [],
  );

  async init(): Promise<void> {
    const savedQueue = await this.store.load();

    this.queue.clear();

    for (const item of savedQueue) {
      this.queue.set(item.id, item);
    }
  }

  list(): QueuedMatch[] {
    return Array.from(this.queue.values());
  }

  get(id: string): QueuedMatch | null {
    return this.queue.get(id) ?? null;
  }

  add(
    playerRedId: string,
    playerBlueId: string,
  ): QueuedMatch {
    const item: QueuedMatch = {
      id: crypto.randomUUID(),
      playerRedId,
      playerBlueId,
      createdAt: Date.now(),
    };

    this.queue.set(item.id, item);
    this.save();

    return item;
  }

  update(
    id: string,
    changes: Partial<
      Pick<QueuedMatch, "playerRedId" | "playerBlueId">
    >,
  ): QueuedMatch | null {
    const item = this.queue.get(id);

    if (!item) {
      return null;
    }

    Object.assign(item, changes);
    this.save();

    return item;
  }

  remove(id: string): boolean {
    const removed = this.queue.delete(id);

    if (removed) {
      this.save();
    }

    return removed;
  }

  removePlayerReferences(playerId: string): void {
    let changed = false;

    for (const [id, item] of this.queue.entries()) {
      if (
        item.playerRedId === playerId ||
        item.playerBlueId === playerId
      ) {
        this.queue.delete(id);
        changed = true;
      }
    }

    if (changed) {
      this.save();
    }
  }

  private save(): void {
    this.store.save(this.list());
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}