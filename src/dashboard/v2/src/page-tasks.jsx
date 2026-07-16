/* Tasks - Mission Control (Archon-port v1.9: projects + Kanban + sources/code_examples)
 *
 * - Project switcher (default: NeuroClaw)
 * - Board (Kanban, HTML5 native drag-drop) ↔ Table view toggle
 * - Drag a card across columns → PATCH {status, task_order}
 * - TaskEditModal exposes every Archon field: priority_level, assignee (free-text),
 *   feature label, parent_task_id, sources/code_examples (JSON for now; PR 5 adds
 *   the NeuroVault picker), archive
 */

const PRIORITY_TONE = { critical: 'red', high: 'amber', medium: 'blue', low: 'muted' };
const STATUS_COLS = [
  { id: 'todo',   label: 'TODO',   tone: 'muted' },
  { id: 'doing',  label: 'DOING',  tone: 'cyan'  },
  { id: 'review', label: 'REVIEW', tone: 'amber' },
  { id: 'done',   label: 'DONE',   tone: 'green' },
  // Read-only bucket for terminal/parked states so they don't vanish from the
  // board (failed/blocked/cancelled have no column of their own). Not a drop
  // target — `statuses` set means it aggregates rather than maps to one status.
  { id: 'closed', label: 'CLOSED', tone: 'red', statuses: ['failed', 'blocked', 'cancelled'] },
];

const TaskEditModal = ({ open, task, projects, agents, onClose, onSaved }) => {
  const [title,         setTitle]         = React.useState('');
  const [description,   setDescription]   = React.useState('');
  const [status,        setStatus]        = React.useState('todo');
  const [priorityLevel, setPriorityLevel] = React.useState('medium');
  const [projectId,     setProjectId]     = React.useState('');
  const [parentId,      setParentId]      = React.useState('');
  const [assignee,      setAssignee]      = React.useState('User');
  const [feature,       setFeature]       = React.useState('');
  const [sourcesJson,   setSourcesJson]   = React.useState('[]');
  const [examplesJson,  setExamplesJson]  = React.useState('[]');
  const [busy, setBusy] = React.useState(false);
  const [err,  setErr]  = React.useState(null);

  React.useEffect(() => {
    if (!open) return;
    if (task) {
      setTitle(task.title || '');
      setDescription(task.description || '');
      setStatus(task.status || 'todo');
      setPriorityLevel(task.priority_level || 'medium');
      setProjectId(task.project_id || '');
      setParentId(task.parent_task_id || '');
      setAssignee(task.assignee || 'User');
      setFeature(task.feature || '');
      setSourcesJson(JSON.stringify(task.sources || [], null, 2));
      setExamplesJson(JSON.stringify(task.code_examples || [], null, 2));
    } else {
      setTitle(''); setDescription(''); setStatus('todo'); setPriorityLevel('medium');
      setProjectId(projects[0]?.id || '');
      setParentId(''); setAssignee('User'); setFeature('');
      setSourcesJson('[]'); setExamplesJson('[]');
    }
    setErr(null);
  }, [open, task, projects]);

  if (!open) return null;

  const submit = async () => {
    if (!title.trim()) { setErr('title required'); return; }
    let sources, code_examples;
    try { sources = JSON.parse(sourcesJson || '[]'); }
    catch { setErr('sources is not valid JSON'); return; }
    try { code_examples = JSON.parse(examplesJson || '[]'); }
    catch { setErr('code_examples is not valid JSON'); return; }
    setBusy(true); setErr(null);
    try {
      const body = {
        title:          title.trim(),
        description:    description.trim() || null,
        status,
        priority_level: priorityLevel,
        project_id:     projectId || null,
        parent_task_id: parentId  || null,
        assignee:       assignee.trim() || 'User',
        feature:        feature.trim()  || null,
        sources, code_examples,
      };
      if (task) {
        const r = await fetch('/api/tasks/' + task.id, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${r.status} ${await r.text().then(t => t.slice(0, 120))}`);
      } else {
        const r = await fetch('/api/tasks', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${r.status} ${await r.text().then(t => t.slice(0, 120))}`);
      }
      await window.NC_LIVE.refresh();
      onSaved && onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const archive = async () => {
    if (!task) return;
    if (!confirm(`Archive task "${task.title}"?`)) return;
    setBusy(true);
    try {
      const r = await fetch('/api/tasks/' + task.id, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      await window.NC_LIVE.refresh();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const allTasks = (window.NC_DATA.TASKS || []).filter(t => t.id !== task?.id);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: '90%', maxWidth: 720, maxHeight: '88vh', overflow: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div className="label-tiny neonc">{task ? 'EDIT TASK' : 'NEW TASK'}</div>
          <button className="nc-btn ghost" onClick={onClose}>✕</button>
        </div>
        {err && <div className="mono dangerc" style={{ fontSize: 11, marginBottom: 8 }}>// {err}</div>}

        <div className="field"><label>Title</label><input className="nc-input" value={title} onChange={e => setTitle(e.target.value)} autoFocus/></div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Description</label>
          <textarea className="nc-input" rows={3} value={description} onChange={e => setDescription(e.target.value)}/>
        </div>

        <div className="grid-responsive-sm" style={{ marginTop: 10 }}>
          <div className="field">
            <label>Status</label>
            <select className="nc-select" value={status} onChange={e => setStatus(e.target.value)}>
              {STATUS_COLS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Priority</label>
            <select className="nc-select" value={priorityLevel} onChange={e => setPriorityLevel(e.target.value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div className="field">
            <label>Assignee <span className="muted" style={{ fontSize: 10 }}>(free text)</span></label>
            <input className="nc-input" list="task-assignee-suggestions" value={assignee} onChange={e => setAssignee(e.target.value)}/>
            <datalist id="task-assignee-suggestions">
              <option value="User"/>
              <option value="AI IDE Agent"/>
              {agents.map(a => <option key={a._raw?.id || a.id} value={a.name}/>)}
            </datalist>
          </div>
        </div>

        <div className="grid-responsive-sm" style={{ marginTop: 10 }}>
          <div className="field">
            <label>Project</label>
            <select className="nc-select" value={projectId} onChange={e => setProjectId(e.target.value)}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Parent task <span className="muted" style={{ fontSize: 10 }}>(subtask)</span></label>
            <select className="nc-select" value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">— none —</option>
              {allTasks.filter(t => !projectId || t.project_id === projectId).map(t => (
                <option key={t.id} value={t.id}>{t.title.slice(0, 60)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field" style={{ marginTop: 10 }}>
          <label>Feature label <span className="muted" style={{ fontSize: 10 }}>(free text — cuts across projects)</span></label>
          <input className="nc-input" value={feature} onChange={e => setFeature(e.target.value)} placeholder="e.g. auth, billing, onboarding"/>
        </div>

        <div className="field" style={{ marginTop: 10 }}>
          <label>Sources <span className="muted" style={{ fontSize: 10 }}>(JSON array of citations — vault notes, URLs)</span></label>
          <textarea className="nc-input" rows={3} value={sourcesJson} onChange={e => setSourcesJson(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}/>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Code examples <span className="muted" style={{ fontSize: 10 }}>(JSON array of {`{file, line, summary}`})</span></label>
          <textarea className="nc-input" rows={3} value={examplesJson} onChange={e => setExamplesJson(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}/>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {task && <button className="nc-btn ghost" style={{ color: 'var(--danger)' }} onClick={archive} disabled={busy}>Archive</button>}
            {task && <button className="nc-btn ghost" style={{ color: 'var(--danger)', borderColor: 'rgba(255,59,48,0.4)' }} onClick={async () => {
              if (!confirm(`Permanently delete "${task.title}"? This cannot be undone.`)) return;
              setBusy(true);
              try {
                const r = await fetch('/api/tasks/' + task.id, { method: 'DELETE', credentials: 'same-origin' });
                if (!r.ok) throw new Error(`${r.status}`);
                await window.NC_LIVE.refresh();
                onClose();
              } catch (e) { setErr(e.message); }
              finally { setBusy(false); }
            }} disabled={busy}>Delete</button>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="nc-btn ghost" onClick={onClose}>Cancel</button>
            <button className="nc-btn primary" onClick={submit} disabled={busy}>{busy ? '…' : (task ? 'Save' : 'Create')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const ProjectModal = ({ open, project, onClose, onSaved }) => {
  const [title,       setTitle]       = React.useState('');
  const [description, setDescription] = React.useState('');
  const [githubRepo,  setGithubRepo]  = React.useState('');
  const [pinned,      setPinned]      = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err,  setErr]  = React.useState(null);

  React.useEffect(() => {
    if (!open) return;
    if (project) {
      setTitle(project.title || ''); setDescription(project.description || '');
      setGithubRepo(project.github_repo || ''); setPinned(!!project.pinned);
    } else {
      setTitle(''); setDescription(''); setGithubRepo(''); setPinned(false);
    }
    setErr(null);
  }, [open, project]);

  if (!open) return null;

  const submit = async () => {
    if (!title.trim()) { setErr('title required'); return; }
    setBusy(true); setErr(null);
    try {
      const body = { title: title.trim(), description: description.trim() || null, github_repo: githubRepo.trim() || null, pinned };
      const url    = project ? `/api/projects/${project.id}` : '/api/projects';
      const method = project ? 'PATCH' : 'POST';
      const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${r.status}`);
      await window.NC_LIVE.refresh();
      onSaved && onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 480, padding: 20 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 14 }}>{project ? 'EDIT PROJECT' : 'NEW PROJECT'}</div>
        {err && <div className="mono dangerc" style={{ fontSize: 11, marginBottom: 8 }}>// {err}</div>}
        <div className="field"><label>Title</label><input className="nc-input" value={title} onChange={e => setTitle(e.target.value)} autoFocus/></div>
        <div className="field" style={{ marginTop: 10 }}><label>Description</label><textarea className="nc-input" rows={2} value={description} onChange={e => setDescription(e.target.value)}/></div>
        <div className="field" style={{ marginTop: 10 }}><label>GitHub repo</label><input className="nc-input" value={githubRepo} onChange={e => setGithubRepo(e.target.value)} placeholder="https://github.com/owner/repo"/></div>
        <div className="field" style={{ marginTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} style={{ width: 'auto' }}/>
            <span>Pin to top of project list</span>
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="nc-btn ghost" onClick={onClose}>Cancel</button>
          <button className="nc-btn primary" onClick={submit} disabled={busy}>{busy ? '…' : (project ? 'Save' : 'Create')}</button>
        </div>
      </div>
    </div>
  );
};

const TaskCard = ({ task, agents, onEdit, onDragStart }) => {
  const agent = agents.find(a => (a._raw?.id || a.id) === task.agentId);
  const pTone = PRIORITY_TONE[task.priority_level] || 'muted';
  const sourcesCount = (task.sources || []).length;
  const examplesCount = (task.code_examples || []).length;
  return (
    <div className="nc-panel tilt"
         draggable
         onDragStart={(e) => onDragStart(e, task)}
         onClick={() => onEdit(task)}
         style={{ padding: 10, background: 'rgba(2,6,23,0.7)', cursor: 'grab', userSelect: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, gap: 6 }}>
        <span className="mono muted" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.shortId}</span>
        <span className={`tag ${pTone}`} style={{ fontSize: 9, padding: '0 5px' }}>{(task.priority_level || 'medium').toUpperCase()}</span>
      </div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4, marginBottom: 8 }}>{task.title}</div>
      {task.feature && <span className="tag" style={{ fontSize: 9, padding: '0 5px', marginBottom: 6, display: 'inline-block' }}>#{task.feature}</span>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        {agent
          ? <span style={{ width: 18, height: 18, borderRadius: 4, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700 }}>{agent.name[0]}</span>
          : null}
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>{agent ? '@' + agent.name : (task.assignee || 'Unassigned')}</span>
      </div>
      {(sourcesCount > 0 || examplesCount > 0) && (
        <div className="mono muted" style={{ fontSize: 10, display: 'flex', gap: 8 }}>
          {sourcesCount > 0  && <span title="sources attached">📎 {sourcesCount}</span>}
          {examplesCount > 0 && <span title="code examples">{`{ }`} {examplesCount}</span>}
        </div>
      )}
    </div>
  );
};

// Autonomous Mission Control loop control. Polls /api/autonomous/status and
// lets the user start/stop the self-driving task-drainer. Self-contained so it
// can live above the board without threading state through Tasks.
const AutonomousBar = () => {
  const [status, setStatus] = React.useState(null);
  const [maxTasks, setMaxTasks] = React.useState(''); // blank = drain the whole board
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/autonomous/status', { credentials: 'same-origin' });
      if (res.ok) setStatus(await res.json());
    } catch { /* keep prior status */ }
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/autonomous/start', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxTasks: Number(maxTasks) || undefined }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || r.ok === false) throw new Error(r.error || r.reason || `start failed (${res.status})`);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setErr(null);
    try {
      await fetch('/api/autonomous/stop', { method: 'POST', credentials: 'same-origin' });
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const running = !!status?.running;
  const worked  = status?.worked || [];
  const done    = worked.filter(w => w.outcome === 'done').length;

  return (
    <div className="nc-panel" style={{ padding: '9px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderColor: running ? 'var(--accent)' : 'var(--line)' }}>
      <span className="label-tiny neonc" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <span className={`dot ${running ? 'cyan pulse' : 'muted'}`}/> <Icon name="bolt" size={12}/> AUTONOMOUS MODE
      </span>
      {running ? (
        <>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-soft)' }}>
            working {worked.length} · {done} done · {status.skipped || 0} skipped{status.currentTaskId ? ' · running a task…' : ''}
          </span>
          <button className="nc-btn" disabled={busy} onClick={stop} style={{ marginLeft: 'auto' }}>
            <Icon name="pause" size={12}/> Stop
          </button>
        </>
      ) : (
        <>
          <span className="mono muted" style={{ fontSize: 11 }}>
            {status?.stopReason
              ? `last run: ${worked.length} worked · ${done} done (${status.stopReason})`
              : 'idle — works the whole todo board until done, parks finished tasks at review'}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <label className="mono muted" style={{ fontSize: 10 }}>limit</label>
            <input className="nc-input" type="number" min="1" placeholder="all" value={maxTasks} onChange={e => setMaxTasks(e.target.value)} title="Optional — leave blank to drain the whole board" style={{ width: 52, fontSize: 11 }}/>
            <button className="nc-btn primary" disabled={busy} onClick={start}><Icon name="play" size={12}/> Start</button>
          </span>
        </>
      )}
      {err && <span className="mono dangerc" style={{ fontSize: 10, width: '100%' }}>{err}</span>}
    </div>
  );
};

const Tasks = () => {
  const data = window.NC_DATA;
  const projects = data.PROJECTS || [];
  const agents   = data.AGENTS   || [];
  const allTasks = data.TASKS    || [];

  // Project switcher: '' = all projects, otherwise project id
  const [activeProject, setActiveProject] = React.useState('');
  const [view, setView] = React.useState('board'); // 'board' | 'table' | 'archive'
  const [filter, setFilter]   = React.useState('');
  const [taskModal, setTaskModal] = React.useState({ open: false, task: null });
  const [projectModal, setProjectModal] = React.useState({ open: false, project: null });

  // Archive view state — fetched on demand, not part of the main NC_DATA refresh
  const [archivedTasks, setArchivedTasks] = React.useState([]);
  const [archiveLoading, setArchiveLoading] = React.useState(false);
  const [archiveErr, setArchiveErr] = React.useState(null);

  const loadArchive = React.useCallback(async () => {
    setArchiveLoading(true); setArchiveErr(null);
    try {
      const res = await fetch('/api/tasks?include_archived=1', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status}`);
      const rows = await res.json();
      setArchivedTasks((Array.isArray(rows) ? rows : []).filter(t => t.archived));
    } catch (e) { setArchiveErr(e.message); }
    finally { setArchiveLoading(false); }
  }, []);

  React.useEffect(() => {
    if (view === 'archive') loadArchive();
  }, [view]);

  const unarchive = async (task) => {
    try {
      const r = await fetch('/api/tasks/' + task.id, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      await window.NC_LIVE.refresh();
      loadArchive();
    } catch (e) { alert('Unarchive failed: ' + e.message); }
  };

  // Pick a default project once projects load (pinned ones float first).
  React.useEffect(() => {
    if (!activeProject && projects.length > 0) setActiveProject(projects[0].id);
  }, [projects.length]);

  const visibleTasks = React.useMemo(() => {
    // Background tasks (spawned sub-agent plumbing) are not human-managed board
    // work — keep them off the kanban so they don't clutter / get dragged.
    let xs = allTasks.filter(t => !t.archived && t.task_source !== 'background');
    if (activeProject) xs = xs.filter(t => t.project_id === activeProject);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      xs = xs.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.feature || '').toLowerCase().includes(q) ||
        (t.assignee || '').toLowerCase().includes(q),
      );
    }
    return xs;
  }, [allTasks, activeProject, filter]);

  const counts = React.useMemo(() => {
    const c = { todo: 0, doing: 0, review: 0, done: 0 };
    visibleTasks.forEach(t => { if (c[t.status] !== undefined) c[t.status]++; });
    return c;
  }, [visibleTasks]);

  // Drag-drop. dataTransfer carries the task id; the drop column reads it,
  // bumps the status, and uses (max task_order in target column + 10) so the
  // dropped card lands at the bottom. Inter-card reorder within a column is
  // intentionally simple here — full row-level reorder is a polish PR.
  const onDragStart = (e, task) => {
    e.dataTransfer.setData('application/x-nc-task-id', task.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDropColumn = async (e, status) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('application/x-nc-task-id');
    if (!id) return;
    const t = allTasks.find(x => x.id === id);
    if (!t || t.status === status) return;
    const targetMax = visibleTasks
      .filter(x => x.status === status)
      .reduce((m, x) => Math.max(m, x.task_order ?? 0), 0);
    try {
      const r = await fetch('/api/tasks/' + id, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, task_order: targetMax + 10 }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      await window.NC_LIVE.refresh();
    } catch (err) { alert('Drop failed: ' + err.message); }
  };

  const archiveProject = async () => {
    if (!activeProject) return;
    const p = projects.find(x => x.id === activeProject);
    if (!p) return;
    if (!confirm(`Archive project "${p.title}"? Tasks remain. NeuroClaw default project cannot be archived.`)) return;
    try {
      const r = await fetch('/api/projects/' + activeProject, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) throw new Error(`${r.status}`);
      await window.NC_LIVE.refresh();
      setActiveProject('');
    } catch (err) { alert('Archive failed: ' + err.message); }
  };

  const activeProjectObj = projects.find(p => p.id === activeProject);

  // Bulk-archive (soft delete → recoverable from the Archive view). status='done'
  // sweeps completed work; status=null clears every active task. Scoped to the
  // project currently in view so it matches what the user sees.
  const [archiving, setArchiving] = React.useState(false);
  const archiveAll = async (status) => {
    const what  = status === 'done' ? 'completed (done) tasks' : 'ALL active tasks';
    const scope = activeProject ? ' in this project' : ' across all projects';
    const matching = visibleTasks.filter(t => !status || t.status === status).length;
    if (matching === 0) { alert(`No ${status === 'done' ? 'done' : 'active'} tasks to archive.`); return; }
    if (!confirm(`Archive ${matching} ${what}${scope}? They move to the Archive view (recoverable), clearing the board.`)) return;
    setArchiving(true);
    try {
      const res = await fetch('/api/tasks/archive-all', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(status ? { status } : {}), ...(activeProject ? { project_id: activeProject } : {}) }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || r.ok === false) throw new Error(r.error || `${res.status}`);
      await window.NC_LIVE.refresh();
    } catch (err) { alert('Archive failed: ' + err.message); }
    finally { setArchiving(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 56px - 32px - 44px)' }}>
      <PageHeader
        title="Mission Control"
        subtitle="// projects · tasks · drag to move · click to edit"
        right={<>
          <span className="tag muted">{counts.todo} todo</span>
          <span className="tag blue">{counts.doing} doing</span>
          <span className="tag amber">{counts.review} review</span>
          <span className="tag green">{counts.done} done</span>
          <button className="nc-btn" disabled={archiving} onClick={() => archiveAll('done')} title="Archive completed (done) tasks">Sweep Done</button>
          <button className="nc-btn" disabled={archiving} onClick={() => archiveAll(null)} title="Archive ALL active tasks (clears the board)" style={{ color: 'var(--danger)', borderColor: 'rgba(251,59,95,0.4)' }}><Icon name="close" size={12}/> Archive All</button>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
          <button className="nc-btn primary" onClick={() => setTaskModal({ open: true, task: null })}><Icon name="plus" size={12}/> New Task</button>
        </>}
      />

      <AutonomousBar />

      {/* Project switcher + view toggle */}
      <div className="nc-panel" style={{ padding: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="label-tiny neonc">PROJECT</span>
        <select className="nc-select" value={activeProject} onChange={e => setActiveProject(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">— All projects —</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.pinned ? '★ ' : ''}{p.title}</option>
          ))}
        </select>
        <button className="nc-btn ghost" onClick={() => setProjectModal({ open: true, project: null })} title="New project">+ Project</button>
        {activeProjectObj && (
          <>
            <button className="nc-btn ghost" onClick={() => setProjectModal({ open: true, project: activeProjectObj })} title="Edit project">Edit</button>
            <button className="nc-btn ghost" onClick={archiveProject} style={{ color: 'var(--danger)' }} title="Archive project">Archive</button>
          </>
        )}
        {activeProjectObj?.description && (
          <span className="mono muted" style={{ fontSize: 11, marginLeft: 8, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeProjectObj.description}
          </span>
        )}
        <span style={{ flex: 1 }}/>
        <input className="nc-input" placeholder="filter title / feature / assignee" value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 240 }}/>
        <div style={{ display: 'flex', gap: 0, border: '1px solid var(--line)' }}>
          <button className={`nc-btn ${view === 'board'   ? 'primary' : 'ghost'}`} onClick={() => setView('board')}   style={{ borderRadius: 0 }}>Board</button>
          <button className={`nc-btn ${view === 'table'   ? 'primary' : 'ghost'}`} onClick={() => setView('table')}   style={{ borderRadius: 0 }}>Table</button>
          <button className={`nc-btn ${view === 'archive' ? 'primary' : 'ghost'}`} onClick={() => setView('archive')} style={{ borderRadius: 0 }}>Archive</button>
        </div>
      </div>

      <div style={{ flex: 1 }}>
      {view === 'board' && (
        <div className="kanban-grid">
          {STATUS_COLS.map(c => {
            const items = visibleTasks
              .filter(t => c.statuses ? c.statuses.includes(t.status) : t.status === c.id)
              .sort((a, b) => (a.task_order || 0) - (b.task_order || 0));
            // Aggregate (closed) columns are read-only — not drop targets, since
            // they don't map to a single settable status.
            const isDropTarget = !c.statuses;
            return (
              <div key={c.id}
                   className="nc-panel"
                   onDragOver={isDropTarget ? ((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }) : undefined}
                   onDrop={isDropTarget ? ((e) => onDropColumn(e, c.id)) : undefined}
                   style={{ padding: 0, minHeight: 380 }}>
                <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className={`label-tiny ${c.tone === 'cyan' ? 'neonc' : c.tone === 'amber' ? 'amberc' : c.tone === 'green' ? 'greenc' : 'muted'}`}>{c.label}</span>
                  <span className={`tag ${c.tone === 'cyan' ? 'blue' : c.tone === 'amber' ? 'amber' : c.tone === 'green' ? 'green' : 'muted'}`} style={{ fontSize: 9 }}>{items.length}</span>
                </div>
                <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 320 }}>
                  {items.map(t => (
                    <TaskCard key={t.id} task={t} agents={agents} onDragStart={onDragStart} onEdit={(task) => setTaskModal({ open: true, task })}/>
                  ))}
                  {items.length === 0 && (
                    <div className="mono muted" style={{ fontSize: 10, textAlign: 'center', padding: 18, border: '1px dashed color-mix(in srgb, var(--accent) 10%, transparent)', borderRadius: 2 }}>// drop here</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'table' && (
        <div className="nc-panel table-responsive" style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'color-mix(in srgb, var(--accent) 6%, transparent)', textAlign: 'left' }}>
                {['Title','Status','Priority','Assignee','Feature','Sources','Updated',''].map(h => (
                  <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--text-soft)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map(t => {
                const agent = agents.find(a => (a._raw?.id || a.id) === t.agentId);
                const pTone = PRIORITY_TONE[t.priority_level] || 'muted';
                return (
                  <tr key={t.id} style={{ borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', cursor: 'pointer' }} onClick={() => setTaskModal({ open: true, task: t })}>
                    <td style={{ padding: '8px 10px', color: 'var(--text)' }}>{t.title}</td>
                    <td style={{ padding: '8px 10px' }}><span className="tag" style={{ fontSize: 9 }}>{t.status}</span></td>
                    <td style={{ padding: '8px 10px' }}><span className={`tag ${pTone}`} style={{ fontSize: 9 }}>{t.priority_level}</span></td>
                    <td style={{ padding: '8px 10px' }}>{agent ? '@' + agent.name : t.assignee}</td>
                    <td style={{ padding: '8px 10px' }}>{t.feature ? '#' + t.feature : <span className="muted">—</span>}</td>
                    <td style={{ padding: '8px 10px' }}>{(t.sources || []).length + (t.code_examples || []).length || <span className="muted">—</span>}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-soft)' }}>{(() => { const r = t._raw?.updated_at; if (!r) return '—'; const iso = r.includes('T') ? r : r.replace(' ', 'T') + 'Z'; const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true }); })()}</td>
                    <td style={{ padding: '8px 10px' }}><span className="muted">edit ›</span></td>
                  </tr>
                );
              })}
              {visibleTasks.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--text-soft)' }}>// no tasks match</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'archive' && (
        <div className="nc-panel table-responsive" style={{ padding: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label-tiny muted">ARCHIVED TASKS</span>
            <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={loadArchive} disabled={archiveLoading}>
              {archiveLoading ? '…' : 'Reload'}
            </button>
            {archiveErr && <span className="mono dangerc" style={{ fontSize: 10 }}>// {archiveErr}</span>}
            <span className="mono muted" style={{ fontSize: 10, marginLeft: 'auto' }}>{archivedTasks.length} archived</span>
          </div>
          {archiveLoading ? (
            <div className="mono muted" style={{ padding: 24, textAlign: 'center', fontSize: 11 }}>// loading…</div>
          ) : archivedTasks.length === 0 ? (
            <div className="mono muted" style={{ padding: 24, textAlign: 'center', fontSize: 11 }}>// no archived tasks</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'color-mix(in srgb, var(--accent) 6%, transparent)', textAlign: 'left' }}>
                  {['Title', 'Project', 'Status', 'Priority', 'Assignee', 'Feature', 'Archived At', ''].map(h => (
                    <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--text-soft)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {archivedTasks.map(t => {
                  const proj = projects.find(p => p.id === t.project_id);
                  const pTone = PRIORITY_TONE[t.priority_level] || 'muted';
                  return (
                    <tr key={t.id} style={{ borderBottom: '1px dashed color-mix(in srgb, var(--accent) 6%, transparent)', opacity: 0.75 }}>
                      <td style={{ padding: '8px 10px', color: 'var(--text)' }}>{t.title}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-soft)' }}>{proj?.title || <span className="muted">—</span>}</td>
                      <td style={{ padding: '8px 10px' }}><span className="tag" style={{ fontSize: 9 }}>{t.status}</span></td>
                      <td style={{ padding: '8px 10px' }}><span className={`tag ${pTone}`} style={{ fontSize: 9 }}>{t.priority_level || 'medium'}</span></td>
                      <td style={{ padding: '8px 10px' }}>{t.assignee || '—'}</td>
                      <td style={{ padding: '8px 10px' }}>{t.feature ? '#' + t.feature : <span className="muted">—</span>}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-soft)' }}>{(() => { const r = t.archived_at; if (!r) return '—'; const iso = r.includes('T') ? r : r.replace(' ', 'T') + 'Z'; const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); })()}</td>
                      <td style={{ padding: '8px 10px' }}>
                        <button className="nc-btn ghost" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => unarchive(t)}>Unarchive</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      <TaskEditModal open={taskModal.open} task={taskModal.task} projects={projects} agents={agents} onClose={() => setTaskModal({ open: false, task: null })}/>
      <ProjectModal  open={projectModal.open} project={projectModal.project} onClose={() => setProjectModal({ open: false, project: null })}/>
      </div>

      <AgentActivityPanel />
    </div>
  );
};

/* ── Agent Activity Panel (Paperclip-style transcript at bottom of Tasks) ── */

/* Infrastructure noise that shouldn't appear in the agent activity feed */
const ACTIVITY_NOISE_ACTIONS = new Set([
  'agent_heartbeat',
  'mcp_probe_ok',
  'job_claimed',
  'job_done',
  'job_quota_requeued',
  'sessions_cleaned_up',
  'cleanup_force_deleted_unarchived',
  'sentinel_check_in',
  'tasks_archived',
  'subtask_overflow_sequential',
]);

const ACTION_META = {
  auto_route:          { icon: '⇢', tone: 'cyan',   label: 'routed' },
  route_fallback:      { icon: '⇢', tone: 'amber',  label: 'fallback route' },
  manual_delegation:   { icon: '⇢', tone: 'blue',   label: 'delegated' },
  spawn_request:       { icon: '⊕', tone: 'violet', label: 'spawn request' },
  spawn_success:       { icon: '⊕', tone: 'violet', label: 'spawned' },
  spawn_denied:        { icon: '✗', tone: 'amber',  label: 'spawn denied' },
  agent_spawned:       { icon: '⊕', tone: 'violet', label: 'agent spawned' },
  agent_expired:       { icon: '○', tone: 'muted',  label: 'agent expired' },
  task_created:        { icon: '⊞', tone: 'cyan',   label: 'task created' },
  task_updated:        { icon: '✎', tone: 'blue',   label: 'task updated' },
  agent_activated:     { icon: '●', tone: 'green',  label: 'activated' },
  agent_deactivated:   { icon: '○', tone: 'muted',  label: 'deactivated' },
  mcp_agent_call_ok:   { icon: '✓', tone: 'green',  label: 'mcp ok' },
  mcp_agent_call_failed: { icon: '✗', tone: 'red',  label: 'mcp failed' },
  spawn_evaluated:     { icon: '◈', tone: 'violet', label: 'spawn eval' },
};

const TONE_COLOR = {
  cyan: 'var(--accent)', blue: 'var(--accent-2)', violet: 'var(--violet)',
  amber: 'var(--amber)', green: 'var(--green)', red: 'var(--danger)', muted: 'var(--muted)',
};

const AgentActivityPanel = () => {
  const [open,    setOpen]    = React.useState(true);
  const [entries, setEntries] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [paused,  setPaused]  = React.useState(false);
  const [bufLen,  setBufLen]  = React.useState(0);

  const pausedRef  = React.useRef(false);
  const bufRef     = React.useRef([]);
  const scrollRef  = React.useRef(null);

  const mapRow = (r) => ({
    id:      r.id,
    action:  r.action,
    agent:   r.agent_name || r.agent_id?.slice(0, 8) || '?',
    summary: r.summary || '',
    t:       (() => { if (!r.created_at) return '—'; const iso = r.created_at.includes('T') ? r.created_at : r.created_at.replace(' ', 'T') + 'Z'; const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true }); })(),
    meta:    (() => { try { return JSON.parse(r.metadata || '{}'); } catch { return {}; } })(),
  });

  const fetchHive = React.useCallback(async () => {
    setLoading(true);
    try {
      const rows = await window.NC_API.get('/api/hive?limit=200');
      setEntries(
        (Array.isArray(rows) ? rows : [])
          .filter(r => !ACTIVITY_NOISE_ACTIONS.has(r.action))
          .map(mapRow)
      );
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  // Initial load
  React.useEffect(() => { fetchHive(); }, [fetchHive]);

  // Auto-scroll to top when live (newest entries are at top)
  React.useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [entries.length, paused]);

  // Live SSE stream from /api/hive/stream
  React.useEffect(() => {
    let es;
    try {
      const tok = window.NC_API?.token;
      const sseUrl = tok ? `/api/hive/stream?token=${tok}` : '/api/hive/stream';
      es = new EventSource(sseUrl);
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type !== 'hive_event') return;
          if (ACTIVITY_NOISE_ACTIONS.has(ev.event?.action)) return;
          const entry = mapRow(ev.event);
          if (pausedRef.current) {
            bufRef.current.push(entry);
            setBufLen(bufRef.current.length);
          } else {
            setEntries(prev => [entry, ...prev.slice(0, 300)]);
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => {};
    } catch { /* SSE not supported */ }
    return () => { try { es?.close(); } catch { /* ignore */ } };
  }, []);

  const togglePause = (e) => {
    e.stopPropagation();
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next && bufRef.current.length > 0) {
      setEntries(prev => [...bufRef.current, ...prev].slice(0, 300));
      bufRef.current = [];
      setBufLen(0);
    }
  };

  return (
    <div className="nc-panel glow" style={{
      marginTop: 16, padding: 0,
      flex: open ? '1' : 'none',
      height: open ? undefined : 32,
      minHeight: open ? 160 : 32,
      overflow: 'hidden',
      transition: 'flex 0.2s ease, min-height 0.2s ease',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div onClick={() => setOpen(o => !o)} style={{
        padding: '0 14px', height: 32, flex: 'none',
        display: 'flex', alignItems: 'center', gap: 10,
        cursor: 'pointer', userSelect: 'none',
        borderBottom: open ? '1px solid var(--line-soft)' : 'none',
      }}>
        <span className="label-tiny" style={{ color: 'var(--accent)' }}>AGENT ACTIVITY</span>
        <span className="tag cyan" style={{ fontSize: 9, padding: '1px 5px' }}>{entries.length}</span>
        {loading && <span className="dot cyan pulse" style={{ width: 6, height: 6 }}/>}
        {!paused && open && <span className="dot cyan pulse" style={{ width: 5, height: 5 }}/>}
        <span style={{ flex: 1 }}/>
        {open && (
          <button
            className={`nc-btn ghost${paused ? ' amber' : ''}`}
            style={{ fontSize: 10, padding: '2px 8px', color: paused ? 'var(--amber)' : undefined }}
            onClick={togglePause}
          >
            {paused ? `▶ Resume (${bufLen} new)` : '⏸ Pause'}
          </button>
        )}
        <button className="nc-btn ghost" style={{ fontSize: 10, padding: '2px 8px' }}
                onClick={e => { e.stopPropagation(); fetchHive(); }}>Refresh</button>
        <span className="mono muted" style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      </div>

      {/* Entries */}
      {open && (
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '6px 16px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {entries.length === 0 && (
            <div className="mono muted" style={{ fontSize: 10, paddingTop: 8 }}>// no agent activity yet</div>
          )}
          {entries.map((e, i) => {
            const meta  = ACTION_META[e.action] || { icon: '·', tone: 'muted', label: e.action };
            const color = TONE_COLOR[meta.tone] || 'var(--muted)';
            return (
              <div key={e.id || i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0', borderBottom: '1px dashed color-mix(in srgb, var(--accent) 4%, transparent)' }}>
                <span style={{ color, fontSize: 10, fontFamily: 'var(--mono)', flexShrink: 0, width: 12, textAlign: 'center' }}>{meta.icon}</span>
                <span className="mono" style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0, width: 70 }}>{e.t}</span>
                <span className="mono" style={{ fontSize: 10, color, flexShrink: 0 }}>{meta.label}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>{e.agent}</span>
                {e.summary && (
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    · {e.summary.slice(0, 120)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

window.Tasks = Tasks;
