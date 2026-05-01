/* Mock data for NeuroClaw */
const NAV = [
  { group: 'CORE', items: [
    { id: 'overview', label: 'Overview', icon: 'overview' },
    { id: 'chat',     label: 'Chat',     icon: 'chat' },
    { id: 'agents',   label: 'Agents',   icon: 'agents' },
    { id: 'para',     label: 'PARA Map', icon: 'para' },
    { id: 'tasks',    label: 'Tasks',    icon: 'tasks' },
    { id: 'sessions', label: 'Sessions', icon: 'sessions' },
  ]},
  { group: 'MEMORY', items: [
    { id: 'memory',   label: 'Memory',     icon: 'memory' },
    { id: 'vault',    label: 'NeuroVault', icon: 'vault' },
    { id: 'dream',    label: 'Dream Cycle',icon: 'dream' },
  ]},
  { group: 'SYSTEM', items: [
    { id: 'hivemind', label: 'Hive Mind',  icon: 'hive' },
    { id: 'comms',    label: 'Comms',      icon: 'comms' },
    { id: 'mcp',      label: 'MCP Tools',  icon: 'mcp' },
    { id: 'providers',label: 'Providers',  icon: 'providers' },
  ]},
  { group: 'OBSERVE', items: [
    { id: 'analytics',label: 'Analytics',  icon: 'analytics' },
    { id: 'logs',     label: 'Logs',       icon: 'logs' },
    { id: 'settings', label: 'Settings',   icon: 'settings' },
  ]},
  { group: 'FUTURE', items: [
    { id: 'discord',  label: 'Discord',    icon: 'discord', soon: true },
    { id: 'voice',    label: 'LiveKit',    icon: 'voice',   soon: true },
  ]},
];

const AGENTS = [
  { id: 'alfred', name: 'Alfred', role: 'Orchestrator', provider: 'Claude CLI', model: 'opus-4.1', status: 'live', exec: true, temp: false, scope: 'global', spawnDepth: 0, tasks: 7, color: 'neon', desc: 'Routes requests, decomposes goals, delegates to specialists.', caps: ['route','plan','memory','exec'] },
  { id: 'researcher', name: 'Researcher', role: 'Knowledge', provider: 'Claude CLI', model: 'sonnet-4', status: 'live', exec: false, temp: false, scope: 'shared', spawnDepth: 0, tasks: 3, color: 'neon2', desc: 'Deep research across web, vault, and ResearchLM.', caps: ['vault_search','web','researchlm'] },
  { id: 'coder', name: 'Coder', role: 'Engineering', provider: 'Anthropic API', model: 'sonnet-4', status: 'busy', exec: true, temp: false, scope: 'project', spawnDepth: 0, tasks: 4, color: 'neon', desc: 'Reads/writes code, runs commands in sandbox.', caps: ['bash_run','edit','test','git'] },
  { id: 'planner', name: 'Planner', role: 'Strategy', provider: 'VoidAI', model: 'haiku-4', status: 'idle', exec: false, temp: false, scope: 'shared', spawnDepth: 0, tasks: 1, color: 'neon2', desc: 'Decomposes large missions into trackable subtasks.', caps: ['plan','schedule','reflect'] },
  { id: 'archivist', name: 'Archivist', role: 'Memory', provider: 'Claude CLI', model: 'haiku-4', status: 'live', exec: false, temp: false, scope: 'global', spawnDepth: 0, tasks: 2, color: 'violet', desc: 'Promotes, prunes and indexes memories nightly.', caps: ['memory','vault_write','dream'] },
  { id: 'debugger-42', name: 'Debugger-42', role: 'Temp Inspector', provider: 'VoidAI', model: 'sonnet-4', status: 'live', exec: true, temp: true, scope: 'session', spawnDepth: 2, tasks: 1, color: 'violet', desc: 'Spawned by Coder. Auto-expires in 11m.', caps: ['exec','log_read'], expires: '11m', parent: 'coder' },
  { id: 'scribe-08', name: 'Scribe-08', role: 'Temp Writer', provider: 'Claude CLI', model: 'haiku-4', status: 'idle', exec: false, temp: true, scope: 'session', spawnDepth: 1, tasks: 0, color: 'violet', desc: 'Spawned by Alfred for transcript cleanup.', caps: ['vault_write'], expires: '4m', parent: 'alfred' },
];

const SESSIONS = [
  { id: 's-1042', title: 'gateway-routing-postmortem', agents: ['alfred','coder','researcher'], msgs: 142, last: '2m ago', active: true },
  { id: 's-1041', title: 'vault-cleanup-2026-04-30', agents: ['archivist'], msgs: 38, last: '1h ago' },
  { id: 's-1040', title: 'morning-brief', agents: ['alfred','researcher'], msgs: 12, last: '6h ago' },
  { id: 's-1039', title: 'mcp-latency-investigation', agents: ['alfred','coder'], msgs: 64, last: '9h ago' },
  { id: 's-1038', title: 'dream-cycle-rem', agents: ['archivist','planner'], msgs: 22, last: '11h ago' },
  { id: 's-1037', title: 'discord:#vaultmind', agents: ['alfred'], msgs: 91, last: '14h ago' },
];

const TASKS = [
  { id: 'T-204', title: 'Trace 429 spike on Claude CLI', agent: 'coder', priority: 'P0', status: 'doing', auto: true, bg: true, eta: '2m', steps: ['fetch logs','grep 429','plot timeline','file ticket'], stepIdx: 1 },
  { id: 'T-205', title: 'Refactor MCP retry policy', agent: 'coder', priority: 'P1', status: 'doing', auto: false, bg: false, eta: '12m', steps: ['read mcp.py','propose patch','test','open PR'], stepIdx: 2 },
  { id: 'T-206', title: 'Summarize today\'s research notes', agent: 'researcher', priority: 'P2', status: 'review', auto: true, bg: false, eta: '—', steps: ['gather','summarize','tag','vault'], stepIdx: 3 },
  { id: 'T-203', title: 'Promote 4 high-salience memories', agent: 'archivist', priority: 'P2', status: 'done', auto: true, bg: true, eta: 'done', steps: ['scan','rank','promote'], stepIdx: 3 },
  { id: 'T-207', title: 'Draft "AgentOS v2 plan"', agent: 'planner', priority: 'P1', status: 'todo', auto: true, bg: false, eta: 'queued', steps: ['outline','draft','review'], stepIdx: 0 },
  { id: 'T-208', title: 'Index new YouTube transcripts', agent: 'researcher', priority: 'P2', status: 'todo', auto: true, bg: true, eta: 'queued', steps: ['fetch','chunk','embed','vault'], stepIdx: 0 },
  { id: 'T-202', title: 'Reconnect VoidAI on cold start', agent: 'alfred', priority: 'P0', status: 'failed', auto: false, bg: false, eta: 'retry', steps: ['ping','reauth'], stepIdx: 1 },
  { id: 'T-209', title: 'Generate weekly insights', agent: 'archivist', priority: 'P2', status: 'review', auto: true, bg: true, eta: '5m', steps: ['gather','wash','insight'], stepIdx: 2 },
];

const MEMORIES = [
  { id: 'M-9931', title: 'Prefer Sonnet for code review tasks', type: 'preference', summary: 'User consistently rates sonnet-4 outputs higher for diff review.', importance: 0.91, salience: 0.84, agent: 'alfred', vault: 'agents/alfred/preferences.md', state: 'final', tags: ['routing','quality'], promoted: true, lastSeen: '12m' },
  { id: 'M-9930', title: 'MCP NeuroVault times out > 8s', type: 'procedural', summary: 'When latency > 8s, retry once then degrade to local cache.', importance: 0.78, salience: 0.62, agent: 'coder', vault: 'procedures/mcp-retry.md', state: 'final', tags: ['mcp','retry'], promoted: false, lastSeen: '34m' },
  { id: 'M-9928', title: 'Mark wants no emoji in agent replies', type: 'preference', summary: 'Strict copy guideline: no emoji unless requested.', importance: 0.95, salience: 0.89, agent: 'alfred', vault: 'agents/alfred/style.md', state: 'final', tags: ['copy'], promoted: true, lastSeen: '2h' },
  { id: 'M-9925', title: 'Researcher session: gateway dashboards', type: 'episodic', summary: 'Compared OpenClaw, AgenticOS, ClaudeClaw layouts.', importance: 0.42, salience: 0.31, agent: 'researcher', vault: 'logs/2026-04-30-research.md', state: 'final', tags: ['ux','research'], promoted: false, lastSeen: '4h' },
  { id: 'M-9921', title: 'Vault index: insights/', type: 'semantic', summary: '184 notes; centroid: AI workflows + memory.', importance: 0.55, salience: 0.41, agent: 'archivist', vault: 'agents/archivist/index.md', state: 'final', tags: ['index'], promoted: false, lastSeen: '11h' },
  { id: 'M-9912', title: 'Decaying chat fragment', type: 'working', summary: 'Active scratch from session s-1039.', importance: 0.18, salience: 0.12, agent: 'alfred', vault: '—', state: 'draft', tags: ['scratch'], promoted: false, lastSeen: '9h', decay: true },
  { id: 'M-9911', title: 'Insight: tool-call latency drives 70% of frustration', type: 'insight', summary: 'Reducing MCP cold-start has the highest UX leverage.', importance: 0.88, salience: 0.79, agent: 'archivist', vault: 'insights/2026-04-29-mcp-latency.md', state: 'final', tags: ['ux','perf'], promoted: true, lastSeen: '1d' },
  { id: 'M-9905', title: 'Session summary: morning-brief', type: 'session', summary: '5 actions, 2 follow-ups, 1 task spawned.', importance: 0.49, salience: 0.34, agent: 'alfred', vault: 'logs/morning-brief.md', state: 'final', tags: ['summary'], promoted: false, lastSeen: '6h' },
];

const HIVE_EVENTS = [
  { t: '22:14:09', agent: 'alfred', action: 'auto_route', summary: 'Routed user msg to coder (conf 0.84)', tone: 'blue' },
  { t: '22:14:05', agent: 'coder',  action: 'spawn_success', summary: 'Spawned debugger-42 (depth 2, ttl 15m)', tone: 'violet' },
  { t: '22:13:51', agent: 'alfred', action: 'memory_saved', summary: '+3 memories (insight, procedural, preference)', tone: 'cyan' },
  { t: '22:13:40', agent: 'researcher', action: 'tool_call', summary: 'researchlm_deep_research → 12 sources', tone: 'cyan' },
  { t: '22:13:22', agent: 'archivist', action: 'vault_sync', summary: 'NeuroVault: 4 notes written, 0 failed', tone: 'green' },
  { t: '22:13:01', agent: 'alfred', action: 'agent_message_sent', summary: 'alfred → researcher: "Pull recent gateway posts"', tone: 'blue' },
  { t: '22:12:49', agent: 'coder', action: 'task_created', summary: 'T-209 weekly insights', tone: 'blue' },
  { t: '22:12:21', agent: 'alfred', action: 'route_fallback', summary: 'VoidAI 503 → fallback claude-cli', tone: 'amber' },
  { t: '22:11:58', agent: 'planner',action: 'background_task_complete', summary: 'T-203 promote memories OK', tone: 'green' },
  { t: '22:11:14', agent: 'alfred', action: 'spawn_denied', summary: 'depth limit reached (3)', tone: 'red' },
  { t: '22:10:09', agent: 'archivist', action: 'dream_cycle_complete', summary: 'wash 38 → extract 12 → promote 4', tone: 'violet' },
];

const COMMS = [
  { from: 'alfred', to: 'researcher', msg: 'Pull recent gateway posts; focus 2026', resp: 'On it. 14 sources queued.', task: 'T-208', status: 'ack', t: '22:13:01' },
  { from: 'alfred', to: 'coder', msg: 'Investigate 429 spike at 21:50', resp: 'Tracing now. Spawning debugger-42.', task: 'T-204', status: 'ack', t: '22:11:30' },
  { from: 'coder', to: 'debugger-42', msg: 'Tail mcp logs, look for retry storms', resp: 'Ack. Streaming.', task: 'T-204', status: 'streaming', t: '22:14:05' },
  { from: 'planner', to: 'alfred', msg: 'Suggesting decomposition for AgentOS v2', resp: 'Approved. Create T-207.', task: 'T-207', status: 'closed', t: '22:09:11' },
  { from: 'archivist', to: 'alfred', msg: 'Dream cycle ready @ 03:00', resp: 'Confirm.', task: '—', status: 'closed', t: '22:00:00' },
];

const MCP_SERVERS = [
  { id: 'neurovault', name: 'NeuroVault', url: 'wss://vault.neuroclaw.local/****', status: 'online', tools: ['vault_search','vault_read_note','vault_create_note','vault_update_note'], lastCall: '12s ago', ok: 1284, fail: 3, latency: 84 },
  { id: 'researchlm', name: 'ResearchLM', url: 'https://research.****.api/v1', status: 'online', tools: ['researchlm_search','researchlm_deep_research'], lastCall: '1m ago', ok: 412, fail: 9, latency: 1240 },
  { id: 'insightslm', name: 'InsightsLM', url: 'https://insights.****.api/v1', status: 'degraded', tools: ['insightslm_search_sources','insightslm_ask_collection'], lastCall: '4m ago', ok: 198, fail: 22, latency: 2180 },
];

const PROVIDERS = [
  { id: 'voidai', name: 'VoidAI', backend: 'router', model: 'sonnet-4 / haiku-4', status: 'online', queue: 2, errors: 0, rate: '12k/min' },
  { id: 'cli', name: 'Claude CLI', backend: 'local', model: 'opus-4.1 / sonnet-4', status: 'online', queue: 5, errors: 1, rate: '—' },
  { id: 'anthropic', name: 'Anthropic API', backend: 'cloud', model: 'sonnet-4', status: 'warn', queue: 0, errors: 3, rate: '4k/min' },
  { id: 'mcp', name: 'MCP Bus', backend: 'mux', model: '—', status: 'online', queue: 1, errors: 0, rate: '—' },
  { id: 'livekit', name: 'LiveKit', backend: 'voice', model: '—', status: 'offline', queue: 0, errors: 0, rate: '—', soon: true },
  { id: 'eleven', name: 'ElevenLabs', backend: 'voice', model: '—', status: 'offline', queue: 0, errors: 0, rate: '—', soon: true },
];

const VAULT_TREE = [
  { name: 'procedures/', children: [
    { name: 'mcp-retry.md' }, { name: 'routing-fallback.md' }, { name: 'memory-promotion.md' },
  ]},
  { name: 'insights/', children: [
    { name: '2026-04-29-mcp-latency.md' }, { name: '2026-04-28-tooluse.md' }, { name: 'weekly-2026-w17.md' },
  ]},
  { name: 'projects/', children: [
    { name: 'neuroclaw/' }, { name: 'agentic-os/' }, { name: 'gateway-redesign/' },
  ]},
  { name: 'agents/', children: [
    { name: 'alfred/' }, { name: 'coder/' }, { name: 'researcher/' }, { name: 'archivist/' },
  ]},
  { name: 'logs/', children: [
    { name: '2026-04-30-research.md' }, { name: '2026-04-30-coder.md' }, { name: 'morning-brief.md' },
  ]},
  { name: 'default/' },
];

const LOGS = [
  { t: '22:14:09.182', lvl: 'INFO',  src: 'router',   msg: 'route alfred→coder confidence=0.842 reason=task_match' },
  { t: '22:14:08.991', lvl: 'INFO',  src: 'mcp',      msg: 'tool=vault_search latency=84ms ok=true' },
  { t: '22:14:07.512', lvl: 'WARN',  src: 'provider', msg: 'anthropic-api 429 retry-after=2s attempt=1/3' },
  { t: '22:14:06.110', lvl: 'INFO',  src: 'spawn',    msg: 'agent=debugger-42 parent=coder depth=2 ttl=900s' },
  { t: '22:14:05.701', lvl: 'INFO',  src: 'memory',   msg: 'wrote M-9931 type=preference importance=0.91' },
  { t: '22:14:05.402', lvl: 'AUDIT', src: 'exec',     msg: 'cmd=ls -la sandbox=/tmp/nc-coder.4 by=coder' },
  { t: '22:14:04.918', lvl: 'INFO',  src: 'hive',     msg: 'auto_route ok agent=alfred conf=0.84' },
  { t: '22:14:03.880', lvl: 'ERROR', src: 'provider', msg: 'voidai connection_reset; failover→claude-cli' },
  { t: '22:14:02.119', lvl: 'INFO',  src: 'mcp',      msg: 'tool=researchlm_deep_research latency=1240ms ok=true' },
  { t: '22:14:01.001', lvl: 'INFO',  src: 'session',  msg: 's-1042 +msg user_id=mark tokens_in=412' },
  { t: '22:13:59.620', lvl: 'WARN',  src: 'memory',   msg: 'salience decay applied to 12 working memories' },
  { t: '22:13:58.118', lvl: 'INFO',  src: 'comms',    msg: 'alfred→researcher "pull recent gateway posts"' },
  { t: '22:13:57.000', lvl: 'INFO',  src: 'router',   msg: 'fallback claude-cli model=opus-4.1' },
  { t: '22:13:55.510', lvl: 'AUDIT', src: 'exec',     msg: 'cmd=git status by=coder ok=0' },
];

const ANALYTICS = {
  msgs: [12,18,22,28,30,40,52,49,58,71,68,82,94,88,102,121,131,128,140,152,160,170,168,182],
  tokens: '4.21M',
  topAgents: [
    { name: 'Alfred', share: 0.42 },
    { name: 'Coder', share: 0.21 },
    { name: 'Researcher', share: 0.18 },
    { name: 'Archivist', share: 0.11 },
    { name: 'Planner', share: 0.08 },
  ],
  topTools: [
    { name: 'vault_search', share: 0.31 },
    { name: 'researchlm_deep_research', share: 0.24 },
    { name: 'bash_run', share: 0.18 },
    { name: 'vault_create_note', share: 0.12 },
    { name: 'insightslm_ask_collection', share: 0.09 },
    { name: 'vault_update_note', share: 0.06 },
  ],
  providerSplit: [
    { name: 'Claude CLI', share: 0.55, color: 'var(--neon)' },
    { name: 'VoidAI', share: 0.28, color: 'var(--neon-2)' },
    { name: 'Anthropic API', share: 0.17, color: 'var(--violet)' },
  ],
  taskStats: { ok: 142, fail: 8, retry: 4 },
  c429: 12,
  routingAccuracy: 0.92,
  spawned: 18,
  memoryWrites: 84,
  vaultSyncs: 31,
};

const DREAM = {
  enabled: true,
  next: '03:00 — in 4h 46m',
  last: { processed: 38, extracted: 12, promoted: 4, insights: 2, plan: true },
  pipeline: ['Raw Chats','Wash','Extract','Categorize','Store','Insight','Tomorrow Plan'],
};

window.NC_DATA = { NAV, AGENTS, SESSIONS, TASKS, MEMORIES, HIVE_EVENTS, COMMS, MCP_SERVERS, PROVIDERS, VAULT_TREE, LOGS, ANALYTICS, DREAM };
