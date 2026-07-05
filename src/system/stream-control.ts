const activeStreams = new Map<string, AbortController>();

export function registerStream(sessionId: string): AbortSignal {
  const ctrl = new AbortController();
  activeStreams.set(sessionId, ctrl);
  return ctrl.signal;
}

export function stopStream(sessionId: string): boolean {
  const ctrl = activeStreams.get(sessionId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export function clearStream(sessionId: string): void {
  activeStreams.delete(sessionId);
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.message === 'This operation was aborted' ||
      err.message === 'client disconnected'
    );
  }
  return false;
}
