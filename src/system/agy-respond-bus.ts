// Completion bus for the agy tmux+webhook loop.
// The `respond` MCP tool (called by agy as its final action each turn) fires
// emitRespond(), which resolves a waitForRespond() Promise held by
// chatStreamAntigravityCli while it waits for agy to finish its turn.
//
// Keys are `runId` (preferred) or `sessionId::agentId` as a fallback.

import { EventEmitter } from 'events';

export interface RespondPayload {
  content:   string;
  sessionId: string | null;
  runId:     string | null;
  agentId:   string | null;
}

export const respondBus = new EventEmitter();
respondBus.setMaxListeners(200);

// Register a respond listener that can be cancelled. Returns the awaitable
// `promise` and a `cancel()` that detaches the listener and clears the timeout.
//
// The cancel handle exists to close a real race: the caller must start listening
// BEFORE it triggers agy (agy may call the respond tool while the spawn/paste is
// still in flight, and EventEmitter.once only catches FUTURE emits). If the
// trigger itself then fails, the caller calls cancel() so the timeout timer does
// not linger and later reject into nowhere (an unhandled rejection).
export function listenForRespond(
  key: string,
  timeoutMs = 120_000,
): { promise: Promise<string>; cancel: () => void } {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  // Assigned synchronously inside the Promise executor (which runs immediately),
  // so it is always defined before `cancel` could be invoked.
  let onRespond!: (payload: RespondPayload) => void;

  const promise = new Promise<string>((resolve, reject) => {
    onRespond = (payload: RespondPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload.content);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      respondBus.removeListener(key, onRespond);
      reject(new Error(`agy respond timeout after ${timeoutMs}ms for key "${key}"`));
    }, timeoutMs);
    respondBus.once(key, onRespond);
  });

  const cancel = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    respondBus.removeListener(key, onRespond);
  };

  return { promise, cancel };
}

export function waitForRespond(key: string, timeoutMs = 120_000): Promise<string> {
  return listenForRespond(key, timeoutMs).promise;
}

export function emitRespond(key: string, payload: RespondPayload): void {
  respondBus.emit(key, payload);
  respondBus.emit('*', { key, ...payload });
}
