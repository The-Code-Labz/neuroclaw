// Tool relay — lets the nclaw CLI execute agent tool calls locally and post
// results back.  The session registry maps sessionId → dispatch fn.  The
// pending map holds un-resolved tool calls until the client posts a result.

export type RelayDispatch = (toolCallId: string, tool: string, argsStr: string) => Promise<string>;

const sessionRegistry = new Map<string, RelayDispatch>();
const pending          = new Map<string, (result: string) => void>();

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
