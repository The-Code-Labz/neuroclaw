export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>NeuroClaw v1</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;
  --border:#30363d;--text:#c9d1d9;--muted:#8b949e;
  --blue:#58a6ff;--green:#3fb950;--yellow:#d29922;
  --red:#f85149;--purple:#bc8cff;--orange:#ffa657;
}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;font-size:14px}
/* sidebar */
#sidebar{width:210px;min-height:100vh;background:var(--bg2);border-right:1px solid var(--border);padding:20px 0;flex-shrink:0;position:fixed;top:0;left:0;bottom:0;overflow-y:auto}
.logo{padding:0 20px 18px;border-bottom:1px solid var(--border);margin-bottom:12px}
.logo h1{font-size:15px;font-weight:700;color:var(--blue)}
.logo p{font-size:11px;color:var(--muted);margin-top:3px}
nav a{display:flex;align-items:center;gap:9px;padding:9px 20px;color:var(--muted);text-decoration:none;font-size:13px;transition:.12s;border-left:3px solid transparent;cursor:pointer;user-select:none}
nav a:hover{color:var(--text);background:var(--bg3)}
nav a.active{color:var(--blue);background:rgba(88,166,255,.08);border-left-color:var(--blue)}
/* main */
#main{margin-left:210px;flex:1;padding:24px;min-height:100vh;display:flex;flex-direction:column}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;padding-bottom:14px;border-bottom:1px solid var(--border);flex-shrink:0}
.page-header h2{font-size:19px;font-weight:600}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* buttons */
.btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;cursor:pointer;transition:.12s;user-select:none}
.btn:hover{background:var(--border)}
.btn-primary{background:var(--blue);color:#0d1117;border-color:var(--blue);font-weight:600}
.btn-primary:hover{opacity:.85}
.btn-danger{background:rgba(248,81,73,.14);color:var(--red);border-color:rgba(248,81,73,.3)}
.btn-danger:hover{background:rgba(248,81,73,.25)}
.btn-sm{padding:4px 10px;font-size:12px}
.btn:disabled{opacity:.4;cursor:not-allowed}
/* cards */
.card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:18px}
.card-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:6px}
.card-value{font-size:26px;font-weight:700}
.card-sub{font-size:11px;color:var(--muted);margin-top:4px}
/* grid */
.grid4{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;margin-bottom:20px}
/* tables */
.tbl-wrap{overflow-x:auto;border-radius:8px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead{background:var(--bg3)}
th{padding:9px 14px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
td{padding:9px 14px;border-top:1px solid var(--border);vertical-align:top;max-width:360px;overflow:hidden;text-overflow:ellipsis}
tr:hover td{background:rgba(255,255,255,.02)}
/* badges */
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.bg{background:rgba(63,185,80,.14);color:var(--green)}
.bb{background:rgba(88,166,255,.14);color:var(--blue)}
.by{background:rgba(210,153,34,.14);color:var(--yellow)}
.br{background:rgba(248,81,73,.14);color:var(--red)}
.bp{background:rgba(188,140,255,.14);color:var(--purple)}
.bo{background:rgba(255,166,87,.14);color:var(--orange)}
/* sections */
.section{display:none;flex:1;flex-direction:column}
.section.active{display:flex}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px;background:var(--green);box-shadow:0 0 6px var(--green)}
.muted{color:var(--muted);font-size:12px}
.mono{font-family:'Cascadia Code',Consolas,monospace;font-size:12px}
.pre{white-space:pre-wrap;word-break:break-word;font-family:'Cascadia Code',Consolas,monospace;font-size:12px;background:var(--bg);padding:10px;border-radius:6px;border:1px solid var(--border);max-height:180px;overflow-y:auto;margin-top:8px}
#ri{font-size:12px;color:var(--muted)}
/* select */
select{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;outline:none}
select:focus{border-color:var(--blue)}
/* config live indicator */
#cfg-live{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
#cfg-live .ldot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green)}
#cfg-live .ldot.off{background:var(--muted);box-shadow:none}
/* toast */
#toast{position:fixed;bottom:20px;right:20px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 16px;font-size:13px;color:var(--text);display:none;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.4)}
#toast.show{display:block}
/* ── Chat ─────────────────────────────────────────────────────────────────── */
#s-chat{height:calc(100vh - 48px)}
.chat-wrap{display:flex;flex-direction:column;flex:1;min-height:0;gap:0}
.chat-toolbar{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--border);margin-bottom:0;flex-shrink:0;flex-wrap:wrap}
.chat-toolbar label{font-size:12px;color:var(--muted)}
#chat-session-id{font-size:11px;color:var(--muted);font-family:monospace;padding:3px 8px;background:var(--bg3);border-radius:4px;border:1px solid var(--border)}
.chat-messages{flex:1;overflow-y:auto;padding:16px 0;display:flex;flex-direction:column;gap:14px;min-height:0}
.msg{display:flex;flex-direction:column;gap:4px;max-width:75%}
.msg.user{align-self:flex-end;align-items:flex-end}
.msg.assistant{align-self:flex-start;align-items:flex-start}
.msg-who{font-size:11px;font-weight:600;color:var(--muted);padding:0 4px}
.msg-bubble{padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap}
.msg.user .msg-bubble{background:var(--blue);color:#0d1117;border-bottom-right-radius:3px}
.msg.assistant .msg-bubble{background:var(--bg3);border:1px solid var(--border);border-bottom-left-radius:3px}
.msg.assistant.streaming .msg-bubble::after{content:'●';animation:blink .7s infinite;margin-left:4px;color:var(--muted)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.chat-hint{font-size:11px;color:var(--muted);padding:2px 4px}
.chat-input-row{display:flex;gap:8px;padding-top:14px;border-top:1px solid var(--border);flex-shrink:0;flex-direction:column}
.chat-input-meta{display:flex;justify-content:space-between;align-items:center}
.chat-input-inner{display:flex;gap:8px}
#chat-input{flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px;resize:none;outline:none;font-family:inherit;line-height:1.5;min-height:44px;max-height:160px}
#chat-input:focus{border-color:var(--blue)}
#chat-send{align-self:flex-end}
.chat-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px}
/* ── Modals ────────────────────────────────────────────────────────────────── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:1000}
.modal{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:24px;width:540px;max-width:95vw;max-height:88vh;overflow-y:auto}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.modal-header h3{font-size:16px;font-weight:600}
.field{margin-bottom:14px}
.field label{display:block;font-size:11px;font-weight:600;color:var(--muted);margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em}
.field input,.field textarea,.field select{width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit}
.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--blue)}
.field textarea{resize:vertical;min-height:80px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}
/* ── Agent cards ──────────────────────────────────────────────────────────── */
.agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.agent-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:10px}
.agent-card.inactive{opacity:.55}
.agent-card.temporary{border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.04)}
.agent-header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.agent-name{font-size:15px;font-weight:700}
.agent-meta{font-size:11px;color:var(--muted)}
.caps{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.agent-actions{display:flex;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--border)}
/* ── Hive / Chat meta events ─────────────────────────────────────────────── */
.msg.meta{align-self:flex-start;margin-bottom:-4px;max-width:90%}
.msg-meta{font-size:11px;color:var(--muted);padding:3px 10px;background:rgba(88,166,255,.07);border-radius:10px;border:1px solid rgba(88,166,255,.14);display:inline-block}
.msg-meta.route{background:rgba(63,185,80,.07);border-color:rgba(63,185,80,.2)}
.msg-meta.spawn{background:rgba(188,140,255,.07);border-color:rgba(188,140,255,.2);color:var(--purple)}
</style>
</head>
<body>
<aside id="sidebar">
  <div class="logo"><h1>⚡ NeuroClaw</h1><p>v1 Dashboard</p></div>
  <nav>
    <a data-s="overview"  class="active">📊 Overview</a>
    <a data-s="chat">💬 Chat</a>
    <a data-s="agents">🤖 Agents</a>
    <a data-s="tasks">📋 Tasks<span id="tasks-badge" style="display:none;margin-left:6px;background:var(--red);color:#fff;border-radius:9px;font-size:10px;padding:1px 6px;vertical-align:middle">0</span></a>
    <a data-s="sessions">🗂 Sessions</a>
    <a data-s="memory">🧠 Memory</a>
    <a data-s="config">⚙️ Config</a>
    <a data-s="analytics">📈 Analytics</a>
    <a data-s="hive">🌐 Hive Mind</a>
    <a data-s="comms">💌 Comms</a>
    <a data-s="logs">📜 Logs</a>
  </nav>
</aside>

<main id="main">

  <!-- Overview -->
  <div id="s-overview" class="section active">
    <div class="page-header">
      <h2>Overview</h2>
      <div class="actions"><span id="ri">Auto-refresh: 30s</span><button class="btn btn-primary" onclick="refresh()">↻ Refresh</button></div>
    </div>
    <div class="grid4" id="ov-stats"></div>
  </div>

  <!-- Chat -->
  <div id="s-chat" class="section">
    <div class="page-header">
      <h2>Chat</h2>
      <div class="actions">
        <label>Agent:</label>
        <select id="chat-agent"></select>
        <label style="margin-left:12px">Session:</label>
        <select id="chat-session-select" onchange="loadSession(this.value)"></select>
        <button class="btn btn-sm btn-primary" onclick="newChat()">+ New Chat</button>
      </div>
    </div>
    <div class="chat-wrap">
      <div class="chat-toolbar">
        <span class="muted">Session ID:</span>
        <span id="chat-session-id">—</span>
        <button class="btn btn-sm" style="margin-left:8px" onclick="renameSession()">Rename</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCurrentSession()">Delete</button>
        <span class="chat-hint" style="margin-left:auto">Tip: prefix with @AgentName to delegate</span>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-empty" id="chat-empty">Select a session or start a new chat</div>
      </div>
      <div class="chat-input-row">
        <div class="chat-input-inner">
          <textarea id="chat-input" rows="1" placeholder="Type a message… (Enter to send, Shift+Enter for newline, @AgentName to delegate)"></textarea>
          <button class="btn btn-primary" id="chat-send" onclick="sendChat()">Send ↑</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Agents -->
  <div id="s-agents" class="section">
    <div class="page-header">
      <h2>Agents</h2>
      <div class="actions">
        <div id="agent-filter" style="display:flex;gap:4px">
          <button class="btn btn-sm btn-primary" data-filter="all"      onclick="filterAgents('all')">All</button>
          <button class="btn btn-sm"              data-filter="active"   onclick="filterAgents('active')">Active</button>
          <button class="btn btn-sm"              data-filter="temp"     onclick="filterAgents('temp')">Temp</button>
          <button class="btn btn-sm"              data-filter="inactive" onclick="filterAgents('inactive')">Inactive</button>
        </div>
        <button class="btn btn-primary" onclick="openNewAgent()">+ New Agent</button>
        <button class="btn" onclick="load('agents')">↻ Refresh</button>
      </div>
    </div>
    <div class="agent-grid" id="ag-list"></div>
  </div>

  <!-- Tasks -->
  <div id="s-tasks" class="section">
    <div class="page-header">
      <h2>Tasks</h2>
      <div class="actions">
        <button class="btn btn-primary" onclick="openNewTask()">+ New Task</button>
        <button class="btn" onclick="load('tasks')">↻ Refresh</button>
      </div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Title</th><th>Status</th><th>Agent</th><th>Priority</th><th>Actions</th><th>Created</th></tr></thead>
        <tbody id="tb-tasks"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Sessions -->
  <div id="s-sessions" class="section">
    <div class="page-header"><h2>Sessions</h2><button class="btn btn-primary" onclick="load('sessions')">↻ Refresh</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>ID</th><th>Title</th><th>Msgs</th><th>Status</th><th>Created</th></tr></thead>
    <tbody id="tb-sessions"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
  </div>

  <!-- Memory -->
  <div id="s-memory" class="section">
    <div class="page-header">
      <h2>Memory</h2>
      <div class="actions">
        <button class="btn btn-primary" onclick="openAddMemory()">+ Add Memory</button>
        <button class="btn" onclick="load('memory')">↻ Refresh</button>
      </div>
    </div>

    <!-- Long-term memory (v1.4+) -->
    <h3 style="margin-top:12px;margin-bottom:8px;color:var(--text-dim)">Long-term memory (memory_index)</h3>
    <div id="ov-memory-stats" class="grid" style="margin-bottom:12px"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <label style="margin:0;font-size:12px;color:var(--text-dim)">Filter:</label>
      <select id="mi-filter" onchange="loadMemoryIndex()" style="width:auto;padding:4px 8px">
        <option value="">All types</option>
        <option value="procedural">Procedural</option>
        <option value="insight">Insights</option>
        <option value="semantic">Semantic</option>
        <option value="episodic">Episodic</option>
        <option value="preference">Preferences</option>
        <option value="session_summary">Session summaries</option>
        <option value="project">Projects</option>
        <option value="working">Working</option>
      </select>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>Type</th><th>Title</th><th>Imp</th><th>Sal</th><th>Vault</th><th>Last accessed</th><th>Actions</th></tr></thead>
    <tbody id="tb-memory-index"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody></table></div>

    <h3 style="margin-top:24px;margin-bottom:8px;color:var(--text-dim)">Recent memory events</h3>
    <div class="tbl-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Summary</th><th>Agent</th></tr></thead>
    <tbody id="tb-memory-hive"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>

    <h3 style="margin-top:24px;margin-bottom:8px;color:var(--text-dim)">Legacy memory store</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Content</th><th>Type</th><th>Importance</th><th>Created</th><th>Actions</th></tr></thead>
    <tbody id="tb-memory"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
  </div>

  <!-- Memory Modal -->
  <div id="memory-modal" class="modal-overlay" style="display:none">
    <div class="modal">
      <div class="modal-header"><h3>Add Memory</h3><button class="btn btn-sm" onclick="closeModal('memory')">✕</button></div>
      <div class="field"><label>Content</label><textarea id="mf-content" rows="4" placeholder="The memory content..."></textarea></div>
      <div class="field"><label>Type</label>
        <select id="mf-type">
          <option value="general">General</option>
          <option value="fact">Fact</option>
          <option value="preference">Preference</option>
          <option value="context">Context</option>
          <option value="summary">Summary</option>
        </select>
      </div>
      <div class="field"><label>Importance (1-10)</label><input type="number" id="mf-importance" min="1" max="10" value="5"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal('memory')">Cancel</button>
        <button class="btn btn-primary" onclick="submitMemory()">Save Memory</button>
      </div>
    </div>
  </div>

  <!-- Config -->
  <div id="s-config" class="section">
    <div class="page-header">
      <h2>Config</h2>
      <div class="actions">
        <span id="cfg-live"><span class="ldot off"></span>Watching .env</span>
        <button class="btn btn-primary" onclick="load('config')">↻ Refresh</button>
      </div>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>Key</th><th>Value</th><th>Description</th><th>Updated</th></tr></thead>
    <tbody id="tb-config"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
  </div>

  <!-- Analytics -->
  <div id="s-analytics" class="section">
    <div class="page-header"><h2>Analytics</h2><button class="btn btn-primary" onclick="load('analytics')">↻ Refresh</button></div>
    <div class="grid4" id="an-stats"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
      <div class="card" id="an-messages-chart"></div>
      <div class="card" id="an-top-agents"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
      <div class="card" id="an-events"></div>
      <div class="card" id="an-hive"></div>
    </div>
  </div>

  <!-- Hive Mind -->
  <div id="s-hive" class="section">
    <div class="page-header">
      <h2>Hive Mind</h2>
      <div class="actions">
        <select id="hive-limit" onchange="load('hive')">
          <option value="50">Last 50</option>
          <option value="100" selected>Last 100</option>
          <option value="250">Last 250</option>
        </select>
        <button class="btn btn-primary" onclick="load('hive')">↻ Refresh</button>
      </div>
    </div>
    <div class="tbl-wrap">
      <table><thead><tr><th>Agent</th><th>Action</th><th>Summary</th><th>Time</th></tr></thead>
      <tbody id="tb-hive"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table>
    </div>
  </div>

  <!-- Logs -->
  <!-- Comms -->
  <div id="s-comms" class="section">
    <div class="page-header"><h2>Agent Comms</h2><button class="btn btn-primary" onclick="loadComms()">↻ Refresh</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>From</th><th>To</th><th>Message</th><th>Response</th><th>Status</th><th>Time</th></tr></thead>
    <tbody id="tb-comms"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>
  </div>

  <div id="s-logs" class="section">
    <div class="page-header"><h2>Audit Logs</h2><button class="btn btn-primary" onclick="load('logs')">↻ Refresh</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>Action</th><th>Entity</th><th>ID</th><th>Details</th><th>Time</th></tr></thead>
    <tbody id="tb-logs"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
  </div>

</main>

<!-- ── Agent Modal ──────────────────────────────────────────────────────────── -->
<div id="agent-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeModal('agent')">
  <div class="modal">
    <div class="modal-header">
      <h3 id="agent-modal-title">New Agent</h3>
      <button class="btn btn-sm" onclick="closeModal('agent')">✕</button>
    </div>
    <div class="field"><label>Name *</label><input type="text" id="af-name" placeholder="e.g. Researcher" autocomplete="off"/></div>
    <div class="field"><label>Description</label><input type="text" id="af-desc" placeholder="One-line summary of this agent's specialty"/></div>
    <div class="field">
      <label>Role</label>
      <select id="af-role">
        <option value="orchestrator">orchestrator</option>
        <option value="specialist" selected>specialist</option>
        <option value="assistant">assistant</option>
        <option value="agent">agent</option>
      </select>
    </div>
    <div class="field">
      <label>Provider</label>
      <select id="af-provider" onchange="updateAgentModelField()">
        <option value="openai" selected>OpenAI / VoidAI</option>
        <option value="anthropic">Claude (Anthropic)</option>
      </select>
    </div>
    <div class="field" id="af-model-openai-wrap">
      <label>Model strategy</label>
      <select id="af-tier" onchange="onAfTierChange()">
        <option value="pinned">Pinned — use exactly the model below</option>
        <option value="auto">Auto-triage — pick by task complexity (low/mid/high)</option>
        <option value="low">Always low tier (cheap)</option>
        <option value="mid">Always mid tier</option>
        <option value="high">Always high tier (most capable)</option>
      </select>
      <div style="margin-top:8px"><label style="font-size:12px;color:var(--text-dim)">Model (used when Pinned, or as fallback)</label></div>
      <div style="display:flex;gap:6px">
        <select id="af-model-select" onchange="onAfModelSelectChange()" style="flex:1">
          <option value="">(default — VOIDAI_MODEL)</option>
        </select>
        <button class="btn btn-sm" type="button" onclick="refreshModelCatalog()" title="Refresh from VoidAI /v1/models">↻</button>
      </div>
      <input type="text" id="af-model" placeholder="or type a custom model id" style="margin-top:6px;font-size:12px"/>
      <div id="af-model-warn" style="font-size:11px;margin-top:4px;color:#ffaa50;display:none"></div>
    </div>
    <div class="field" id="af-model-claude-wrap" style="display:none">
      <label>Claude Model</label>
      <select id="af-model-claude">
        <option value="claude-opus-4-7">claude-opus-4-7 (most capable)</option>
        <option value="claude-sonnet-4-6" selected>claude-sonnet-4-6 (balanced)</option>
        <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001 (fast)</option>
      </select>
    </div>
    <div class="field"><label>Capabilities (comma-separated)</label><input type="text" id="af-caps" placeholder="research, summarize, fact-check"/></div>
    <div class="field"><label>System Prompt</label><textarea id="af-prompt" rows="7" placeholder="You are…"></textarea></div>
    <div class="field" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="af-exec" style="width:auto;margin:0"/>
      <label for="af-exec" style="margin:0;cursor:pointer">Exec enabled — grants this agent shell + filesystem tools (bash_run, fs_read/write/list/search). For Claude-CLI agents, also unlocks the bundled Bash/Read/Write/Edit/Grep/Glob.</label>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal('agent')">Cancel</button>
      <button class="btn btn-primary" onclick="submitAgent()">Save Agent</button>
    </div>
  </div>
</div>

<!-- ── Task Modal ───────────────────────────────────────────────────────────── -->
<div id="task-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeModal('task')">
  <div class="modal">
    <div class="modal-header">
      <h3>New Task</h3>
      <button class="btn btn-sm" onclick="closeModal('task')">✕</button>
    </div>
    <div class="field"><label>Title *</label><input type="text" id="tf-title" placeholder="Task title" autocomplete="off"/></div>
    <div class="field"><label>Description</label><input type="text" id="tf-desc" placeholder="Optional details"/></div>
    <div class="field">
      <label>Assign to Agent</label>
      <select id="tf-agent"><option value="">— unassigned —</option></select>
    </div>
    <div class="field"><label>Priority (0 – 100)</label><input type="number" id="tf-priority" value="50" min="0" max="100"/></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal('task')">Cancel</button>
      <button class="btn btn-primary" onclick="submitTask()">Create Task</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
var token = new URLSearchParams(window.location.search).get('token') || '';

/* ── Utilities ──────────────────────────────────────────────────────────────── */
function api(path) {
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  return fetch(path + sep + 'token=' + encodeURIComponent(token))
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}

function apiPost(path, body, method) {
  return fetch(path + '?token=' + encodeURIComponent(token), {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) {
    return r.json().then(function(data) {
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      return data;
    });
  });
}

function badge(status) {
  var map = {
    active:'bg', done:'bg', todo:'bb', doing:'by', review:'bp', inactive:'br',
    orchestrator:'bo', specialist:'bp', assistant:'bb', agent:'bb', temporary:'by',
    auto_route:'bb', manual_delegation:'bg', route_fallback:'br',
    spawn_request:'by', spawn_success:'bg', spawn_denied:'br',
    agent_spawned:'bp', agent_expired:'br',
    task_created:'bb', task_updated:'by',
    agent_activated:'bg', agent_deactivated:'br'
  };
  return '<span class="badge ' + (map[status] || 'bb') + '">' + status.replace(/_/g,' ') + '</span>';
}

function ago(s) {
  var d = new Date(s.endsWith('Z') ? s : s + 'Z');
  var ms = Date.now() - d.getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
  return d.toLocaleDateString();
}

function errHtml(msg) { return '<span style="color:var(--red)">' + msg + '</span>'; }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, duration) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._tid);
  showToast._tid = setTimeout(function() { t.classList.remove('show'); }, duration || 3000);
}

/* ── Agent cache (used to wire edit buttons without inline JSON) ─────────────── */
var agentCache = {};

/* ── Modal helpers ─────────────────────────────────────────────────────────── */
function closeModal(name) { document.getElementById(name + '-modal').style.display = 'none'; }

var editingAgentId = null;

var modelCatalog = [];
function loadModelCatalog(force) {
  return api('/api/models?provider=voidai').then(function(rows) {
    modelCatalog = rows || [];
    populateModelSelect();
  }).catch(function(){ modelCatalog = []; });
}

function refreshModelCatalog() {
  apiPost('/api/models/refresh?provider=voidai', {}).then(function() {
    loadModelCatalog(true).then(function(){ showToast('Model catalog refreshed (' + modelCatalog.length + ' models)'); });
  }).catch(function(e) { showToast('Refresh failed: ' + e.message, 5000); });
}

function tierBadge(tier) {
  var col = tier === 'high' ? '#ffaa50' : tier === 'low' ? '#7fc8ff' : '#a0e0a0';
  return '<span style="font-size:9px;color:'+col+';border:1px solid '+col+';border-radius:3px;padding:0 4px;margin-left:4px">'+tier.toUpperCase()+'</span>';
}

function populateModelSelect() {
  var sel = document.getElementById('af-model-select');
  if (!sel) return;
  var current = sel.value;
  var groups = { high: [], mid: [], low: [] };
  modelCatalog.forEach(function(m) { (groups[m.tier] || groups.mid).push(m); });
  var html = '<option value="">(default — VOIDAI_MODEL)</option>';
  ['high','mid','low'].forEach(function(t) {
    if (!groups[t].length) return;
    html += '<optgroup label="'+t.toUpperCase()+' tier ('+groups[t].length+')">';
    groups[t].forEach(function(m) {
      var price = (m.cost_per_1k_input != null)
        ? ' — $' + (m.cost_per_1k_input).toFixed(2) + '/$' + (m.cost_per_1k_output).toFixed(2) + '/1k'
        : '';
      html += '<option value="'+m.model_id+'">'+m.model_id+' ['+t+']'+price+(m.tier_overridden ? ' ★' : '')+'</option>';
    });
    html += '</optgroup>';
  });
  sel.innerHTML = html;
  if (current) sel.value = current;
}

function onAfModelSelectChange() {
  var sel = document.getElementById('af-model-select');
  document.getElementById('af-model').value = sel.value || '';
  checkAfModelExists();
}

function onAfTierChange() {
  var tier = document.getElementById('af-tier').value;
  var modelSel = document.getElementById('af-model-select');
  var modelInp = document.getElementById('af-model');
  var hint = document.getElementById('af-model-warn');
  var dim = (tier !== 'pinned');
  modelSel.style.opacity = dim ? '0.55' : '1';
  modelInp.style.opacity = dim ? '0.55' : '1';
  if (dim) {
    hint.textContent = 'Model dropdown is a fallback only — auto-triage / fixed-tier picks the model from the live catalog.';
    hint.style.display = 'block';
  } else {
    checkAfModelExists();
  }
}

function checkAfModelExists() {
  var input = document.getElementById('af-model');
  var warn  = document.getElementById('af-model-warn');
  if (!input || !warn) return;
  var val = input.value.trim();
  if (!val || !modelCatalog.length) { warn.style.display = 'none'; return; }
  var found = modelCatalog.some(function(m) { return m.model_id === val; });
  if (found) {
    warn.style.display = 'none';
  } else {
    warn.textContent = '⚠ "' + val + '" is not in the live VoidAI catalog. The agent may fail at chat time.';
    warn.style.display = 'block';
  }
}

function updateAgentModelField() {
  var provider = document.getElementById('af-provider').value;
  var openAiWrap = document.getElementById('af-model-openai-wrap');
  var claudeWrap = document.getElementById('af-model-claude-wrap');
  if (provider === 'anthropic') {
    openAiWrap.style.display = 'none';
    claudeWrap.style.display = '';
  } else {
    openAiWrap.style.display = '';
    claudeWrap.style.display = 'none';
  }
}

function openNewAgent() {
  editingAgentId = null;
  document.getElementById('agent-modal-title').textContent = 'New Agent';
  document.getElementById('af-name').value     = '';
  document.getElementById('af-desc').value     = '';
  document.getElementById('af-role').value     = 'specialist';
  document.getElementById('af-provider').value = 'openai';
  document.getElementById('af-model').value    = '';
  document.getElementById('af-model-claude').value = 'claude-sonnet-4-6';
  document.getElementById('af-caps').value     = '';
  document.getElementById('af-prompt').value   = '';
  document.getElementById('af-exec').checked   = false;
  document.getElementById('af-tier').value     = 'pinned';
  updateAgentModelField();
  onAfTierChange();
  loadModelCatalog().then(function(){
    var sel = document.getElementById('af-model-select');
    if (sel) sel.value = '';
    checkAfModelExists();
  });
  document.getElementById('agent-modal').style.display = 'flex';
  setTimeout(function() { document.getElementById('af-name').focus(); }, 80);
}

function openEditAgent(id) {
  var a = agentCache[id];
  if (!a) return;
  editingAgentId = id;
  document.getElementById('agent-modal-title').textContent = 'Edit Agent — ' + a.name;
  document.getElementById('af-name').value     = a.name || '';
  document.getElementById('af-desc').value     = a.description || '';
  document.getElementById('af-role').value     = a.role || 'agent';
  var provider = a.provider || 'openai';
  document.getElementById('af-provider').value = provider;
  if (provider === 'anthropic') {
    document.getElementById('af-model-claude').value = a.model || 'claude-sonnet-4-6';
    document.getElementById('af-model').value = '';
  } else {
    document.getElementById('af-model').value = a.model || '';
    document.getElementById('af-model-claude').value = 'claude-sonnet-4-6';
    loadModelCatalog().then(function(){
      var sel = document.getElementById('af-model-select');
      if (sel) sel.value = a.model || '';
      checkAfModelExists();
    });
  }
  updateAgentModelField();
  var caps = [];
  try { caps = JSON.parse(a.capabilities || '[]'); } catch(_) {}
  document.getElementById('af-caps').value   = caps.join(', ');
  document.getElementById('af-prompt').value = a.system_prompt || '';
  document.getElementById('af-exec').checked = !!a.exec_enabled;
  document.getElementById('af-tier').value = a.model_tier || 'pinned';
  onAfTierChange();
  document.getElementById('agent-modal').style.display = 'flex';
}

function submitAgent() {
  var name = document.getElementById('af-name').value.trim();
  if (!name) { showToast('Name is required', 3000); return; }

  var capsRaw = document.getElementById('af-caps').value.trim();
  var caps = capsRaw ? capsRaw.split(',').map(function(c) { return c.trim(); }).filter(Boolean) : [];
  var provider = document.getElementById('af-provider').value;
  var modelVal = provider === 'anthropic'
    ? document.getElementById('af-model-claude').value
    : document.getElementById('af-model').value.trim();

  var body = {
    name:          name,
    description:   document.getElementById('af-desc').value.trim(),
    role:          document.getElementById('af-role').value,
    provider:      provider,
    model:         modelVal || undefined,
    capabilities:  caps,
    system_prompt: document.getElementById('af-prompt').value.trim(),
    exec_enabled:  document.getElementById('af-exec').checked,
    model_tier:    document.getElementById('af-tier').value
  };

  var url = editingAgentId ? '/api/agents/' + editingAgentId : '/api/agents';
  var method = editingAgentId ? 'PATCH' : 'POST';

  apiPost(url, body, method).then(function() {
    closeModal('agent');
    load('agents');
    loadChatAgents();
    showToast(editingAgentId ? 'Agent updated' : 'Agent created');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function deactivateAgent(id) {
  var a = agentCache[id];
  if (!a || !confirm('Deactivate agent "' + a.name + '"?')) return;
  apiPost('/api/agents/' + id, {}, 'DELETE').then(function() {
    load('agents');
    loadChatAgents();
    showToast('Agent deactivated');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function activateAgent(id) {
  apiPost('/api/agents/' + id + '/activate', {}, 'POST').then(function() {
    load('agents');
    loadChatAgents();
    showToast('Agent activated');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

/* ── Agent filtering ───────────────────────────────────────────────────────── */
var currentAgentFilter = 'all';

function filterAgents(filter) {
  currentAgentFilter = filter;
  // Update button styles
  document.querySelectorAll('#agent-filter button').forEach(function(btn) {
    btn.classList.remove('btn-primary');
    if (btn.dataset.filter === filter) btn.classList.add('btn-primary');
  });
  // Apply filter to agent cards
  document.querySelectorAll('.agent-card').forEach(function(card) {
    var isTemp     = card.classList.contains('temporary');
    var isInactive = card.classList.contains('inactive');
    var show = false;
    if (filter === 'all')      show = true;
    else if (filter === 'active')   show = !isInactive && !isTemp;
    else if (filter === 'temp')     show = isTemp;
    else if (filter === 'inactive') show = isInactive;
    card.style.display = show ? '' : 'none';
  });
}

/* ── Section loaders ────────────────────────────────────────────────────────── */
function loadOverview() {
  Promise.all([
    api('/api/status'),
    api('/api/claude/status').catch(function(){return null;}),
    api('/api/models/spend').catch(function(){return null;}),
  ]).then(function(results) {
    var s = results[0];
    var cs = results[1];
    var spend = results[2];
    var an = s.anthropic || {};
    var anLabel = an.source === 'cli_oauth'
      ? (an.expired ? '⚠ CLI (expired)' : '✓ Claude CLI (' + (an.subscriptionType || 'oauth') + ')')
      : an.source === 'api_key' ? '✓ API Key'
      : '✗ Not configured';
    var anColor = (an.source !== 'none' && !an.expired) ? 'var(--green)' : an.expired ? 'var(--yellow)' : 'var(--red)';

    var backendLabel = '—', backendColor = 'var(--muted)', backendSub = 'Claude backend';
    if (cs) {
      if (cs.backend === 'claude-cli') {
        backendLabel = cs.cliBinaryFound ? '✓ claude-cli (' + (cs.cliVersion||'') + ')' : '✗ claude-cli (binary missing)';
        backendColor = cs.cliBinaryFound ? 'var(--green)' : 'var(--red)';
        backendSub   = 'Subscription auth · queue ' + cs.queueLength + (cs.throttled1h ? ' · ' + cs.throttled1h + '× 429/1h' : '');
      } else {
        backendLabel = cs.anthropicApiKeySet ? '✓ anthropic-api' : '✗ anthropic-api (no key)';
        backendColor = cs.anthropicApiKeySet ? 'var(--green)' : 'var(--red)';
        backendSub   = 'Direct Anthropic API · per-token billing';
      }
    }

    var spendUsd = (spend && spend.lastHour && typeof spend.lastHour.est_cost_usd === 'number')
      ? '$' + spend.lastHour.est_cost_usd.toFixed(4)
      : '—';
    var spendTokens = (spend && spend.lastHour) ? (spend.lastHour.total_tokens||0) : 0;
    var spendCalls  = (spend && spend.lastHour) ? (spend.lastHour.call_count||0)   : 0;

    var cards = [
      {l:'Status',         v:'<span class="dot"></span>Online',                                                 sub:'System running'},
      {l:'Model',          v:s.model||'—',                                                                      sub:'VoidAI model'},
      {l:'Claude Backend', v:'<span style="color:'+backendColor+'">'+esc(backendLabel)+'</span>',               sub:backendSub},
      {l:'Claude Auth',    v:'<span style="color:'+anColor+'">'+esc(anLabel)+'</span>',                         sub:'Anthropic / Claude CLI'},
      {l:'Spend (1h)',     v:spendUsd,                                                                          sub:spendTokens.toLocaleString()+' tokens · '+spendCalls+' calls'},
      {l:'Agents',         v:s.agents,                                                                          sub:'Active agents'},
      {l:'Temp Agents',    v:s.tempAgents||0,                                                                   sub:'Spawned, running'},
      {l:'Sessions',       v:s.sessions,                                                                        sub:'Total sessions'},
      {l:'Messages',       v:s.messages,                                                                        sub:'Total messages'},
      {l:'Uptime',         v:Math.floor(s.uptime)+'s',                                                          sub:'Since last start'},
    ];
    document.getElementById('ov-stats').innerHTML = cards.map(function(c) {
      return '<div class="card"><div class="card-label">'+c.l+'</div><div class="card-value">'+c.v+'</div><div class="card-sub">'+c.sub+'</div></div>';
    }).join('');
  }).catch(function(e) {
    document.getElementById('ov-stats').innerHTML = '<div class="card">'+errHtml(e.message)+'</div>';
  });
}

function loadAgents() {
  api('/api/agents').then(function(rows) {
    agentCache = {};
    rows.forEach(function(a) { agentCache[a.id] = a; });

    var el = document.getElementById('ag-list');
    if (!rows.length) { el.innerHTML = '<p class="muted">No agents registered</p>'; return; }

    el.innerHTML = rows.map(function(a) {
      var caps = [];
      try { caps = JSON.parse(a.capabilities || '[]'); } catch(_) {}
      var capsHtml = caps.length
        ? '<div class="caps">' + caps.map(function(c) { return '<span class="badge bb">'+esc(c)+'</span>'; }).join('') + '</div>'
        : '';
      var isAlfred = a.name === 'Alfred';
      var isActive = a.status === 'active';

      var actions = '<div class="agent-actions">';
      actions += '<button class="btn btn-sm" data-id="'+a.id+'" onclick="openEditAgent(this.dataset.id)">✏ Edit</button>';
      if (!isAlfred) {
        if (isActive) {
          actions += '<button class="btn btn-sm btn-danger" data-id="'+a.id+'" onclick="deactivateAgent(this.dataset.id)">⏸ Deactivate</button>';
        } else {
          actions += '<button class="btn btn-sm" data-id="'+a.id+'" onclick="activateAgent(this.dataset.id)">▶ Activate</button>';
        }
      }
      actions += '</div>';

      var isTemp    = a.temporary === 1;
      var expiryHtml = isTemp && a.expires_at
        ? '<div class="muted" style="font-size:11px;margin-top:3px">⏱ expires ' + ago(a.expires_at) + '</div>'
        : '';
      var parentHtml = isTemp && a.parent_agent_id && agentCache[a.parent_agent_id]
        ? '<div class="muted" style="font-size:11px">spawned by ' + esc(agentCache[a.parent_agent_id].name) + '</div>'
        : '';

      return '<div class="agent-card' + (isActive ? '' : ' inactive') + (isTemp ? ' temporary' : '') + '">'
        +'<div class="agent-header">'
        +'<div><div class="agent-name">'+esc(a.name)+(isTemp ? ' <span style="font-size:11px;color:var(--yellow)">[temp]</span>' : '')+'</div>'
        +'<div class="agent-meta">'+esc(a.description||'')+'</div>'
        +capsHtml+expiryHtml+parentHtml+'</div>'
        +'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">'
        +badge(a.status)
        +badge(a.role)
        +(a.provider === 'anthropic' ? '<span style="font-size:10px;background:rgba(210,120,255,.15);color:#d278ff;border:1px solid rgba(210,120,255,.35);border-radius:4px;padding:1px 6px">Claude</span>' : '')
        +(a.exec_enabled ? '<span title="Shell + filesystem tools enabled" style="font-size:10px;background:rgba(255,170,80,.15);color:#ffaa50;border:1px solid rgba(255,170,80,.35);border-radius:4px;padding:1px 6px;margin-left:4px">EXEC</span>' : '')
        +(a.model_tier && a.model_tier !== 'pinned' ? '<span title="Auto-triage: model picked by task complexity ('+a.model_tier+')" style="font-size:10px;background:rgba(127,200,255,.15);color:#7fc8ff;border:1px solid rgba(127,200,255,.35);border-radius:4px;padding:1px 6px;margin-left:4px">'+a.model_tier.toUpperCase()+'</span>' : '')
        +'<span class="muted" style="font-size:11px">'+esc(a.model||'')+'</span>'
        +'</div></div>'
        +(a.system_prompt
          ? '<div><div class="card-label">System Prompt</div><div class="pre">'+esc(a.system_prompt)+'</div></div>'
          : '')
        +actions
        +'</div>';
    }).join('');
  }).catch(function(e) { document.getElementById('ag-list').innerHTML = errHtml(e.message); });
}

/* ── Tasks ──────────────────────────────────────────────────────────────────── */
function openNewTask() {
  api('/api/agents').then(function(agents) {
    var sel = document.getElementById('tf-agent');
    sel.innerHTML = '<option value="">— unassigned —</option>'
      + agents.filter(function(a) { return a.status === 'active'; }).map(function(a) {
          return '<option value="'+a.id+'">'+esc(a.name)+'</option>';
        }).join('');
  }).catch(function() {});
  document.getElementById('tf-title').value    = '';
  document.getElementById('tf-desc').value     = '';
  document.getElementById('tf-priority').value = '50';
  document.getElementById('task-modal').style.display = 'flex';
  setTimeout(function() { document.getElementById('tf-title').focus(); }, 80);
}

function submitTask() {
  var title = document.getElementById('tf-title').value.trim();
  if (!title) { showToast('Title is required', 3000); return; }
  apiPost('/api/tasks', {
    title:       title,
    description: document.getElementById('tf-desc').value.trim() || undefined,
    agent_id:    document.getElementById('tf-agent').value || undefined,
    priority:    parseInt(document.getElementById('tf-priority').value) || 50
  }, 'POST').then(function() {
    closeModal('task');
    load('tasks');
    showToast('Task created');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function updateTaskStatus(id, status) {
  apiPost('/api/tasks/' + id, { status: status }, 'PATCH')
    .then(function() { load('tasks'); showToast('Status → ' + status); })
    .catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function loadTasks() {
  Promise.all([api('/api/tasks'), api('/api/agents')]).then(function(results) {
    var rows = results[0];
    var agents = results[1];
    var agentMap = {};
    agents.forEach(function(a) { agentMap[a.id] = a.name; });

    var tb = document.getElementById('tb-tasks');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">No tasks yet</td></tr>'; return; }

    var statuses = ['todo', 'doing', 'review', 'done'];

    tb.innerHTML = rows.map(function(r) {
      var agentName = r.agent_id ? (agentMap[r.agent_id] || 'Unknown') : '—';
      var next = statuses.filter(function(s) { return s !== r.status; });
      var btns = next.map(function(s) {
        return '<button class="btn btn-sm" data-task-id="'+r.id+'" data-status="'+s+'" onclick="updateTaskStatus(this.dataset.taskId, this.dataset.status)">'+s+'</button>';
      }).join('');
      return '<tr>'
        +'<td>'+esc(r.title)+(r.description?'<div class="muted">'+esc(r.description)+'</div>':'')+'</td>'
        +'<td>'+badge(r.status)+'</td>'
        +'<td class="muted">'+esc(agentName)+'</td>'
        +'<td>'+r.priority+'</td>'
        +'<td style="white-space:nowrap">'+btns+'</td>'
        +'<td class="muted">'+ago(r.created_at)+'</td>'
        +'</tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-tasks').innerHTML = '<tr><td colspan="6">'+errHtml(e.message)+'</td></tr>'; });
}

function loadSessions() {
  api('/api/sessions').then(function(rows) {
    var tb = document.getElementById('tb-sessions');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">No sessions yet</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      return '<tr><td class="muted mono">'+r.id.slice(0,8)+'…</td><td>'+esc(r.title||'—')+'</td><td>'+r.message_count+'</td><td>'+badge(r.status)+'</td><td class="muted">'+ago(r.created_at)+'</td></tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-sessions').innerHTML = '<tr><td colspan="5">'+errHtml(e.message)+'</td></tr>'; });
}

function loadMemory() {
  loadMemoryIndex();
  loadMemoryHive();
  loadMemoryStats();
  api('/api/memory').then(function(rows) {
    var tb = document.getElementById('tb-memory');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">No memories stored</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      return '<tr><td style="max-width:400px">'+esc(r.content)+'</td><td><span class="badge bb">'+esc(r.type)+'</span></td><td>'+r.importance+'/10</td><td class="muted">'+ago(r.created_at)+'</td>'
            +'<td><button class="btn btn-sm btn-danger" data-id="'+r.id+'" onclick="deleteMemory(this.dataset.id)">🗑</button></td></tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-memory').innerHTML = '<tr><td colspan="5">'+errHtml(e.message)+'</td></tr>'; });
}

function loadMemoryStats() {
  api('/api/memory/index/stats').then(function(s) {
    var grid = document.getElementById('ov-memory-stats');
    if (!grid) return;
    var topType = (s.byType && s.byType[0]) ? s.byType[0].type : '—';
    var cards = [
      {l:'Total memories', v:s.total, sub:'in memory_index'},
      {l:'Last hour',      v:s.lastHour, sub:'newly extracted'},
      {l:'Last 24h',       v:s.lastDay,  sub:'extraction volume'},
      {l:'Auto-compactions (24h)', v:s.compactedDay, sub:'sessions condensed'},
      {l:'Vault-capped (1h)', v:s.cappedHour, sub:'over per-hour limit'},
      {l:'Top type',       v:topType, sub:'most common'},
    ];
    grid.innerHTML = cards.map(function(c) {
      return '<div class="card"><div class="card-label">'+c.l+'</div><div class="card-value">'+c.v+'</div><div class="card-sub">'+c.sub+'</div></div>';
    }).join('');
  }).catch(function(){});
}

function loadMemoryIndex() {
  var filterEl = document.getElementById('mi-filter');
  var type = filterEl ? filterEl.value : '';
  var qs = type ? ('?type=' + encodeURIComponent(type) + '&limit=200') : '?limit=200';
  api('/api/memory/index' + qs).then(function(rows) {
    var tb = document.getElementById('tb-memory-index');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="muted">No long-term memories yet — they appear automatically after assistant turns.</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      var imp = (typeof r.importance === 'number') ? r.importance.toFixed(2) : '—';
      var sal = (typeof r.salience === 'number')   ? r.salience.toFixed(2)   : '—';
      var typeColors = {procedural:'#7fc8ff', insight:'#ffaa50', semantic:'#a0e0a0', episodic:'#d278ff', preference:'#ffe080', session_summary:'#888', project:'#7fc8ff', working:'#888'};
      var col = typeColors[r.type] || '#888';
      var vault = r.vault_path
        ? '<span class="muted" style="font-size:11px" title="'+esc(r.vault_path)+'">'+esc(r.vault_path.split('/').pop())+'</span>'
        : '<span class="muted">—</span>';
      var lastAcc = r.last_accessed ? ago(r.last_accessed) : '<span class="muted">never</span>';
      return '<tr>'
        + '<td><span style="font-size:10px;background:rgba(255,255,255,.05);color:'+col+';border:1px solid '+col+';border-radius:4px;padding:1px 6px">'+esc(r.type)+'</span></td>'
        + '<td title="'+esc(r.summary || '')+'">'+esc(r.title)+'</td>'
        + '<td>'+imp+'</td>'
        + '<td>'+sal+'</td>'
        + '<td>'+vault+'</td>'
        + '<td class="muted">'+lastAcc+'</td>'
        + '<td><button class="btn btn-sm btn-danger" data-id="'+r.id+'" onclick="deleteMemoryIndex(this.dataset.id)">🗑</button></td>'
        + '</tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-memory-index').innerHTML = '<tr><td colspan="7">'+errHtml(e.message)+'</td></tr>'; });
}

function loadMemoryHive() {
  api('/api/memory/hive?limit=50').then(function(rows) {
    var tb = document.getElementById('tb-memory-hive');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">No memory events yet</td></tr>'; return; }
    var actionColors = {memory_extracted:'#a0e0a0', memory_skipped:'#888', memory_capped:'#ff8888'};
    tb.innerHTML = rows.map(function(r) {
      var col = actionColors[r.action] || '#888';
      return '<tr>'
        + '<td class="muted" style="white-space:nowrap">'+ago(r.created_at)+'</td>'
        + '<td><span style="font-size:10px;color:'+col+';border:1px solid '+col+';border-radius:4px;padding:1px 6px">'+esc(r.action)+'</span></td>'
        + '<td>'+esc(r.summary)+'</td>'
        + '<td class="muted" style="font-size:11px">'+esc(r.agent_id ? r.agent_id.slice(0,8) : '—')+'</td>'
        + '</tr>';
    }).join('');
  }).catch(function(){});
}

function deleteMemoryIndex(id) {
  if (!confirm('Delete this memory? (Vault note is not deleted.)')) return;
  apiPost('/api/memory/index/' + id, {}, 'DELETE').then(function() {
    loadMemoryIndex();
    loadMemoryStats();
    showToast('Memory deleted from index');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function openAddMemory() {
  document.getElementById('mf-content').value = '';
  document.getElementById('mf-type').value = 'general';
  document.getElementById('mf-importance').value = '5';
  document.getElementById('memory-modal').style.display = 'flex';
  setTimeout(function() { document.getElementById('mf-content').focus(); }, 80);
}

function submitMemory() {
  var content = document.getElementById('mf-content').value.trim();
  if (!content) { showToast('Content is required', 3000); return; }
  var payload = {
    content: content,
    type: document.getElementById('mf-type').value,
    importance: parseInt(document.getElementById('mf-importance').value, 10) || 5
  };
  apiPost('/api/memory', payload).then(function() {
    closeModal('memory');
    loadMemory();
    showToast('Memory saved');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function deleteMemory(id) {
  if (!confirm('Delete this memory?')) return;
  apiPost('/api/memory/' + id, {}, 'DELETE').then(function() {
    loadMemory();
    showToast('Memory deleted');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function loadConfig() {
  api('/api/config').then(function(rows) {
    var tb = document.getElementById('tb-config');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">No config items</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      var vc = r.value === '***REDACTED***' ? 'var(--muted)' : 'var(--green)';
      return '<tr><td class="mono" style="font-weight:600">'+esc(r.key)+'</td>'
            +'<td class="mono" style="color:'+vc+'">'+esc(r.value)+'</td>'
            +'<td class="muted">'+esc(r.description||'')+'</td>'
            +'<td class="muted">'+(r.updated_at?ago(r.updated_at):'—')+'</td></tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-config').innerHTML = '<tr><td colspan="4">'+errHtml(e.message)+'</td></tr>'; });
}

function loadAnalytics() {
  api('/api/analytics').then(function(d) {
    // Stats cards
    document.getElementById('an-stats').innerHTML = [
      {l:'Messages Today', v:d.messages_today, sub:'last 24h'},
      {l:'Messages (7d)',  v:d.messages_7d,    sub:'last week'},
      {l:'Total Messages', v:d.total_messages, sub:'all time'},
      {l:'Total Sessions', v:d.total_sessions, sub:'conversations'},
      {l:'Active Agents',  v:d.active_agents,  sub:'ready'},
      {l:'Temp Agents',    v:d.temp_agents,    sub:'spawned'},
      {l:'Tasks Open',     v:d.tasks_todo,     sub:'todo/doing'},
      {l:'Tasks Done',     v:d.tasks_done,     sub:'completed'},
      {l:'Memories',       v:d.memories_count, sub:'stored'},
      {l:'Total Tokens',   v:d.total_tokens,   sub:'API usage'},
    ].map(function(c) {
      return '<div class="card"><div class="card-label">'+c.l+'</div><div class="card-value">'+c.v+'</div><div class="card-sub">'+c.sub+'</div></div>';
    }).join('');
    
    // Messages by day chart (simple bar visualization)
    var chartEl = document.getElementById('an-messages-chart');
    if (d.messages_by_day && d.messages_by_day.length) {
      var maxCount = Math.max.apply(null, d.messages_by_day.map(function(x) { return x.count; })) || 1;
      chartEl.innerHTML = '<div class="card-label" style="margin-bottom:10px">Messages (Last 14 Days)</div>'
        + d.messages_by_day.slice().reverse().map(function(day) {
          var pct = Math.round((day.count / maxCount) * 100);
          var label = day.day.slice(5); // MM-DD
          return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
            + '<span style="width:45px;font-size:11px;color:var(--muted)">'+label+'</span>'
            + '<div style="flex:1;height:18px;background:var(--bg3);border-radius:3px;overflow:hidden">'
            + '<div style="width:'+pct+'%;height:100%;background:var(--blue);border-radius:3px"></div></div>'
            + '<span style="width:30px;font-size:12px;text-align:right">'+day.count+'</span></div>';
        }).join('');
    } else {
      chartEl.innerHTML = '<div class="card-label">Messages (Last 14 Days)</div><div class="muted" style="padding:10px 0">No data yet</div>';
    }
    
    // Top agents
    var agentsEl = document.getElementById('an-top-agents');
    if (d.top_agents && d.top_agents.length) {
      agentsEl.innerHTML = '<div class="card-label" style="margin-bottom:10px">Top Agents (by messages)</div>'
        + d.top_agents.map(function(a, i) {
          var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
          return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">'
            + '<span>'+medal+' '+esc(a.name)+'</span><strong>'+a.messages+'</strong></div>';
        }).join('');
    } else {
      agentsEl.innerHTML = '<div class="card-label">Top Agents</div><div class="muted" style="padding:10px 0">No data yet</div>';
    }
    
    // Events by type
    var evEl = document.getElementById('an-events');
    if (d.events_by_type && d.events_by_type.length) {
      evEl.innerHTML = '<div class="card-label" style="margin-bottom:10px">Event Types</div>'
        + d.events_by_type.map(function(e) {
          return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)"><span>'+esc(e.event_type)+'</span><strong>'+e.count+'</strong></div>';
        }).join('');
    } else {
      evEl.innerHTML = '<div class="card-label">Event Types</div><div class="muted" style="padding:10px 0">No events yet</div>';
    }
    
    // Hive mind activity (24h)
    var hiveEl = document.getElementById('an-hive');
    if (d.hive_recent && d.hive_recent.length) {
      hiveEl.innerHTML = '<div class="card-label" style="margin-bottom:10px">Hive Mind (24h)</div>'
        + d.hive_recent.map(function(h) {
          return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)"><span>'+esc(h.action)+'</span><strong>'+h.count+'</strong></div>';
        }).join('');
    } else {
      hiveEl.innerHTML = '<div class="card-label">Hive Mind (24h)</div><div class="muted" style="padding:10px 0">No activity yet</div>';
    }
  }).catch(function(e) { document.getElementById('an-stats').innerHTML = '<div class="card">'+errHtml(e.message)+'</div>'; });
}

function loadHive() {
  var limit = document.getElementById('hive-limit') ? document.getElementById('hive-limit').value : '100';
  api('/api/hive?limit=' + limit).then(function(rows) {
    var tb = document.getElementById('tb-hive');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">No hive events yet</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      return '<tr>'
        + '<td class="muted">' + esc(r.agent_name || (r.agent_id ? r.agent_id.slice(0,8)+'…' : '—')) + '</td>'
        + '<td>' + badge(r.action) + '</td>'
        + '<td>' + esc(r.summary) + '</td>'
        + '<td class="muted">' + ago(r.created_at) + '</td>'
        + '</tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-hive').innerHTML = '<tr><td colspan="4">' + errHtml(e.message) + '</td></tr>'; });
}

function loadComms() {
  api('/api/agent-messages').then(function(rows) {
    var tb = document.getElementById('tb-comms');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">No agent communications yet</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      var statusColor = r.status === 'responded' ? '#22c55e' : r.status === 'failed' ? '#ef4444' : '#94a3b8';
      return '<tr>'
        + '<td><strong>' + esc(r.from_name) + '</strong></td>'
        + '<td>' + esc(r.to_name) + '</td>'
        + '<td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.content) + '</td>'
        + '<td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="muted">' + esc(r.response || '—') + '</td>'
        + '<td><span style="color:' + statusColor + '">' + esc(r.status) + '</span></td>'
        + '<td class="muted">' + ago(r.created_at) + '</td>'
        + '</tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-comms').innerHTML = '<tr><td colspan="6">' + errHtml(e.message) + '</td></tr>'; });
}

function loadLogs() {
  api('/api/logs').then(function(rows) {
    var tb = document.getElementById('tb-logs');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">No logs yet</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      return '<tr><td><strong>'+esc(r.action)+'</strong></td>'
            +'<td class="muted">'+esc(r.entity_type||'—')+'</td>'
            +'<td class="muted mono">'+(r.entity_id?r.entity_id.slice(0,8)+'…':'—')+'</td>'
            +'<td class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(r.details?esc(r.details.slice(0,60)):'—')+'</td>'
            +'<td class="muted">'+ago(r.created_at)+'</td></tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-logs').innerHTML = '<tr><td colspan="5">'+errHtml(e.message)+'</td></tr>'; });
}

/* ── Chat ───────────────────────────────────────────────────────────────────── */
var chatSessionId   = null;
var chatStreaming    = false;
var chatRespondingAs = 'Agent';
var sessionsCache    = [];

function loadChatAgents() {
  api('/api/agents').then(function(rows) {
    var sel = document.getElementById('chat-agent');
    var active = rows.filter(function(a) { return a.status === 'active'; });
    sel.innerHTML = active.map(function(a) {
      return '<option value="'+a.id+'">'+esc(a.name)+'</option>';
    }).join('');
    // Default to Alfred
    for (var i = 0; i < active.length; i++) {
      if (active[i].name === 'Alfred') { sel.value = active[i].id; break; }
    }
  }).catch(function() {});
  // Also load sessions
  loadChatSessions();
}

function loadChatSessions() {
  api('/api/sessions').then(function(rows) {
    sessionsCache = rows;
    var sel = document.getElementById('chat-session-select');
    sel.innerHTML = '<option value="">— New Chat —</option>' +
      rows.map(function(s) {
        var preview = s.last_message ? ' — ' + esc(s.last_message.slice(0,30)) + (s.last_message.length > 30 ? '…' : '') : '';
        var title = s.title || 'Chat ' + s.id.slice(0,8);
        return '<option value="'+s.id+'">'+esc(title)+preview+'</option>';
      }).join('');
    // If we have a current session, keep it selected
    if (chatSessionId) sel.value = chatSessionId;
  }).catch(function() {});
}

function loadSession(sessionId) {
  if (!sessionId) {
    newChat();
    return;
  }
  chatSessionId = sessionId;
  document.getElementById('chat-session-id').textContent = sessionId.slice(0, 8) + '…';
  // Load messages for this session
  api('/api/sessions/' + sessionId + '/messages').then(function(messages) {
    var container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (!messages.length) {
      container.innerHTML = '<div class="chat-empty">No messages in this session yet</div>';
      return;
    }
    messages.forEach(function(m) {
      appendMsg(m.role, m.content, false, m.agent_id ? (agentCache[m.agent_id]?.name || 'Agent') : null);
    });
    container.scrollTop = container.scrollHeight;
  }).catch(function(e) {
    showToast('Error loading session: ' + e.message, 5000);
  });
}

function renameSession() {
  if (!chatSessionId) { showToast('No session to rename', 3000); return; }
  var newTitle = prompt('Enter new session title:');
  if (!newTitle) return;
  apiPost('/api/sessions/' + chatSessionId, { title: newTitle }, 'PATCH').then(function() {
    loadChatSessions();
    showToast('Session renamed');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function deleteCurrentSession() {
  if (!chatSessionId) { showToast('No session to delete', 3000); return; }
  if (!confirm('Delete this session and all its messages?')) return;
  apiPost('/api/sessions/' + chatSessionId, {}, 'DELETE').then(function() {
    newChat();
    loadChatSessions();
    showToast('Session deleted');
  }).catch(function(e) { showToast('Error: ' + e.message, 5000); });
}

function newChat() {
  chatSessionId = null;
  chatRespondingAs = 'Agent';
  document.getElementById('chat-session-id').textContent = '—';
  document.getElementById('chat-session-select').value = '';
  document.getElementById('chat-messages').innerHTML =
    '<div class="chat-empty" id="chat-empty">Select a session or start a new chat</div>';
}

function appendMsg(role, text, streaming, agentName) {
  var container = document.getElementById('chat-messages');
  var empty = document.getElementById('chat-empty');
  if (empty) empty.remove();

  var who = role === 'user' ? 'You' : (agentName || chatRespondingAs);
  var div = document.createElement('div');
  div.className = 'msg ' + role + (streaming ? ' streaming' : '');
  var bubble = document.createElement('div');
  bubble.className = 'msg-who';
  bubble.textContent = who;
  var b = document.createElement('div');
  b.className = 'msg-bubble';
  b.textContent = text;
  div.appendChild(bubble);
  div.appendChild(b);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function sendChat() {
  if (chatStreaming) return;
  var input = document.getElementById('chat-input');
  var message = input.value.trim();
  if (!message) return;

  var agentId = document.getElementById('chat-agent').value;
  input.value = '';
  input.style.height = 'auto';

  chatStreaming = true;
  document.getElementById('chat-send').disabled = true;

  appendMsg('user', message, false, null);
  var assistantDiv = appendMsg('assistant', '', true, null);
  var bubbleEl = assistantDiv.querySelector('.msg-bubble');
  var accText = '';
  var stepTextMap = {};

  var reqBody = JSON.stringify({ message: message, agentId: agentId, sessionId: chatSessionId });

  fetch('/api/chat?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: reqBody
  }).then(function(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var reader  = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';

    function read() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          assistantDiv.classList.remove('streaming');
          chatStreaming = false;
          document.getElementById('chat-send').disabled = false;
          return;
        }
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split('\\n');
        buf = lines.pop();
        lines.forEach(function(line) {
          if (!line.startsWith('data: ')) return;
          try {
            var ev = JSON.parse(line.slice(6));
            if (ev.type === 'session') {
              chatSessionId = ev.sessionId;
              document.getElementById('chat-session-id').textContent = ev.sessionId.slice(0, 8) + '…';
              document.getElementById('chat-session-select').value = ev.sessionId;
              // Refresh session list to show new session
              loadChatSessions();
            } else if (ev.type === 'agent') {
              chatRespondingAs = ev.name;
              // Update the who label on the in-progress bubble
              var whoEl = assistantDiv.querySelector('.msg-who');
              if (whoEl) whoEl.textContent = ev.name;
            } else if (ev.type === 'chunk') {
              accText += ev.content;
              bubbleEl.textContent = accText;
              document.getElementById('chat-messages').scrollTop = 9999;
            } else if (ev.type === 'route') {
              var icon = ev.manual ? '👤' : '🤖';
              var pct  = ev.confidence < 1 ? ' (' + Math.round(ev.confidence * 100) + '%)' : '';
              var meta = document.createElement('div');
              meta.className = 'msg meta';
              var mb = document.createElement('div');
              mb.className = 'msg-meta route';
              mb.textContent = icon + ' ' + ev.from + ' → ' + ev.to + pct + ' — ' + ev.reason;
              meta.appendChild(mb);
              document.getElementById('chat-messages').insertBefore(meta, assistantDiv);
            } else if (ev.type === 'spawn') {
              var smeta = document.createElement('div');
              smeta.className = 'msg meta';
              var smb = document.createElement('div');
              smb.className = 'msg-meta spawn';
              smb.textContent = '🧬 Spawning temporary agent "' + ev.agentName + '"…';
              smeta.appendChild(smb);
              document.getElementById('chat-messages').insertBefore(smeta, assistantDiv);
              document.getElementById('chat-messages').scrollTop = 9999;
            } else if (ev.type === 'spawn_started') {
              var smeta = document.createElement('div');
              smeta.className = 'msg meta';
              var smb = document.createElement('div');
              smb.className = 'msg-meta spawn';
              smb.textContent = '🚀 Sub-agent "' + ev.agentName + '" working in background…';
              smeta.appendChild(smb);
              document.getElementById('chat-messages').appendChild(smeta);
              document.getElementById('chat-messages').scrollTop = 9999;
            } else if (ev.type === 'plan') {
              // Show the multi-agent execution plan
              var planMeta = document.createElement('div');
              planMeta.className = 'msg meta';
              var planMb = document.createElement('div');
              planMb.className = 'msg-meta';
              planMb.style.cssText = 'background:rgba(188,140,255,.1);border-color:rgba(188,140,255,.3);color:var(--purple);max-width:420px;white-space:normal;line-height:1.5';
              planMb.innerHTML = '🧠 <strong>Multi-agent plan (' + ev.steps.length + ' steps)</strong><br>'
                + ev.steps.map(function(s, i) {
                  return '<span id="plan-step-'+i+'" style="display:block;margin-top:3px;opacity:.7">⬜ Step '+(i+1)+': '+esc(s.task)+' → <em>'+esc(s.agent)+'</em></span>';
                }).join('');
              planMeta.appendChild(planMb);
              document.getElementById('chat-messages').insertBefore(planMeta, assistantDiv);
              document.getElementById('chat-messages').scrollTop = 9999;
            } else if (ev.type === 'step_start') {
              // Mark step as running
              var stepEl = document.getElementById('plan-step-'+ev.stepIndex);
              if (stepEl) { stepEl.style.opacity = '1'; stepEl.textContent = '▶ Step '+(ev.stepIndex+1)+': '+ev.task+' → '+ev.agentName; }
              // Create step output bubble
              var stepDiv = document.createElement('div');
              stepDiv.id = 'step-bubble-'+ev.stepIndex;
              stepDiv.className = 'msg assistant streaming';
              var stepWho = document.createElement('div');
              stepWho.className = 'msg-who';
              stepWho.textContent = ev.agentName + ' · step ' + (ev.stepIndex+1);
              var stepBub = document.createElement('div');
              stepBub.className = 'msg-bubble';
              stepDiv.appendChild(stepWho);
              stepDiv.appendChild(stepBub);
              document.getElementById('chat-messages').insertBefore(stepDiv, assistantDiv);
              document.getElementById('chat-messages').scrollTop = 9999;
              stepTextMap[ev.stepIndex] = '';
            } else if (ev.type === 'step_chunk') {
              var sb = document.getElementById('step-bubble-'+ev.stepIndex);
              if (sb) {
                stepTextMap[ev.stepIndex] = (stepTextMap[ev.stepIndex] || '') + ev.content;
                var bub = sb.querySelector('.msg-bubble');
                if (bub) bub.textContent = stepTextMap[ev.stepIndex];
                document.getElementById('chat-messages').scrollTop = 9999;
              }
            } else if (ev.type === 'step_done') {
              var sd = document.getElementById('step-bubble-'+ev.stepIndex);
              if (sd) sd.classList.remove('streaming');
              var stepEl = document.getElementById('plan-step-'+ev.stepIndex);
              if (stepEl) { stepEl.textContent = '✅ Step '+(ev.stepIndex+1)+': '+ev.agentName+' — done'; stepEl.style.color = 'var(--green)'; }
            } else if (ev.type === 'merge_start') {
              var mMeta = document.createElement('div');
              mMeta.className = 'msg meta';
              var mMb = document.createElement('div');
              mMb.className = 'msg-meta';
              mMb.style.cssText = 'background:rgba(88,166,255,.1);border-color:rgba(88,166,255,.3);color:var(--blue)';
              mMb.textContent = '🔀 Synthesizing results…';
              mMeta.appendChild(mMb);
              document.getElementById('chat-messages').insertBefore(mMeta, assistantDiv);
              document.getElementById('chat-messages').scrollTop = 9999;
            } else if (ev.type === 'spawn_eval') {
              var seMeta = document.createElement('div');
              seMeta.className = 'msg meta';
              var seMb = document.createElement('div');
              seMb.className = 'msg-meta ' + (ev.shouldSpawn ? 'spawn' : '');
              seMb.style.cssText = ev.shouldSpawn ? '' : 'background:rgba(139,148,158,.1);border-color:rgba(139,148,158,.3)';
              seMb.textContent = (ev.shouldSpawn ? '🧬 Spawn approved' : '🚫 Spawn blocked') + ' — ' + ev.reason + ' (benefit: ' + Math.round(ev.benefit*100) + '%)';
              seMeta.appendChild(seMb);
              document.getElementById('chat-messages').insertBefore(seMeta, assistantDiv);
            } else if (ev.type === 'agent_message') {
              var amMeta = document.createElement('div');
              amMeta.className = 'msg meta';
              var amMb = document.createElement('div');
              amMb.className = 'msg-meta';
              amMb.style.cssText = 'background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.35);color:#fbbf24';
              amMb.textContent = '💬 ' + ev.fromName + ' → ' + ev.toName + ': "' + ev.preview + (ev.preview.length >= 80 ? '…' : '') + '"';
              amMeta.appendChild(amMb);
              document.getElementById('chat-messages').insertBefore(amMeta, assistantDiv);
              document.getElementById('chat-messages').scrollTop = 9999;
            } else if (ev.type === 'agent_task_assigned') {
              var atMeta = document.createElement('div');
              atMeta.className = 'msg meta';
              var atMb = document.createElement('div');
              atMb.className = 'msg-meta';
              atMb.style.cssText = 'background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.3);color:#22c55e';
              atMb.textContent = '📋 ' + ev.fromName + ' assigned "' + ev.title + '" to ' + ev.toName + (ev.executing ? ' (executing now)' : '');
              atMeta.appendChild(atMb);
              document.getElementById('chat-messages').insertBefore(atMeta, assistantDiv);
              document.getElementById('chat-messages').scrollTop = 9999;
              bumpTaskBadge();
            } else if (ev.type === 'done') {
              assistantDiv.classList.remove('streaming');
              chatStreaming = false;
              document.getElementById('chat-send').disabled = false;
            } else if (ev.type === 'error') {
              bubbleEl.textContent = '⚠ ' + ev.message;
              assistantDiv.classList.remove('streaming');
              chatStreaming = false;
              document.getElementById('chat-send').disabled = false;
            }
          } catch(_) {}
        });
        return read();
      });
    }
    return read();
  }).catch(function(e) {
    bubbleEl.textContent = '⚠ ' + e.message;
    assistantDiv.classList.remove('streaming');
    chatStreaming = false;
    document.getElementById('chat-send').disabled = false;
  });
}

document.getElementById('chat-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});

/* ── Config change SSE ──────────────────────────────────────────────────────── */
function connectConfigWatch() {
  var url = '/api/config/watch?token=' + encodeURIComponent(token);
  var es  = new EventSource(url);
  var dot = document.querySelector('#cfg-live .ldot');

  es.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      if (data.type === 'connected') {
        dot.classList.remove('off');
      } else if (data.type === 'config_changed') {
        loadConfig();
        showToast('⚙️  .env changed — config refreshed', 4000);
        if (current === 'overview') loadOverview();
      }
    } catch(_) {}
  };

  es.onerror = function() {
    dot.classList.add('off');
    es.close();
    setTimeout(connectConfigWatch, 5000);
  };
}

/* ── Background task watcher SSE ────────────────────────────────────────── */
function connectTaskWatch() {
  var url = '/api/tasks/watch?token=' + encodeURIComponent(token);
  var es  = new EventSource(url);

  es.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      if (data.type === 'task_created') {
        bumpTaskBadge();
        showToast('📋 Task "' + data.title + '" assigned to ' + data.toName, 4000);
      } else if (data.type === 'task_complete') {
        // Show the completed sub-agent result as a new message bubble
        var container = document.getElementById('chat-messages');
        if (container) {
          var meta = document.createElement('div');
          meta.className = 'msg meta';
          var mb = document.createElement('div');
          mb.className = 'msg-meta spawn';
          mb.textContent = '✅ Sub-agent "' + data.agentName + '" completed';
          meta.appendChild(mb);
          container.appendChild(meta);

          // Add the result as a message
          var div = document.createElement('div');
          div.className = 'msg assistant';
          var who = document.createElement('div');
          who.className = 'msg-who';
          who.textContent = data.agentName + ' (completed)';
          var bubble = document.createElement('div');
          bubble.className = 'msg-bubble';
          bubble.textContent = data.result || '(no output)';
          div.appendChild(who);
          div.appendChild(bubble);
          container.appendChild(div);
          container.scrollTop = container.scrollHeight;
        }
        showToast('✅ Sub-agent "' + data.agentName + '" completed', 4000);
        // Refresh agents tab to show deactivation
        if (current === 'agents') loadAgents();
      } else if (data.type === 'task_failed') {
        var container = document.getElementById('chat-messages');
        if (container) {
          var meta = document.createElement('div');
          meta.className = 'msg meta';
          var mb = document.createElement('div');
          mb.className = 'msg-meta';
          mb.style.background = 'rgba(248,81,73,.1)';
          mb.style.borderColor = 'rgba(248,81,73,.3)';
          mb.style.color = 'var(--red)';
          mb.textContent = '⚠ Sub-agent "' + data.agentName + '" failed: ' + (data.error || 'unknown error');
          meta.appendChild(mb);
          container.appendChild(meta);
          container.scrollTop = container.scrollHeight;
        }
        showToast('⚠ Sub-agent "' + data.agentName + '" failed', 5000);
        if (current === 'agents') loadAgents();
      }
    } catch(_) {}
  };

  es.onerror = function() {
    es.close();
    setTimeout(connectTaskWatch, 5000);
  };
}

/* ── Navigation ─────────────────────────────────────────────────────────────── */
var loaders = {
  overview: loadOverview,
  chat:     loadChatAgents,
  agents:   loadAgents,
  tasks:    loadTasks,
  sessions: loadSessions,
  memory:   loadMemory,
  config:   loadConfig,
  analytics:loadAnalytics,
  hive:     loadHive,
  comms:    loadComms,
  logs:     loadLogs
};
var current = 'overview';

var taskBadgeCount = 0;
function bumpTaskBadge() {
  if (current === 'tasks') { loadTasks(); return; }
  taskBadgeCount++;
  var b = document.getElementById('tasks-badge');
  if (b) { b.textContent = String(taskBadgeCount); b.style.display = 'inline'; }
}
function clearTaskBadge() {
  taskBadgeCount = 0;
  var b = document.getElementById('tasks-badge');
  if (b) { b.style.display = 'none'; b.textContent = '0'; }
}

function show(name) {
  document.querySelectorAll('.section').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('nav a').forEach(function(el) { el.classList.remove('active'); });
  var sec  = document.getElementById('s-' + name);
  var link = document.querySelector('[data-s="' + name + '"]');
  if (sec)  sec.classList.add('active');
  if (link) link.classList.add('active');
  current = name;
  if (name === 'tasks') clearTaskBadge();
  load(name);
}

function load(name) { if (loaders[name]) loaders[name](); }
function refresh()  { load(current); }

document.querySelectorAll('nav a[data-s]').forEach(function(a) {
  a.addEventListener('click', function(e) {
    e.preventDefault();
    show(a.getAttribute('data-s'));
  });
});

/* ── Auto-refresh ───────────────────────────────────────────────────────────── */
var countdown = 30;
setInterval(function() {
  countdown--;
  var ri = document.getElementById('ri');
  if (ri) ri.textContent = 'Auto-refresh: ' + countdown + 's';
  if (countdown <= 0) { countdown = 30; if (current !== 'chat') refresh(); }
}, 1000);

/* ── Init ───────────────────────────────────────────────────────────────────── */
loadOverview();
connectConfigWatch();
connectTaskWatch();
</script>
</body>
</html>`;
}
