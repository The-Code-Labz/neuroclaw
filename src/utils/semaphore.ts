// src/utils/semaphore.ts — tiny async concurrency limiter.
// No external deps; used by render-node-exec to cap concurrent node ops.

export interface AcquiredPermit {
  release: () => void;
}

export class Semaphore {
  private running = 0;
  private queue: Array<(permit: AcquiredPermit) => void> = [];

  constructor(private max: number) {
    if (max < 1) throw new Error(`semaphore max must be >= 1, got ${max}`);
  }

  get available(): number {
    return Math.max(0, this.max - this.running);
  }

  get inUse(): number {
    return this.running;
  }

  async acquire(): Promise<AcquiredPermit> {
    if (this.running < this.max) {
      this.running += 1;
      return { release: this.makeRelease() };
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      const next = this.queue.shift();
      if (next) {
        this.running += 1;
        next({ release: this.makeRelease() });
      }
    };
  }
}

/** Parse a positive integer from an env var, falling back to a default. */
export function envConcurrency(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return n;
}
