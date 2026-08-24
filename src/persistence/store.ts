import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Generic JSON file store: atomic writes (tmp file + rename, so a crash or
 * power-loss mid-write can never leave a truncated/corrupt file behind) and
 * debounced saves (coalesces bursts of change events into one disk write).
 *
 * This replaces the original Rust server's pattern of doing a synchronous
 * `fs::write` on every single event while holding the state lock.
 */
export class JsonStore<T> {
  private pending: T | undefined;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;

  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T,
    private readonly debounceMs = 500,
  ) {}

  async load(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return this.defaultValue;
    }
  }

  /** Schedule a debounced write. Safe to call at high frequency. */
  save(value: T): void {
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Force any pending write to disk immediately (e.g. on shutdown). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === undefined) return;
    const value = this.pending;
    this.pending = undefined;

    if (this.writing) {
      // A write is already in flight; re-queue and let it drain naturally.
      this.pending = value;
      return;
    }

    this.writing = true;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
      await fs.rename(tmpPath, this.filePath);
    } finally {
      this.writing = false;
      if (this.pending !== undefined) {
        const next = this.pending;
        this.pending = undefined;
        this.save(next);
      }
    }
  }
}
