"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionQueueManager = void 0;
const queue_1 = require("../queue");
class SessionQueueManager {
    constructor() {
        this.queues = new Map();
        // Prune idle queues every 5 minutes
        setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    }
    enqueue(sessionId, task) {
        let entry = this.queues.get(sessionId);
        if (!entry) {
            entry = { queue: new queue_1.AsyncQueue(), lastUsed: Date.now() };
            this.queues.set(sessionId, entry);
        }
        entry.lastUsed = Date.now();
        return entry.queue.add(task);
    }
    activeCount() {
        return this.queues.size;
    }
    cleanup() {
        const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes idle
        for (const [id, entry] of this.queues) {
            if (entry.lastUsed < cutoff)
                this.queues.delete(id);
        }
    }
}
exports.sessionQueueManager = new SessionQueueManager();
