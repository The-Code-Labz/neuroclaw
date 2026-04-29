type QueueTask<T> = () => Promise<T>;

class AsyncQueue {
  private readonly pending: Array<() => void> = [];
  private running = false;

  add<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
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
