/* live-data.jsx — wires window.NC_DATA to the real /api/* endpoints.
 *
 * Loaded after data.jsx (which provides mock NC_DATA) and before app.jsx.
 * On load and every NC_REFRESH_MS, fetches live data, maps it to the
 * shapes the design's pages expect, mutates window.NC_DATA in place, and
 * dispatches an `nc-data-tick` event so App re-renders.
 *
 * If a fetch fails, the mock value is left intact for that key — the UI
 * stays usable even when the backend is down.
 */

const NC_REFRESH_MS = 15000;

// ── Fetch helpers ──────────────────────────────────────────────────────────

// Per-fetch hard timeout. One hung connection (e.g. dropped TCP, dead vault
// MCP, sleeping laptop) used to wedge Promise.all — leaving NC_DATA frozen
// on its previous state and the dashboard stuck rendering whatever was
// last good (or worse, the mock fallback). 10s ceiling keeps every refresh
// tick bounded.
const FETCH_TIMEOUT_MS = 10000;

function fetchWithTimeout(path, init = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  return fetch(path, { credentials: 'same-origin', ...init, signal: ctl ? ctl.signal : undefined })
    .finally(() => { if (timer) clearTimeout(timer); });
}

window.NC_API = {
  base: '',
  async get(path) {
    const r = await fetchWithTimeout(path);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
  },
  async post(path, body) {
    const r = await fetchWithTimeout(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
    return r.json();
  },
};

// ── Shape mappers ──────────────────────────────────────────────────────────

function classifyTier(model) {
  const m = (model || '').toLowerCase();
  if (/opus|gpt-5|o[1-9]/.test(m)) return 'high';
  if (/haiku|mini|nano|flash|3\.5/.test(m)) return 'low';
  return 'mid';
}

function mapAgent(a) {
  let caps = [];
  try { caps = JSON.parse(a.capabilities || '[]'); } catch { caps = []; }
  const provider = a.provider === 'anthropic'
    ? (a.model_tier && a.model_tier !== 'pinned' ? 'Claude (auto)' : 'Anthropic')
    : 'VoidAI';
  return {
    id:         a.id,
    name:       a.name,
    role:       a.role || 'agent',
    provider,
    model:      a.model || '—',
    status:     a.status === 'active' ? 'live' : 'idle',
    exec:       !!a.exec_enabled,
    temp:       !!a.temporary,
    scope:      a.temporary ? 'session' : 'shared',
    spawnDepth: a.spawn_depth ?? 0,
    tasks:      0,    // filled in by mergeTasksIntoAgents
    color:      a.temporary ? 'violet' : 'neon',
    desc:       a.description || '',
    caps,
    expires:    a.expires_at ? `expires ${new Date(a.expires_at).toLocaleTimeString()}` : undefined,
    parent:     a.parent_agent_id ?? undefined,
    _raw:       a,
  };
}

function mergeTasksIntoAgents(agents, tasks) {
  const counts = {};
  for (const t of tasks) {
    if (t.agent_id) counts[t.agent_id] = (counts[t.agent_id] || 0) + 1;
  }
  return agents.map(a => ({ ...a, tasks: counts[a.id] || 0 }));
}

function mapSession(s, idx) {
  const ageStr = (() => {
    const t = new Date(s.updated_at || s.created_at).getTime();
    if (!t) return '—';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1)  return 'now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  })();
  return {
    id:     s.id,
    title:  s.title || s.id.slice(0, 8),
    agents: [],          // server doesn't expose session→agents linkage; left empty
    msgs:   0,           // could fetch /api/sessions/:id/messages count if needed
    last:   ageStr,
    active: idx === 0 && (s.last_role === 'user' || s.last_role === 'assistant'),
    _raw:   s,
  };
}

function mapTask(t) {
  const status = ['todo','doing','review','done'].includes(t.status) ? t.status : 'todo';
  // sources / code_examples come from the API as JSON strings (raw SQLite columns).
  // Parse here so consumers don't have to JSON.parse every render.
  const parseJson = (raw, fallback) => {
    if (raw == null) return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return fallback; }
  };
  return {
    id:             t.id,
    shortId:        t.id.slice(0, 8),
    title:          t.title || '(untitled)',
    description:    t.description || '',
    status,
    agent:          t.agent_id || '—',
    agentId:        t.agent_id || null,
    priority:       t.priority,
    priority_level: t.priority_level || 'medium',
    project_id:     t.project_id || null,
    parent_task_id: t.parent_task_id || null,
    assignee:       (t.assignee && String(t.assignee).trim()) || 'User',
    task_order:     typeof t.task_order === 'number' ? t.task_order : 0,
    feature:        t.feature || null,
    sources:        parseJson(t.sources, []),
    code_examples:  parseJson(t.code_examples, []),
    archived:       !!t.archived,
    _raw:           t,
  };
}

function mapProject(p) {
  const parseJson = (raw, fallback) => {
    if (raw == null) return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return fallback; }
  };
  return {
    id:          p.id,
    title:       p.title,
    description: p.description || '',
    pinned:      !!p.pinned,
    archived:    !!p.archived,
    docs:        parseJson(p.docs, []),
    features:    parseJson(p.features, []),
    data:        parseJson(p.data, {}),
    github_repo: p.github_repo || null,
    created_at:  p.created_at,
    updated_at:  p.updated_at,
    _raw:        p,
  };
}

function mapMemory(m) {
  let tags = [];
  try { tags = JSON.parse(m.tags || '[]'); } catch { tags = []; }
  return {
    id:         m.id.slice(0, 8),
    title:      m.title,
    type:       m.type,
    summary:    m.summary || '',
    importance: typeof m.importance === 'number' ? m.importance : 0,
    salience:   typeof m.salience   === 'number' ? m.salience   : 0,
    agent:      m.agent_id || '—',
    vault:      m.vault_path || '—',
    state:      m.salience > 0.3 ? 'final' : 'draft',
    tags,
    promoted:   !!m.vault_path,
    lastSeen:   relative(m.last_accessed || m.created_at),
    decay:      m.salience < 0.2,
    _raw:       m,
  };
}

function relative(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!t) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1)  return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function mapMcpServer(r) {
  return {
    id:             r.id,
    name:           r.name,
    url:            r.url,
    status:         r.status,
    status_detail:  r.status_detail || null,
    enabled:        !!r.enabled,
    transport:      r.transport,
    tools_count:    r.tools_count || 0,
    tools:          Array.isArray(r.tools) ? r.tools : [],
    last_probed_at: r.last_probed_at || null,
    has_headers:    !!r.has_headers,
    _raw:           r,
  };
}

function mapHiveEvent(e) {
  const action = e.action || 'event';
  const tone = action.includes('spawn') ? 'violet'
             : action.includes('memory') ? 'cyan'
             : action.includes('throttl') || action.includes('denied') || action.includes('fallback') ? 'amber'
             : action.includes('error')  ? 'red'
             : 'blue';
  return {
    t:       (e.created_at || '').slice(11, 19) || '—',
    agent:   e.agent_id ? e.agent_id.slice(0, 8) : '—',
    action,
    summary: e.summary || '',
    tone,
    _raw:    e,
  };
}

function mapComm(m) {
  return {
    from:   m.from_name,
    to:     m.to_name,
    msg:    (m.content || '').slice(0, 240),
    resp:   m.response || '—',
    task:   m.task_id || '—',
    status: m.status,
    t:      (m.created_at || '').slice(11, 19) || '—',
    _raw:   m,
  };
}

function mapProvidersFromStatus(status, claude, agents, sessionsCount, queue) {
  const voidaiActive = (status?.model && agents.some(a => a.provider === 'VoidAI')) ? 'online' : 'idle';
  const claudeBackend = claude?.backend === 'claude-cli' ? 'Claude CLI' : 'Anthropic API';
  const claudeStatus = claude?.cliBinaryFound || claude?.anthropicApiKeySet ? 'online' : 'offline';
  return [
    { id: 'voidai',    name: 'VoidAI',         backend: 'router', model: status?.model || '—', status: voidaiActive, queue: 0, errors: 0,                rate: '—' },
    { id: 'cli',       name: claudeBackend,    backend: claude?.backend === 'claude-cli' ? 'local' : 'cloud', model: claude?.cliVersion || '—', status: claudeStatus, queue: claude?.queueLength || 0, errors: claude?.throttled1h || 0, rate: '—' },
    { id: 'mcp',       name: 'MCP Bus',        backend: 'mux',    model: '—',                  status: 'online',     queue: 0, errors: 0,                rate: '—' },
    { id: 'livekit',   name: 'LiveKit',        backend: 'voice',  model: '—',                  status: 'offline',    queue: 0, errors: 0,                rate: '—', soon: true },
    { id: 'eleven',    name: 'ElevenLabs',     backend: 'voice',  model: '—',                  status: 'offline',    queue: 0, errors: 0,                rate: '—', soon: true },
  ];
}

// ── Refresh ────────────────────────────────────────────────────────────────

let lastError = null;
window.NC_LAST_REFRESH = null;

async function refreshAll() {
  const calls = [
    ['agents',     '/api/agents'],
    ['sessions',   '/api/sessions'],
    ['tasks',      '/api/tasks'],
    ['memory',     '/api/memory/index?limit=200'],
    ['hive',       '/api/hive?limit=120'],
    ['comms',      '/api/agent-messages?limit=80'],
    ['logs',       '/api/logs'],
    ['status',     '/api/status'],
    ['claude',     '/api/claude/status'],
    ['models',     '/api/models?provider=voidai'],
    ['spend',      '/api/models/spend'],
    ['memHive',    '/api/memory/hive?limit=40'],
    ['memStats',   '/api/memory/index/stats'],
    ['vaultTree',  '/api/vault/tree'],
    ['config',     '/api/config'],
    ['areas',      '/api/areas'],
    ['heartbeat',  '/api/heartbeat/status'],
    ['mcpServers', '/api/mcp/servers'],
    ['projects',   '/api/projects'],
    ['skills',     '/api/skills?full=1'],
  ];
  // Use Promise.allSettled so a single hanging or rejected endpoint doesn't
  // stall the whole tick. (Promise.all + per-promise .catch should also be
  // safe, but allSettled makes the guarantee explicit and aligns with the
  // per-fetch timeout above.)
  const settled = await Promise.allSettled(
    calls.map(([k, url]) => window.NC_API.get(url).then(d => [k, d]).catch(err => { console.warn(`[NC_LIVE] ${k}:`, err.message); return [k, null]; }))
  );
  const r = Object.fromEntries(settled.map((s, i) => s.status === 'fulfilled' ? s.value : [calls[i][0], null]));
  // Surface a quick summary in the console so we can see what loaded.
  const loaded = Object.entries(r).filter(([, v]) => v != null).map(([k]) => k);
  const failed = Object.entries(r).filter(([, v]) => v == null).map(([k]) => k);
  if (failed.length) console.warn('[NC_LIVE] tick:', loaded.length, 'loaded,', failed.length, 'failed →', failed.join(','));

  // ── AGENTS (with task counts merged) ──
  if (Array.isArray(r.agents)) {
    const tasks = Array.isArray(r.tasks) ? r.tasks : [];
    window.NC_DATA.AGENTS = mergeTasksIntoAgents(r.agents.map(mapAgent), tasks);
  }

  // ── SESSIONS ──
  if (Array.isArray(r.sessions)) {
    window.NC_DATA.SESSIONS = r.sessions.map(mapSession);
  }

  // ── TASKS ──
  if (Array.isArray(r.tasks)) {
    window.NC_DATA.TASKS = r.tasks.map(mapTask);
  }

  // ── PROJECTS (Archon port) ──
  if (Array.isArray(r.projects)) {
    window.NC_DATA.PROJECTS = r.projects.map(mapProject);
  }

  // ── MEMORIES (memory_index, the v1.4+ long-term store) ──
  if (Array.isArray(r.memory)) {
    window.NC_DATA.MEMORIES = r.memory.map(mapMemory);
  }

  // ── HIVE EVENTS ──
  if (Array.isArray(r.hive)) {
    window.NC_DATA.HIVE_EVENTS = r.hive.map(mapHiveEvent);
  }

  // ── COMMS ──
  if (Array.isArray(r.comms)) {
    window.NC_DATA.COMMS = r.comms.map(mapComm);
  }

  // ── LOGS (audit log → terminal viewer) ──
  if (Array.isArray(r.logs)) {
    window.NC_DATA.LOGS = r.logs.slice(0, 80).map(l => ({
      t:   (l.created_at || '').slice(11, 19) || '—',
      lvl: (l.action || '').toUpperCase().includes('DENY') ? 'WARN'
         : (l.action || '').toUpperCase().includes('ERROR') ? 'ERROR'
         : 'INFO',
      src: l.entity_type || 'audit',
      msg: l.action + (l.details ? ' ' + l.details : ''),
    }));
  }

  // ── PROVIDERS (synthesized from status + claude + agents) ──
  if (r.status && r.claude && Array.isArray(r.agents)) {
    window.NC_DATA.PROVIDERS = mapProvidersFromStatus(r.status, r.claude, window.NC_DATA.AGENTS);
  }

  // ── MCP_SERVERS (live, from /api/mcp/servers) ──
  if (r.mcpServers && Array.isArray(r.mcpServers.servers)) {
    window.NC_DATA.MCP_SERVERS = r.mcpServers.servers.map(mapMcpServer);
  }

  // ── SKILLS (file-backed; .claude/skills/*/SKILL.md) ──
  if (Array.isArray(r.skills)) {
    window.NC_DATA.SKILLS = r.skills;
  }

  // ── AREAS (PARA Map) ──
  if (Array.isArray(r.areas)) {
    window.NC_DATA.AREAS = r.areas.map(a => ({
      id:    a.id,
      name:  a.name,
      icon:  a.icon_glyph,
      color: a.color_token,
      order: a.sort_order,
    }));
  }

  // Add area_id to AGENTS so the PARA page can group them.
  if (Array.isArray(r.agents) && Array.isArray(window.NC_DATA.AGENTS)) {
    const byId = Object.fromEntries(r.agents.map(a => [a.id, a.area_id]));
    window.NC_DATA.AGENTS = window.NC_DATA.AGENTS.map(a => ({ ...a, area_id: byId[a._raw?.id ?? a.id] || null }));
  }

  // Heartbeat status — merge into AGENTS so cards can render the indicator.
  if (r.heartbeat && Array.isArray(r.heartbeat.agents) && Array.isArray(window.NC_DATA.AGENTS)) {
    const hb = Object.fromEntries(r.heartbeat.agents.map(a => [a.id, a]));
    window.NC_DATA.AGENTS = window.NC_DATA.AGENTS.map(a => {
      const h = hb[a._raw?.id ?? a.id];
      if (!h) return a;
      return { ...a, heartbeat_status: h.heartbeat_status, heartbeat_latency_ms: h.heartbeat_latency_ms, last_heartbeat_at: h.last_heartbeat_at };
    });
  }

  // ── VAULT TREE ──
  if (r.vaultTree?.tree) {
    window.NC_DATA.VAULT_TREE = r.vaultTree.tree;
  }

  // ── CONFIG (for Settings page) ──
  if (Array.isArray(r.config)) {
    window.NC_DATA.CONFIG = r.config;
  }

  // ── ANALYTICS (synthesized from real spend + agent + memory data) ──
  if (r.spend) {
    const top = (r.spend.byTier || []).map(t => ({ name: t.tier?.toUpperCase() || '—', share: 0 }));
    const lh = r.spend.lastHour || { total_tokens: 0, est_cost_usd: 0, call_count: 0 };
    const totalTokens = lh.total_tokens || 1;
    const providerSplit = (r.spend.byTier || []).map(t => ({
      name: (t.tier || '').toUpperCase(),
      share: t.total_tokens / totalTokens,
      color: t.tier === 'high' ? 'var(--violet)' : t.tier === 'mid' ? 'var(--neon-2)' : 'var(--neon)',
    }));
    window.NC_DATA.ANALYTICS = {
      ...window.NC_DATA.ANALYTICS,    // keep mock sparkline + topTools placeholder
      tokens: lh.total_tokens.toLocaleString(),
      taskStats: {
        ok:    (r.tasks || []).filter(t => t.status === 'done').length,
        fail:  (r.tasks || []).filter(t => t.status === 'failed').length,
        retry: 0,
      },
      c429:        r.claude?.throttled1h || 0,
      providerSplit: providerSplit.length ? providerSplit : window.NC_DATA.ANALYTICS.providerSplit,
      memoryWrites: r.memStats?.lastDay || 0,
      vaultSyncs:   r.memStats?.lastHour || 0,
      spawned:      window.NC_DATA.AGENTS.filter(a => a.temp).length,
      estCostUsd:   lh.est_cost_usd,
      callCount:    lh.call_count,
    };
  }

  window.NC_LAST_REFRESH = Date.now();
  lastError = null;
  window.dispatchEvent(new CustomEvent('nc-data-tick', { detail: { ts: window.NC_LAST_REFRESH } }));
}

// ── Visible status indicator ───────────────────────────────────────────────
// Floats in the bottom-left corner. Click it to force-refresh.

function ensureStatusBadge() {
  if (document.getElementById('nc-live-status')) return document.getElementById('nc-live-status');
  const el = document.createElement('div');
  el.id = 'nc-live-status';
  el.style.cssText = `
    position: fixed; bottom: 8px; left: 8px; z-index: 9999;
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    background: rgba(2,6,23,0.92); color: #00b7ff;
    border: 1px solid rgba(0,183,255,0.4); border-radius: 3px;
    padding: 4px 8px; cursor: pointer; user-select: none;
    box-shadow: 0 0 8px rgba(0,183,255,0.3);
    max-width: 360px;
  `;
  el.title = 'click to force refresh';
  el.addEventListener('click', () => {
    el.textContent = 'LIVE · refreshing…';
    refreshAll().catch(e => { el.style.color = '#fb3b5f'; el.textContent = 'LIVE · ' + e.message; });
  });
  document.body.appendChild(el);
  return el;
}
function setStatus(text, color = '#00b7ff') {
  const el = ensureStatusBadge();
  el.style.color = color;
  el.textContent = text;
}

// ── Public surface for app.jsx ─────────────────────────────────────────────

window.NC_LIVE = {
  refresh: refreshAll,
  async start() {
    setStatus('LIVE · loading…');
    try {
      await refreshAll();
      const a = window.NC_DATA.AGENTS?.length ?? 0;
      const s = window.NC_DATA.SESSIONS?.length ?? 0;
      const m = window.NC_DATA.MEMORIES?.length ?? 0;
      setStatus(`LIVE · ${a} agents · ${s} sessions · ${m} mem · just now`, '#00f5d4');
    } catch (err) {
      lastError = err;
      console.error('[NC_LIVE] initial refresh failed:', err);
      setStatus('LIVE · ERROR · ' + (err.message || err), '#fb3b5f');
    }
    if (this._timer) return;
    this._timer = setInterval(async () => {
      try {
        await refreshAll();
        const a = window.NC_DATA.AGENTS?.length ?? 0;
        const s = window.NC_DATA.SESSIONS?.length ?? 0;
        setStatus(`LIVE · ${a} agents · ${s} sess · ${new Date().toTimeString().slice(0,8)}`, '#00f5d4');
      } catch (err) {
        lastError = err;
        console.warn('[NC_LIVE] tick failed:', err);
        setStatus('LIVE · stale · ' + (err.message || err), '#facc15');
      }
    }, NC_REFRESH_MS);
  },
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
  lastError() { return lastError; },
};

// Auto-start on script load. Defer until DOM ready so the badge can attach.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.NC_LIVE.start());
} else {
  window.NC_LIVE.start();
}

console.log('[NC_LIVE] script loaded; will start on DOM ready');
