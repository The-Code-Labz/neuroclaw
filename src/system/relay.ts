// Tool relay — lets the nclaw CLI execute agent tool calls locally and post
// results back.  The session registry maps sessionId → dispatch fn.  The
// pending map holds un-resolved tool calls until the client posts a result.
//
// IMPORTANT: registering a dispatch (setRelayDispatch) is only half the
// story — tool handlers in tools/registry.ts must actually call
// relayToolCall()/tryRelay() before falling back to server-side execution,
// otherwise bash_run/fs_* always run in the server-side sandboxed workspace
// even when an nclaw-cli client is attached with x-tool-relay: true.

import { randomUUID } from 'crypto';

export type RelayDispatch = (toolCallId: string, tool: string, argsStr: string) => Promise<string>;

const sessionRegistry = new Map<string, RelayDispatch>();
const pending          = new Map<string, (result: string) => void>();

/** How long to wait for the CLI client to post a tool result before giving up
 *  and falling back to local (server-side) execution. Generous because bash
 *  commands on the client can legitimately take a while and the client may
 *  itself be waiting on a y/n confirmation prompt from its human. */
const RELAY_TIMEOUT_MS = 180_000;

export function setRelayDispatch(sessionId: string, dispatch: RelayDispatch): void {
  sessionRegistry.set(sessionId, dispatch);
}

export function clearRelayDispatch(sessionId: string): void {
  sessionRegistry.delete(sessionId);
}

export function getRelayDispatch(sessionId: string | null | undefined): RelayDispatch | undefined {
  if (!sessionId) return undefined;
  return sessionRegistry.get(sessionId);
}

export function createPending(toolCallId: string): Promise<string> {
  return new Promise((resolve) => {
    pending.set(toolCallId, resolve);
  });
}

export function resolvePending(toolCallId: string, result: string): boolean {
  const resolve = pending.get(toolCallId);
  if (!resolve) return false;
  pending.delete(toolCallId);
  resolve(result);
  return true;
}

/**
 * If an nclaw-cli (or any relay-capable) client is attached to this session,
 * forward the tool call to it and await the client-executed result. Returns
 * `undefined` when no relay is registered for the session (normal Discord /
 * dashboard chat) — callers should fall back to local execution in that case.
 *
 * Parses the client's JSON-string result into an object; if the payload
 * isn't JSON (e.g. a bare file-content string from a small fs_read), it's
 * wrapped so callers always get a plain object back.
 */
export async function tryRelay(
  sessionId: string | null | undefined,
  tool:      string,
  args:      Record<string, unknown>,
): Promise<unknown | undefined> {
  const dispatch = getRelayDispatch(sessionId);
  if (!dispatch) return undefined;

  const toolCallId = randomUUID();
  const timeout = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('relay: client did not respond in time')), RELAY_TIMEOUT_MS);
  });

  let raw: string;
  try {
    raw = await Promise.race([dispatch(toolCallId, tool, JSON.stringify(args ?? {})), timeout]);
  } finally {
    // Whichever branch wins, stop tracking this call so a late client
    // response after a timeout doesn't resolve a stale/reused id.
    pending.delete(toolCallId);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { ok: true, content: raw };
  }
}
