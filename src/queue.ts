import { config } from './config';

type QueueTask<T> = () => Promise<T>;

export class AsyncQueue {
  private readonly pending: Array<() => void> = [];
  private running = false;

  /**
   * Enqueue a task. If it exceeds `timeoutMs` the promise rejects with a
   * timeout Error and the queue continues to the next task — one dead turn
   * doesn't block the session forever.
   *
   * Default is config.queue.timeoutMs, which auto-derives ABOVE both backend
   * ceilings (project: Jarvis long-run triage). The old hard-coded 600_000 (10
   * min) rejected long coding turns while the backend kept working, orphaning
   * the run — this default makes the queue a pure last-resort backstop.
   */
  add<T>(task: QueueTask<T>, timeoutMs = config.queue.timeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        let timer: NodeJS.Timeout | null = null;
        let settled = false;
        const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
        const onDone = (fn: () => void) => { if (!settled) { settled = true; clear(); fn(); } };

        timer = setTimeout(() => {
          onDone(() => reject(new Error(`AsyncQueue timeout after ${timeoutMs}ms`)));
        }, timeoutMs);

        try {
          const result = await task();
          onDone(() => resolve(result));
        } catch (err) {
          onDone(() => reject(err));
        }
      });
      void this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (next) await next();
    }
    this.running = false;
  }
}

// TODO [task queue workers]: Replace with BullMQ/Redis for durable async task processing
export const messageQueue = new AsyncQueue();
