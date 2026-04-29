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
.agent-header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.agent-name{font-size:15px;font-weight:700}
.agent-meta{font-size:11px;color:var(--muted)}
.caps{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.agent-actions{display:flex;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--border)}
</style>
</head>
<body>
<aside id="sidebar">
  <div class="logo"><h1>⚡ NeuroClaw</h1><p>v1 Dashboard</p></div>
  <nav>
    <a data-s="overview"  class="active">📊 Overview</a>
    <a data-s="chat">💬 Chat</a>
    <a data-s="agents">🤖 Agents</a>
    <a data-s="tasks">📋 Tasks</a>
    <a data-s="sessions">🗂 Sessions</a>
    <a data-s="memory">🧠 Memory</a>
    <a data-s="config">⚙️ Config</a>
    <a data-s="analytics">📈 Analytics</a>
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
        <button class="btn btn-sm" onclick="newChat()">+ New Chat</button>
      </div>
    </div>
    <div class="chat-wrap">
      <div class="chat-toolbar">
        <span class="muted">Session:</span>
        <span id="chat-session-id">—</span>
        <span class="chat-hint">Tip: prefix with @AgentName to delegate</span>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-empty" id="chat-empty">Select an agent and type a message to start chatting</div>
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
    <div class="page-header"><h2>Memory</h2><button class="btn btn-primary" onclick="load('memory')">↻ Refresh</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>Content</th><th>Type</th><th>Importance</th><th>Created</th></tr></thead>
    <tbody id="tb-memory"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
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
    <div class="card" id="an-events"></div>
  </div>

  <!-- Logs -->
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
    <div class="field"><label>Model</label><input type="text" id="af-model" placeholder="gpt-5.1 (leave blank for default)"/></div>
    <div class="field"><label>Capabilities (comma-separated)</label><input type="text" id="af-caps" placeholder="research, summarize, fact-check"/></div>
    <div class="field"><label>System Prompt</label><textarea id="af-prompt" rows="7" placeholder="You are…"></textarea></div>
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
  var map = {active:'bg',done:'bg',todo:'bb',doing:'by',review:'bp',inactive:'br',orchestrator:'bo',specialist:'bp',assistant:'bb',agent:'bb'};
  return '<span class="badge ' + (map[status] || 'bb') + '">' + status + '</span>';
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

function openNewAgent() {
  editingAgentId = null;
  document.getElementById('agent-modal-title').textContent = 'New Agent';
  document.getElementById('af-name').value   = '';
  document.getElementById('af-desc').value   = '';
  document.getElementById('af-role').value   = 'specialist';
  document.getElementById('af-model').value  = '';
  document.getElementById('af-caps').value   = '';
  document.getElementById('af-prompt').value = '';
  document.getElementById('agent-modal').style.display = 'flex';
  setTimeout(function() { document.getElementById('af-name').focus(); }, 80);
}

function openEditAgent(id) {
  var a = agentCache[id];
  if (!a) return;
  editingAgentId = id;
  document.getElementById('agent-modal-title').textContent = 'Edit Agent — ' + a.name;
  document.getElementById('af-name').value   = a.name || '';
  document.getElementById('af-desc').value   = a.description || '';
  document.getElementById('af-role').value   = a.role || 'agent';
  document.getElementById('af-model').value  = a.model || '';
  var caps = [];
  try { caps = JSON.parse(a.capabilities || '[]'); } catch(_) {}
  document.getElementById('af-caps').value   = caps.join(', ');
  document.getElementById('af-prompt').value = a.system_prompt || '';
  document.getElementById('agent-modal').style.display = 'flex';
}

function submitAgent() {
  var name = document.getElementById('af-name').value.trim();
  if (!name) { showToast('Name is required', 3000); return; }

  var capsRaw = document.getElementById('af-caps').value.trim();
  var caps = capsRaw ? capsRaw.split(',').map(function(c) { return c.trim(); }).filter(Boolean) : [];
  var modelVal = document.getElementById('af-model').value.trim();

  var body = {
    name:          name,
    description:   document.getElementById('af-desc').value.trim(),
    role:          document.getElementById('af-role').value,
    model:         modelVal || undefined,
    capabilities:  caps,
    system_prompt: document.getElementById('af-prompt').value.trim()
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

/* ── Section loaders ────────────────────────────────────────────────────────── */
function loadOverview() {
  api('/api/status').then(function(s) {
    var cards = [
      {l:'Status',   v:'<span class="dot"></span>Online', sub:'System running'},
      {l:'Model',    v:s.model||'—',                      sub:'Active model'},
      {l:'Agents',   v:s.agents,                          sub:'Active agents'},
      {l:'Sessions', v:s.sessions,                        sub:'Total sessions'},
      {l:'Messages', v:s.messages,                        sub:'Total messages'},
      {l:'Uptime',   v:Math.floor(s.uptime)+'s',          sub:'Since last start'},
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

      return '<div class="agent-card' + (isActive ? '' : ' inactive') + '">'
        +'<div class="agent-header">'
        +'<div><div class="agent-name">'+esc(a.name)+'</div>'
        +'<div class="agent-meta">'+esc(a.description||'')+'</div>'
        +capsHtml+'</div>'
        +'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">'
        +badge(a.status)
        +badge(a.role)
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
  api('/api/memory').then(function(rows) {
    var tb = document.getElementById('tb-memory');
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">No memories stored</td></tr>'; return; }
    tb.innerHTML = rows.map(function(r) {
      return '<tr><td>'+esc(r.content)+'</td><td>'+esc(r.type)+'</td><td>'+r.importance+'/10</td><td class="muted">'+ago(r.created_at)+'</td></tr>';
    }).join('');
  }).catch(function(e) { document.getElementById('tb-memory').innerHTML = '<tr><td colspan="4">'+errHtml(e.message)+'</td></tr>'; });
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
    document.getElementById('an-stats').innerHTML = [
      {l:'Total Messages', v:d.total_messages},
      {l:'Total Sessions', v:d.total_sessions},
      {l:'Messages Today', v:d.messages_today},
      {l:'Total Tokens',   v:d.total_tokens},
    ].map(function(c) {
      return '<div class="card"><div class="card-label">'+c.l+'</div><div class="card-value">'+c.v+'</div></div>';
    }).join('');
    var evEl = document.getElementById('an-events');
    if (d.events_by_type && d.events_by_type.length) {
      evEl.innerHTML = '<div class="card-label" style="margin-bottom:10px">Events by Type</div>'
        +d.events_by_type.map(function(e) {
          return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)"><span>'+esc(e.event_type)+'</span><strong>'+e.count+'</strong></div>';
        }).join('');
    } else {
      evEl.innerHTML = '<div class="card-label">Events by Type</div><div class="muted" style="padding:10px 0">No events yet</div>';
    }
  }).catch(function(e) { document.getElementById('an-stats').innerHTML = '<div class="card">'+errHtml(e.message)+'</div>'; });
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
}

function newChat() {
  chatSessionId = null;
  chatRespondingAs = 'Agent';
  document.getElementById('chat-session-id').textContent = '—';
  document.getElementById('chat-messages').innerHTML =
    '<div class="chat-empty" id="chat-empty">Select an agent and type a message to start chatting</div>';
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
            } else if (ev.type === 'agent') {
              chatRespondingAs = ev.name;
              // Update the who label on the in-progress bubble
              var whoEl = assistantDiv.querySelector('.msg-who');
              if (whoEl) whoEl.textContent = ev.name;
            } else if (ev.type === 'chunk') {
              accText += ev.content;
              bubbleEl.textContent = accText;
              document.getElementById('chat-messages').scrollTop = 9999;
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
  logs:     loadLogs
};
var current = 'overview';

function show(name) {
  document.querySelectorAll('.section').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('nav a').forEach(function(el) { el.classList.remove('active'); });
  var sec  = document.getElementById('s-' + name);
  var link = document.querySelector('[data-s="' + name + '"]');
  if (sec)  sec.classList.add('active');
  if (link) link.classList.add('active');
  current = name;
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
</script>
</body>
</html>`;
}
