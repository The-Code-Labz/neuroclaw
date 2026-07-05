// Keyed semaphore — bounds concurrent work per string key (e.g. per provider
// family). One independent counter + FIFO waiter queue per key.
//
// Uses the same slot-handoff discipline as the codex-cli gate: a releaser
// passes its slot DIRECTLY to the next waiter without decrementing the counter,
// so a fresh acquire() can't slip in between the decrement and the woken
// waiter's re-increment and over-admit past the limit when limit > 1.

interface KeyState {
  inflight: number;
  queue:    Array<() => void>;
}

export class KeyedSemaphore {
  private readonly states = new Map<string, KeyState>();

  constructor(private readonly limit: number) {}

  private stateFor(key: string): KeyState {
    let s = this.states.get(key);
    if (!s) { s = { inflight: 0, queue: [] }; this.states.set(key, s); }
    return s;
  }

  private async acquire(key: string): Promise<void> {
    const limit = Math.max(1, this.limit);
    const s = this.stateFor(key);
    if (s.inflight < limit) { s.inflight++; return; }
    // Waiter path: inflight is NOT incremented here — release() hands us the
    // releaser's still-counted slot.
    await new Promise<void>(resolve => s.queue.push(resolve));
  }

  private release(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    const next = s.queue.shift();
    if (next) { next(); return; } // slot transfers to the waiter, count unchanged
    s.inflight--;
    // Drop empty state so the map doesn't grow unbounded across many keys.
    if (s.inflight <= 0 && s.queue.length === 0) this.states.delete(key);
  }

  /** Run `fn` while holding a slot for `key`. Releases on success or throw. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** Current number of queued (waiting, not yet admitted) callers for `key`. */
  queueLength(key: string): number {
    return this.states.get(key)?.queue.length ?? 0;
  }
}
