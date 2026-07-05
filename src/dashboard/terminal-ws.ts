import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Server } from 'http';
import { config } from '../config';
import { getAgentById, getAllAgents, createSession } from '../db';
import { chatStream, orchestrateMultiAgent, type MetaEvent } from '../agent/alfred';
import { logger } from '../utils/logger';

type ClientMsg =
  | { type: 'message'; content: string }
  | { type: 'ping' };

type ServerMsg =
  | { type: 'session';  sessionId: string }
  | { type: 'agent';    agentId: string; agentName: string }
  | { type: 'route';    from: string; to: string }
  | { type: 'tool';     label: string }
  | { type: 'chunk';    content: string }
  | { type: 'done' }
  | { type: 'error';    message: string }
  | { type: 'pong' };

function safeSend(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function extractToken(reqUrl: string, cookieHeader: string): string {
  try {
    const url = new URL(reqUrl, 'http://x');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch { /* fall through */ }
  return /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookieHeader)?.[1] ?? '';
}

export function attachTerminalWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return;
    }
    if (pathname !== '/api/terminal') return;

    const cookie = req.headers.cookie ?? '';
    const token  = extractToken(req.url ?? '', cookie);
    if (token !== config.dashboard.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage) => {
    let agentParam: string | undefined;
    let sessionParam: string | undefined;
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      agentParam   = url.searchParams.get('agent')   ?? undefined;
      sessionParam = url.searchParams.get('session') ?? undefined;
    } catch { /* use defaults */ }

    const agent = (agentParam ? getAgentById(agentParam) : null)
      ?? getAllAgents().find(a => a.name === 'Alfred' && a.status === 'active')
      ?? getAllAgents().find(a => a.status === 'active');

    if (!agent) {
      safeSend(ws, { type: 'error', message: 'no active agent found' });
      ws.close();
      return;
    }

    const sessionId = sessionParam ?? createSession(agent.id, undefined, 'terminal');
    safeSend(ws, { type: 'session',  sessionId });
    safeSend(ws, { type: 'agent', agentId: agent.id, agentName: agent.name });

    let inFlight = false;
    ws.on('message', async (data: Buffer) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(data.toString()) as ClientMsg; } catch { return; }

      if (msg.type === 'ping') { safeSend(ws, { type: 'pong' }); return; }
      if (msg.type !== 'message' || !msg.content?.trim()) return;
      if (inFlight) return;

      inFlight = true;
      const onMeta = (e: MetaEvent): void => {
        if      (e.type === 'route')          safeSend(ws, { type: 'route', from: e.event.from, to: e.event.to });
        else if (e.type === 'mcp_call_start') safeSend(ws, { type: 'tool',  label: `${e.tool}...` });
        else if (e.type === 'spawn')          safeSend(ws, { type: 'tool',  label: `spawning ${e.event.agentName}...` });
      };

      const onChunk = (chunk: string): void => {
        safeSend(ws, { type: 'chunk', content: chunk });
      };

      try {
        if (agent.name === 'Alfred') {
          await orchestrateMultiAgent(msg.content, sessionId, onChunk, agent.id, onMeta, 'terminal');
        } else {
          await chatStream(msg.content, sessionId, onChunk, agent.system_prompt ?? '', agent.id, onMeta);
        }
        safeSend(ws, { type: 'done' });
      } catch (err) {
        safeSend(ws, { type: 'error', message: (err as Error).message });
      } finally {
        inFlight = false;
      }
    });

    ws.on('error', (err) => logger.warn('terminal ws error', { err: err.message }));
  });

  logger.info('terminal-ws: handler attached at /api/terminal');
}
