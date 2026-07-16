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

// ── Timestamp helpers ──────────────────────────────────────────────────────
// Old SQLite rows have "YYYY-MM-DD HH:MM:SS" (no T, no Z). new Date() treats
// that as local time — or returns Invalid Date in strict engines. Normalize
// both old and new formats to unambiguous UTC before converting to Pacific.
function parseTS(raw) {
  if (!raw) return null;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function toLA(raw) {
  const d = parseTS(raw);
  return d ? d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true }) : '—';
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

// Per-fetch hard timeout. One hung connection (e.g. dropped TCP, dead vault
// MCP, sleeping laptop) used to wedge Promise.all — leaving NC_DATA frozen
// on its previous state and the dashboard stuck rendering whatever was
// last good (or worse, the mock fallback). 10s ceiling keeps every refresh
// tick bounded.
const FETCH_TIMEOUT_MS = 10000;

// Extract token from URL so API calls work even when the cookie is stale
// or the user opens a new tab without the cookie set yet.
const _NC_TOKEN = new URLSearchParams(location.search).get('token') || '';

function _withToken(path) {
  if (!_NC_TOKEN) return path;
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'token=' + _NC_TOKEN;
}

function fetchWithTimeout(path, init = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  return fetch(_withToken(path), { credentials: 'same-origin', ...init, signal: ctl ? ctl.signal : undefined })
    .finally(() => { if (timer) clearTimeout(timer); });
}

window.NC_API = {
  base: '',
  token: _NC_TOKEN,
  async get(path) {
    const r = await fetchWithTimeout(path);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
  },
  async post(path, body, timeoutMs = FETCH_TIMEOUT_MS) {
    const r = await fetchWithTimeout(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, timeoutMs);
    if (!r.ok) {
      let errMsg = `${r.status} ${r.statusText}: ${path}`;
      try { const d = await r.json(); if (d?.error) errMsg = d.error; } catch { /* not JSON */ }
      throw new Error(errMsg);
    }
    return r.json();
  },
  async patch(path, body) {
    const r = await fetchWithTimeout(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      let errMsg = `${r.status} ${r.statusText}: ${path}`;
      try { const d = await r.json(); if (d?.error) errMsg = d.error; } catch { /* not JSON */ }
      throw new Error(errMsg);
    }
    return r.json();
  },
  async del(path) {
    const r = await fetchWithTimeout(path, { method: 'DELETE' });
    if (!r.ok) {
      let errMsg = `${r.status} ${r.statusText}: ${path}`;
      try { const d = await r.json(); if (d?.error) errMsg = d.error; } catch { /* not JSON */ }
      throw new Error(errMsg);
    }
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
  const PROVIDER_LABELS = {
    anthropic:        a.model_tier && a.model_tier !== 'pinned' ? 'Claude (auto)' : 'Anthropic',
    'claude-gateway': 'Claude Gateway',
    kimi:             'Kimi (native)',
    minimax:          'MiniMax (native)',
    codex:            'Codex CLI',
    gemini:           'Gemini CLI',
    'gemini-api':     'Gemini API',
    antigravity:      'Antigravity',
    'kimi-api':       'Kimi Code API',
    openrouter:       'OpenRouter',
    venice:           'Venice',
    hermes:           'Hermes/Grok',
    ollama:           'Ollama',
    litellm:          'LiteLLM',
    mcp:              'MCP-backed',
    openai:           'VoidAI',
    voidai:           'VoidAI',
  };
  const provider = PROVIDER_LABELS[a.provider] || a.provider || 'VoidAI';
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
    spawnDepth:  a.spawn_depth ?? 0,
    spawn_exempt: !!(a.spawn_exempt),
    tasks:       0,    // filled in by mergeTasksIntoAgents
    color:      a.temporary ? 'violet' : 'neon',
    desc:       a.description || '',
    caps,
    expires:    a.expires_at ? `expires ${toLA(a.expires_at)}` : undefined,
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
    pinned: !!s.pinned,
    status: s.status || 'active',
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
    state:      m.salience > 0.3 ? 'final' : 'draft',
    tags,
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
    t:       toLA(e.created_at),
    agent:   e.agent_name || (e.agent_id ? e.agent_id.slice(0, 8) : '—'),
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
    t:      toLA(m.created_at),
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
let lastCpuSample = null;
window.NC_LAST_REFRESH = null;

// ── Keyed ticks ─────────────────────────────────────────────────────────────
// nc-data-tick carries `detail.keys` — the *result keys* (the first element of
// each _PRIMARY_CALLS/_SECONDARY_CALLS entry, e.g. 'agents', 'providers') that
// just changed. usePageData() uses this to re-render only when its own keys
// change (§3.3 scoped re-renders). The legacy App-level listener ignores
// `keys` and re-renders globally, so this metadata is fully backward-compatible.
const BOOT_KEYS = ['status', 'core', 'claude', 'agents', 'sessions', 'tasks', 'hive', 'notifications'];
function emitTick(detail = {}) {
  window.dispatchEvent(new CustomEvent('nc-data-tick', { detail: { ts: Date.now(), ...detail } }));
}

function mapStatus(status) {
  const cpu = status?.process?.cpuMicros;
  let cpuLoadPct = window.NC_DATA.STATUS?.process?.cpuLoadPct ?? null;
  if (cpu && typeof cpu.user === 'number' && typeof cpu.system === 'number') {
    const sample = { at: Date.now(), totalMicros: cpu.user + cpu.system };
    if (lastCpuSample && sample.at > lastCpuSample.at && sample.totalMicros >= lastCpuSample.totalMicros) {
      const elapsedMs = sample.at - lastCpuSample.at;
      const usedMs = (sample.totalMicros - lastCpuSample.totalMicros) / 1000;
      cpuLoadPct = Math.max(0, Math.min(999, Math.round((usedMs / elapsedMs) * 100)));
    }
    lastCpuSample = sample;
  }
  return {
    ...window.NC_DATA.STATUS,
    ...status,
    process: {
      ...(window.NC_DATA.STATUS?.process || {}),
      ...(status?.process || {}),
      cpuLoadPct,
    },
  };
}

// ── All endpoints split into two priority tiers ────────────────────────────
//
// PRIMARY — small, fast queries that power the sidebar, overview, and agent
// list. These resolve quickly (<200 ms on a local server) and are applied as
// a first wave so the UI drops the "BOOTING" state almost instantly.
//
// SECONDARY — heavier aggregations (analytics, health timelines, 500-row
// memory index, vault tree…). Started at the same moment but their results
// are applied in a second wave after the fast-path tick fires.

const _PRIMARY_CALLS = [
  ['status',        '/api/status'],
  ['core',          '/api/core/status'],
  ['agents',        '/api/agents'],
  ['sessions',      '/api/sessions'],
  ['tasks',         '/api/tasks'],
  ['hive',          '/api/hive?limit=120'],
  ['claude',        '/api/claude/status'],
  ['notifications', '/api/notifications?limit=80'],
];

const _SECONDARY_CALLS = [
  // NC_DATA key-ownership audit (2026-06-16): dropped 4 dead fetches with no
  // live consumer — logs/config (page-logs & page-settings self-fetch),
  // areas (page-para deleted), memHive (never applied). See the audit note.
  ['memory',        '/api/memory/index?limit=500'],
  ['comms',         '/api/agent-messages?limit=80'],
  ['commsNotes',    '/api/comms/notes?limit=80'],
  ['providers',     '/api/providers'],
  ['models',        '/api/models'],
  ['spend',         '/api/models/spend'],
  ['memStats',      '/api/memory/index/stats'],
  ['heartbeat',     '/api/heartbeat/status'],
  ['mcpServers',    '/api/mcp/servers'],
  ['projects',      '/api/projects'],
  ['skills',        '/api/skills?full=1'],
  ['analystAlerts', '/api/analyst/alerts?limit=20'],
  ['dreamHistory',  '/api/dream/history'],
  ['dreamStatus',   '/api/dream/status'],
  ['healthStats',   '/api/analytics/health'],
  ['sparkline',     '/api/analytics/sparkline'],
  ['topTools',      '/api/analytics/tools'],
  ['heatmap',       '/api/analytics/heatmap'],
  ['providerUsage', '/api/analytics/usage?hours=1'],
  ['recentErrors',  '/api/analytics/errors?limit=50'],
  ['healthSummary', '/api/health/summary'],
  ['downtimeEvents','/api/health/downtime?days=7'],
  ['uptimeTimeline','/api/health/timeline?days=7'],
];

// ── applyResults — mutates window.NC_DATA from a partial or full result map ─
// Safe to call twice: first with primary keys only, then with merged full map.

function applyResults(r) {
  if (r.providerUsage) {
    window.NC_DATA.USAGE = r.providerUsage;
  }

  // ── STATUS SNAPSHOT (global header/footer source of truth) ──
  if (r.status) {
    window.NC_DATA.STATUS = mapStatus(r.status);
  }
  if (r.claude) {
    window.NC_DATA.CLAUDE = r.claude;
  }
  if (r.spend) {
    window.NC_DATA.SPEND = r.spend;
  }

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
  // Store total count from stats (not limited by fetch limit)
  if (r.memStats) {
    window.NC_DATA.MEM_STATS = r.memStats;
  }

  // ── HIVE EVENTS ──
  if (Array.isArray(r.hive)) {
    window.NC_DATA.HIVE_EVENTS = r.hive.map(mapHiveEvent);
  }

  // ── DREAM (live run state from hive + history from dreamHistory) ──
  if (Array.isArray(r.hive)) {
    const dreamEvts  = r.hive.filter(e => e.action && e.action.startsWith('dream_'));
    const lastStart  = dreamEvts.find(e => e.action === 'dream_cycle_start');
    const lastDone   = dreamEvts.find(e => e.action === 'dream_cycle_complete' || e.action === 'dream_cycle_failed');
    const isRunning  = !!lastStart && (
      !lastDone ||
      new Date(lastStart.created_at).getTime() > new Date(lastDone.created_at).getTime()
    );
    window.NC_DATA.DREAM = { ...window.NC_DATA.DREAM, running: isRunning, events: dreamEvts };
  }
  if (r.dreamHistory && Array.isArray(r.dreamHistory.history)) {
    const h = r.dreamHistory.history;
    window.NC_DATA.DREAM = {
      ...window.NC_DATA.DREAM,
      history: h,
      last: h.length > 0 ? {
        processed: h[0].scope?.sessionsAnalyzed  ?? window.NC_DATA.DREAM?.last?.processed ?? 0,
        extracted: (h[0].output?.proceduresCreated ?? 0) + (h[0].output?.insightsCreated ?? 0),
        promoted:  h[0].output?.memoriesPromoted   ?? window.NC_DATA.DREAM?.last?.promoted ?? 0,
        insights:  h[0].output?.insightsCreated    ?? window.NC_DATA.DREAM?.last?.insights ?? 0,
        plan:      (h[0].output?.plansCreated ?? 0) > 0,
      } : window.NC_DATA.DREAM?.last,
    };
  }
  if (r.dreamStatus) {
    const rt = r.dreamStatus.runTime ?? '03:00';
    const [hh, mm] = rt.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const diffMs = next - now;
    const diffH  = Math.floor(diffMs / 3600000);
    const diffM  = Math.floor((diffMs % 3600000) / 60000);
    const label  = diffH > 0 ? `${rt} — in ${diffH}h ${diffM}m` : `${rt} — in ${diffM}m`;
    window.NC_DATA.DREAM = { ...window.NC_DATA.DREAM, next: label };
  }

  // ── COMMS ──
  if (Array.isArray(r.comms)) {
    window.NC_DATA.COMMS = r.comms.map(mapComm);
  }
  if (Array.isArray(r.commsNotes)) {
    window.NC_DATA.COMMS_NOTES = r.commsNotes;
  }

  // ── NOTIFICATIONS (agent → user messages) ──
  if (r.notifications && Array.isArray(r.notifications.notifications)) {
    window.NC_DATA.NOTIFICATIONS = r.notifications.notifications;
    window.NC_DATA.NOTIFICATIONS_UNREAD = r.notifications.unreadCount ?? 0;
  }

  // ── LOGS (audit log + hive trace events → terminal viewer) ──
  {
    const TRACE_SRCS = { agent_thought: 'agent-thought', tool_call: 'tool-call', tool_result: 'tool-result', agent_response: 'agent-response' };
    const AUDIT_SRCS = {
      agent_expired: 'cleanup', session_cleaned_up: 'session-cleanup', analytics_pruned: 'session-cleanup',
      task_created: 'task-mgr', task_updated: 'task-mgr',
      db_backup_created: 'db-backup', db_backups_pruned: 'db-backup', db_backup_restored: 'db-backup',
      agent_spawned: 'spawner', skill_install_command: 'dashboard',
      memory_saved: 'memory', memory_indexed: 'memory',
      model_catalog_refresh: 'model-catalog', model_price_override: 'model-catalog', model_tier_override: 'model-catalog',
      skill_script_run: 'skill-runner',
      exec_denied: 'exec', exec_run: 'exec',
      session_started: 'session', session_ended: 'session',
    };
    const auditLogs = Array.isArray(r.logs) ? r.logs.slice(0, 80).map(l => ({
      t:   toLA(l.created_at),
      lvl: (l.action || '').toUpperCase().includes('DENY') ? 'WARN'
         : (l.action || '').toUpperCase().includes('ERROR') ? 'ERROR'
         : 'INFO',
      src: AUDIT_SRCS[l.action] || l.entity_type || 'audit',
      msg: l.action + (l.details ? ' ' + l.details : ''),
    })) : window.NC_DATA.LOGS || [];
    const traceLogs = Array.isArray(r.hive) ? r.hive
      .filter(e => TRACE_SRCS[e.action])
      .slice(0, 40)
      .map(e => ({
        t:   toLA(e.created_at),
        lvl: 'DEBUG',
        src: TRACE_SRCS[e.action],
        msg: e.summary || '',
      })) : [];
    window.NC_DATA.LOGS = [...traceLogs, ...auditLogs].slice(0, 100);
  }

  // ── PROVIDERS ──
  if (Array.isArray(r.providers)) {
    window.NC_DATA.PROVIDERS = r.providers;
  } else if (r.status && r.claude && Array.isArray(r.agents)) {
    window.NC_DATA.PROVIDERS = mapProvidersFromStatus(r.status, r.claude, window.NC_DATA.AGENTS);
  }

  // ── CORE HEALTH (backend-computed router/provider/agent/memory/MCP rollup) ──
  if (r.core && r.core.checks) {
    window.NC_DATA.CORE = r.core;
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

  // ── CONFIG (for Settings page) ──
  if (Array.isArray(r.config)) {
    window.NC_DATA.CONFIG = r.config;
  }

  // ── ANALYTICS (synthesized from real spend + agent + memory data + health stats) ──
  if (r.spend) {
    const lh = r.spend.lastHour || { total_tokens: 0, est_cost_usd: 0, call_count: 0 };
    const totalTokens = lh.total_tokens || 1;
    const providerColors = {
      voidai:      'var(--accent)',
      anthropic:   'var(--accent-2)',
      'claude-cli':'#7dd3fc',
      codex:       'var(--violet)',
      gemini:      '#4ade80',
      'gemini-api': '#4ade80',
      'kimi-api':  '#f97316',
      openrouter:  '#fb923c',
      ollama:      '#a78bfa',
    };
    const providerNames = {
      voidai:      'VoidAI',
      anthropic:   'Anthropic API',
      'claude-cli':'Claude CLI',
      codex:       'Codex CLI',
      gemini:      'Gemini CLI',
      'gemini-api': 'Gemini API',
      'kimi-api':  'Kimi Code API',
      openrouter:  'OpenRouter',
      ollama:      'Ollama',
      litellm:     'LiteLLM',
    };
    const puRows = r.providerUsage?.byProvider ?? [];
    const puTotal = puRows.reduce((s, p) => s + p.total_tokens, 1);
    const providerSplit = puRows.length > 0
      ? puRows.map(p => ({
          name:  providerNames[p.provider] || p.provider,
          share: p.total_tokens / puTotal,
          color: providerColors[p.provider] || 'var(--muted)',
        }))
      : (r.spend.byTier || []).map(t => ({
          name:  (t.tier || '').toUpperCase(),
          share: t.total_tokens / totalTokens,
          color: t.tier === 'high' ? 'var(--violet)' : t.tier === 'mid' ? 'var(--accent-2)' : 'var(--accent)',
        }));

    // Build message sparkline from real data
    const sparklineData = Array.isArray(r.sparkline)
      ? r.sparkline.map(d => d.count)
      : window.NC_DATA.ANALYTICS?.msgs || [];

    // Build top tools from real data
    const topToolsData = Array.isArray(r.topTools)
      ? r.topTools.map(t => ({ name: t.tool, count: t.count }))
      : window.NC_DATA.ANALYTICS?.topTools || [];

    // Build heatmap from real data
    const heatmapData = Array.isArray(r.heatmap)
      ? r.heatmap.map(h => ({ day: h.dayOfWeek, hour: h.hour, count: h.count }))
      : window.NC_DATA.ANALYTICS?.heatmap || [];

    window.NC_DATA.ANALYTICS = {
      ...window.NC_DATA.ANALYTICS,
      msgs: sparklineData,
      topTools: topToolsData,
      heatmap: heatmapData,
      tokens: lh.total_tokens.toLocaleString(),
      taskStats: {
        ok:    (r.tasks || []).filter(t => t.status === 'done').length,
        fail:  (r.tasks || []).filter(t => t.status === 'failed').length,
        retry: 0,
      },
      c429:          r.claude?.throttled1h || 0,
      providerSplit: providerSplit.length ? providerSplit : window.NC_DATA.ANALYTICS.providerSplit,
      memoryWrites:  r.memStats?.lastDay  || 0,
      memWritesHour: r.memStats?.lastHour || 0,
      spawned:       window.NC_DATA.AGENTS.filter(a => a.temp).length,
      estCostUsd:    lh.est_cost_usd,
      callCount:     lh.call_count,
    };
  }

  // ── SYSTEM HEALTH STATS (errors, disconnects, restarts) ──
  if (r.healthStats) {
    window.NC_DATA.HEALTH_STATS = r.healthStats;
    window.NC_DATA.ANALYTICS = {
      ...window.NC_DATA.ANALYTICS,
      serverErrors24h:  r.healthStats.server_errors_24h || 0,
      discordConnects:  r.healthStats.discord_connects  || 0,
      discordErrors24h: r.healthStats.discord_errors_24h || 0,
      discordRestarts:  r.healthStats.discord_restarts  || 0,
      heartbeatOkRate:  r.healthStats.heartbeat_ok_rate ?? 100,
      logErrors24h:     r.healthStats.log_errors_24h    || 0,
      logWarnings24h:   r.healthStats.log_warnings_24h  || 0,
      errorsBySource:   r.healthStats.errors_by_source  || [],
      discordEvents:    r.healthStats.discord_events     || [],
      heartbeatHistory: r.healthStats.heartbeat_history  || [],
    };
  }

  // ── RECENT ERRORS ──
  if (Array.isArray(r.recentErrors)) {
    window.NC_DATA.RECENT_ERRORS = r.recentErrors;
  }

  // ── HEALTH ──
  if (r.healthSummary || r.downtimeEvents || r.uptimeTimeline) {
    window.NC_DATA.HEALTH = {
      summary:  r.healthSummary  ?? window.NC_DATA.HEALTH?.summary  ?? null,
      downtime: r.downtimeEvents ?? window.NC_DATA.HEALTH?.downtime ?? [],
      timeline: r.uptimeTimeline ?? window.NC_DATA.HEALTH?.timeline ?? [],
    };
  }

  // ── ANALYST ALERTS (Stephanie) ──
  if (Array.isArray(r.analystAlerts)) {
    window.NC_DATA.ANALYST_ALERTS = r.analystAlerts;
  }
}

// ── Two-phase refresh ──────────────────────────────────────────────────────
// All fetches fire simultaneously. When the fast PRIMARY_CALLS settle we
// immediately apply their results and dispatch an early nc-data-tick so the
// sidebar stops showing "BOOTING" within ~200 ms. The heavier secondary calls
// (analytics, memory index, health timelines…) apply in a second wave.

async function refreshAll() {
  // Helper: fetch one endpoint, return [key, data|null]
  async function fetchOne([k, url]) {
    try { return [k, await window.NC_API.get(url)]; }
    catch (err) { console.warn(`[NC_LIVE] ${k}:`, err.message); return [k, null]; }
  }

  // Kick off ALL fetches simultaneously so secondary ones don't wait for primary.
  const primaryPromises   = _PRIMARY_CALLS.map(fetchOne);
  const secondaryPromises = _SECONDARY_CALLS.map(fetchOne);

  // ── Ultra-early tick: drop BOOTING the moment /api/core/status returns ──
  // The primary wave waits for ALL 8 calls before firing. /api/core/status is
  // the only call that clears CORE.state from 'booting' → 'awake', so we
  // attach a .then() so it fires immediately without waiting for slower peers
  // (e.g. /api/hive with 120 rows).
  const coreIdx = _PRIMARY_CALLS.findIndex(([k]) => k === 'core');
  if (coreIdx >= 0) {
    primaryPromises[coreIdx].then(([k, data]) => {
      if (data && data.checks) {
        applyResults({ [k]: data });
        emitTick({ partial: true, keys: ['core'] });
      }
    }).catch(() => {});
  }

  // ── Wave 1: fast-path ──────────────────────────────────────────────────
  const primarySettled = await Promise.allSettled(primaryPromises);
  const r1 = Object.fromEntries(
    primarySettled.map((s, i) => s.status === 'fulfilled' ? s.value : [_PRIMARY_CALLS[i][0], null])
  );

  applyResults(r1);
  window.NC_DATA.LIVE_META = { refreshedAt: Date.now(), loaded: Object.keys(r1).filter(k => r1[k] != null), failed: [], partial: true };
  window.NC_LAST_REFRESH = Date.now();
  emitTick({ partial: true, keys: _PRIMARY_CALLS.map(([k]) => k) });

  // ── Wave 2: full dataset ───────────────────────────────────────────────
  const secondarySettled = await Promise.allSettled(secondaryPromises);
  const r2 = Object.fromEntries(
    secondarySettled.map((s, i) => s.status === 'fulfilled' ? s.value : [_SECONDARY_CALLS[i][0], null])
  );

  const r = { ...r1, ...r2 };
  applyResults(r);

  const loaded = Object.entries(r).filter(([, v]) => v != null).map(([k]) => k);
  const failed = Object.entries(r).filter(([, v]) => v == null).map(([k]) => k);
  if (failed.length) console.warn('[NC_LIVE] tick:', loaded.length, 'loaded,', failed.length, 'failed →', failed.join(','));

  window.NC_DATA.LIVE_META = { refreshedAt: Date.now(), loaded, failed };
  window.NC_LAST_REFRESH = Date.now();
  lastError = null;
  emitTick({ keys: Object.keys(r) });

  // Persist CORE state so new tabs restore it instantly (no BOOTING flash).
  const core = window.NC_DATA.CORE;
  if (core && core.state && core.state !== 'booting') {
    try { localStorage.setItem('nc_core_cache', JSON.stringify({ core, savedAt: Date.now() })); } catch { /* quota */ }
  }
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
    background: rgba(2,6,23,0.92); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 3px;
    padding: 4px 8px; cursor: pointer; user-select: none;
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 30%, transparent);
    max-width: 360px;
  `;
  el.title = 'click to force refresh';
  el.addEventListener('click', () => {
    el.textContent = 'LIVE · refreshing…';
    refreshAll().catch(e => { el.style.color = 'var(--danger)'; el.textContent = 'LIVE · ' + e.message; });
  });
  document.body.appendChild(el);
  return el;
}
function setStatus(text, color = 'var(--accent)') {
  const el = ensureStatusBadge();
  el.style.color = color;
  el.textContent = text;
}

// ── Public surface for app.jsx ─────────────────────────────────────────────

// Secondary-only refresh (analytics, memory, vault, etc.) — runs every 120s
// as a background sweep for data the SSE stream doesn't push.
const _SECONDARY_ONLY = _SECONDARY_CALLS;
async function refreshSecondary() {
  const results = await Promise.allSettled(_SECONDARY_ONLY.map(([k, url]) =>
    window.NC_API.get(url).then(d => [k, d]).catch(() => [k, null])
  ));
  const r = Object.fromEntries(results.map(s => s.status === 'fulfilled' ? s.value : [null, null]).filter(([k]) => k));
  applyResults(r);
  window.NC_DATA.LIVE_META = { ...window.NC_DATA.LIVE_META, refreshedAt: Date.now() };
  window.NC_LAST_REFRESH = Date.now();
  emitTick({ keys: Object.keys(r) });
}

window.NC_LIVE = {
  refresh: refreshAll,
  _sse: null,
  _sseFailures: 0,

  _applySSEEvent(msg) {
    if (msg.type === 'snapshot') {
      applyResults(msg);
      window.NC_DATA.LIVE_META = { refreshedAt: Date.now(), loaded: ['core','agents','sessions','tasks','hive','notifications','status'], failed: [], partial: false };
      window.NC_LAST_REFRESH = Date.now();
      emitTick({ keys: BOOT_KEYS });
      // Persist CORE so subsequent tabs start with real state
      const core = window.NC_DATA.CORE;
      if (core && core.state && core.state !== 'booting') {
        try { localStorage.setItem('nc_core_cache', JSON.stringify({ core, savedAt: Date.now() })); } catch { /* quota */ }
      }
      setStatus(`LIVE · ${window.NC_DATA.AGENTS?.length ?? 0} agents · stream`, 'var(--accent-2)');
    } else if (msg.type === 'agents') {
      applyResults({ agents: msg.agents, tasks: window.NC_DATA.TASKS });
      emitTick({ keys: ['agents'] });
    } else if (msg.type === 'tasks') {
      applyResults({ tasks: msg.tasks });
      emitTick({ keys: ['tasks', 'agents'] });
    } else if (msg.type === 'hive_event') {
      if (msg.event) window.NC_DATA.HIVE_EVENTS = [mapHiveEvent(msg.event), ...(window.NC_DATA.HIVE_EVENTS || [])].slice(0, 120);
      emitTick({ keys: ['hive'] });
    } else if (msg.type === 'notification') {
      if (msg.notification) {
        window.NC_DATA.NOTIFICATIONS = [msg.notification, ...(window.NC_DATA.NOTIFICATIONS || [])].slice(0, 80);
        window.NC_DATA.NOTIFICATIONS_UNREAD = (window.NC_DATA.NOTIFICATIONS_UNREAD || 0) + 1;
        emitTick({ keys: ['notifications'] });
      }
    } else if (msg.type === 'core_update') {
      applyResults({ core: msg.core, status: msg.status });
      emitTick({ keys: ['core', 'status'] });
    }
  },

  _startSSE() {
    if (this._sse) { try { this._sse.close(); } catch { /**/ } }
    const url = _withToken('/api/state/stream');
    const es = new EventSource(url);
    this._sse = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this._applySSEEvent(msg);
        this._sseFailures = 0;
      } catch { /**/ }
    };

    es.onerror = () => {
      this._sseFailures++;
      if (this._sseFailures >= 3 && !this._timer) {
        // SSE persistently failing — fall back to polling
        console.warn('[NC_LIVE] SSE failed 3x, falling back to polling');
        setStatus('LIVE · polling fallback', 'var(--amber)');
        this._timer = setInterval(async () => {
          try { await refreshAll(); }
          catch (err) { console.warn('[NC_LIVE] poll tick failed:', err); }
        }, NC_REFRESH_MS);
      }
    };
  },

  async start() {
    // Restore last known CORE state so new tabs never flash BOOTING.
    try {
      const raw = localStorage.getItem('nc_core_cache');
      if (raw) {
        const { core, savedAt } = JSON.parse(raw);
        if (core && core.state && core.state !== 'booting' && Date.now() - savedAt < 600_000) {
          window.NC_DATA.CORE = core;
          window.dispatchEvent(new CustomEvent('nc-data-tick', { detail: { ts: savedAt, partial: true } }));
        }
      }
    } catch { /**/ }

    setStatus('LIVE · connecting…');

    // ── Boot snapshot: one aggregated call for instant first paint (§3.1) ──
    // The SSE stream takes over for ongoing updates the moment it connects.
    // If /api/boot is unavailable (older server), fall back to the 8 individual
    // primary calls — so this is always safe and never blocks the stream.
    try {
      const boot = await window.NC_API.get('/api/boot');
      applyResults(boot);
      window.NC_DATA.LIVE_META = {
        refreshedAt: Date.now(),
        loaded: Object.keys(boot).filter(k => boot[k] != null),
        failed: [], partial: true,
      };
      window.NC_LAST_REFRESH = Date.now();
      emitTick({ partial: true, keys: BOOT_KEYS });
      const core = window.NC_DATA.CORE;
      if (core && core.state && core.state !== 'booting') {
        try { localStorage.setItem('nc_core_cache', JSON.stringify({ core, savedAt: Date.now() })); } catch { /* quota */ }
      }
    } catch (err) {
      console.warn('[NC_LIVE] /api/boot unavailable, falling back to individual primaries:', err.message);
      await refreshAll().catch(() => {});
    }

    this._startSSE();

    // Secondary data (analytics, memory, vault…) — not pushed by SSE, poll every 120s.
    if (!this._secTimer) {
      // Fire once after initial SSE snapshot has a moment to land, then on interval.
      setTimeout(() => refreshSecondary().catch(() => {}), 3000);
      this._secTimer = setInterval(() => refreshSecondary().catch(() => {}), 120_000);
    }
  },
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
  lastError() { return lastError; },
};

// ── usePageData — page-owned data fetching (Dashboard v3 §3.2) ──────────────
// A page declares the endpoints it needs (keyed by *result key* — the same
// names applyResults() and _SECONDARY_CALLS use, e.g. 'providers', 'spend'):
//
//   const d = usePageData({ providers: '/api/providers', spend: '/api/models/spend' });
//   // read d.PROVIDERS, d.SPEND ...
//
// Behaviour:
//   • fetches on mount, runs each result through the existing applyResults mapper
//   • serves the NC_DATA cache instantly on revisit; re-fetches only if stale
//     (>refreshMs, default 60s) so tab-switching is instant
//   • re-renders when ITS keys change (keyed nc-data-tick) — falls back to
//     re-rendering on every tick when a tick carries no `keys` (back-compat)
//
// Until Phase 4 wires pages to this + deletes the 120s secondary sweep, the
// sweep keeps these keys fresh too; the two coexist safely (cache de-dupes).
window.NC_DATA._pageMeta = window.NC_DATA._pageMeta || {};
function usePageData(spec, opts = {}) {
  const refreshMs = opts.refreshMs ?? 60000;
  const resultKeys = Object.keys(spec);
  const [, force] = React.useReducer((x) => x + 1, 0);

  React.useEffect(() => {
    let alive = true;
    const meta = window.NC_DATA._pageMeta;

    async function load(forceFresh) {
      await Promise.all(Object.entries(spec).map(async ([k, url]) => {
        if (!forceFresh && meta[k] && Date.now() - meta[k] < refreshMs) return; // fresh cache
        try {
          const d = await window.NC_API.get(url);
          applyResults({ [k]: d });
          meta[k] = Date.now();
        } catch (e) { console.warn('[usePageData]', k, e.message); }
      }));
      if (alive) force();
    }
    load(false);

    const onTick = (e) => {
      const keys = e.detail && e.detail.keys;
      if (!keys || keys.some((x) => resultKeys.includes(x))) force();
    };
    window.addEventListener('nc-data-tick', onTick);
    const timer = refreshMs ? setInterval(() => load(true), refreshMs) : null;
    return () => {
      alive = false;
      window.removeEventListener('nc-data-tick', onTick);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spec), refreshMs]);

  return window.NC_DATA;
}
window.usePageData = usePageData;

// Auto-start on script load. Defer until DOM ready so the badge can attach.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.NC_LIVE.start());
} else {
  window.NC_LIVE.start();
}

console.log('[NC_LIVE] script loaded; will start on DOM ready');
