import { AsyncQueue } from '../queue';

class SessionQueueManager {
  private readonly queues = new Map<string, { queue: AsyncQueue; lastUsed: number }>();

  constructor() {
    // Prune idle queues every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  enqueue<T>(sessionId: string, task: () => Promise<T>, timeoutMs?: number): Promise<T> {
    let entry = this.queues.get(sessionId);
    if (!entry) {
      entry = { queue: new AsyncQueue(), lastUsed: Date.now() };
      this.queues.set(sessionId, entry);
    }
    entry.lastUsed = Date.now();
    return entry.queue.add(task, timeoutMs);
  }

  activeCount(): number {
    return this.queues.size;
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes idle
    for (const [id, entry] of this.queues) {
      if (entry.lastUsed < cutoff) this.queues.delete(id);
    }
  }
}

export const sessionQueueManager = new SessionQueueManager();
