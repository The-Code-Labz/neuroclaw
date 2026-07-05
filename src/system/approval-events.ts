import { EventEmitter } from 'events';

/**
 * Shared event bus for approval lifecycle events.
 *
 * Emits:
 *   'pending'  → new approval awaiting user decision (wakes SSE streams)
 *   'resolved' → approval status changed to approved/denied (wakes bridge promises)
 *
 * Hoisted from routes.ts to break circular imports:
 * routes → alfred → claude-cli → bridge → approval-events (leaf)
 */
export const approvalEvents = new EventEmitter();
approvalEvents.setMaxListeners(100);
