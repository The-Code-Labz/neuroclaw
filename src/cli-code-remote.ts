import https from 'https';
import http from 'http';
import { URL } from 'url';

export interface RemoteAgent {
  id:          string;
  name:        string;
  description: string;
  role:        string;
  status:      string;
}

export interface RemoteChatOptions {
  url:        string;
  token:      string;
  message:    string;
  sessionId?: string;
  agentId?:   string;
  context?:   string;
  onChunk:    (chunk: string) => void;
  onSession:  (sessionId: string) => void;
}

type SSEEvent = {
  type:       string;
  content?:   string;
  sessionId?: string;
  message?:   string;
};

function makeReqOpts(parsed: URL, method: string, extraHeaders: Record<string, string | number> = {}): http.RequestOptions {
  return {
    method,
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    path:     parsed.pathname + parsed.search,
    headers:  { 'x-dashboard-token': '', ...extraHeaders },
  };
}

function lib(parsed: URL): typeof http | typeof https {
  return parsed.protocol === 'https:' ? https : http;
}

export function chatRemote(opts: RemoteChatOptions): Promise<void> {
  const parsed = new URL(`${opts.url.replace(/\/$/, '')}/api/chat`);
  const body   = JSON.stringify({
    message:   opts.message,
    sessionId: opts.sessionId,
    agentId:   opts.agentId,
    context:   opts.context,
  });

  const reqOpts = makeReqOpts(parsed, 'POST', {
    'Content-Type':      'application/json',
    'Content-Length':    Buffer.byteLength(body),
    'x-dashboard-token': opts.token,
  });

  return new Promise((resolve, reject) => {
    const req = lib(parsed).request(reqOpts, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        reject(new Error('INVALID_TOKEN'));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP_${res.statusCode}`));
        res.resume();
        return;
      }

      let buf = '';
      res.setEncoding('utf8');

      res.on('data', (raw: string) => {
        buf += raw;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') { resolve(); return; }
          try {
            const ev = JSON.parse(data) as SSEEvent;
            if      (ev.type === 'session' && ev.sessionId) opts.onSession(ev.sessionId);
            else if (ev.type === 'chunk'   && ev.content)   opts.onChunk(ev.content);
            else if (ev.type === 'done')                     resolve();
            else if (ev.type === 'error')                    reject(new Error(ev.message ?? 'agent error'));
          } catch { /* skip malformed events */ }
        }
      });

      res.on('end',   () => resolve());
      res.on('error', (e) => reject(new Error(`(connection lost) ${e.message}`)));
    });

    req.on('error', (e) => reject(new Error(`(connection failed) ${e.message}`)));
    req.write(body);
    req.end();
  });
}

export function listAgentsRemote(url: string, token: string): Promise<RemoteAgent[]> {
  const parsed  = new URL(`${url.replace(/\/$/, '')}/api/agents`);
  const reqOpts = makeReqOpts(parsed, 'GET', { 'x-dashboard-token': token });

  return new Promise((resolve, reject) => {
    const req = lib(parsed).request(reqOpts, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        reject(new Error('INVALID_TOKEN'));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} — failed to fetch agents`));
          return;
        }
        try   { resolve(JSON.parse(data) as RemoteAgent[]); }
        catch { reject(new Error('Failed to parse agents response')); }
      });
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

export function checkRemoteConnection(url: string, token: string): Promise<void> {
  const parsed  = new URL(`${url.replace(/\/$/, '')}/api/status`);
  const reqOpts = makeReqOpts(parsed, 'GET', { 'x-dashboard-token': token });

  return new Promise((resolve, reject) => {
    const req = lib(parsed).request(reqOpts, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        reject(new Error('Invalid NEUROCLAW_TOKEN — check your token.'));
        res.resume();
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Server returned HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.resume();
      resolve();
    });
    req.on('error', (e) => reject(new Error(`Cannot reach ${url} — ${e.message}`)));
    req.end();
  });
}
