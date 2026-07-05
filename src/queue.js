"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageQueue = exports.AsyncQueue = void 0;
class AsyncQueue {
    constructor() {
        this.pending = [];
        this.running = false;
    }
    add(task) {
        return new Promise((resolve, reject) => {
            this.pending.push(async () => {
                try {
                    resolve(await task());
                }
                catch (err) {
                    reject(err);
                }
            });
            void this.process();
        });
    }
    async process() {
        if (this.running)
            return;
        this.running = true;
        while (this.pending.length > 0) {
            const next = this.pending.shift();
            if (next)
                await next();
        }
        this.running = false;
    }
}
exports.AsyncQueue = AsyncQueue;
// TODO [task queue workers]: Replace with BullMQ/Redis for durable async task processing
exports.messageQueue = new AsyncQueue();
