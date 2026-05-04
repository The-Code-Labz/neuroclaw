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
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 720, maxHeight: '88vh', overflow: 'auto', padding: 22 }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
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
          <div>
            {task && <button className="nc-btn ghost" style={{ color: 'var(--danger)' }} onClick={archive} disabled={busy}>Archive</button>}
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
          ? <span style={{ width: 18, height: 18, borderRadius: 4, background: 'rgba(0,183,255,0.15)', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700 }}>{agent.name[0]}</span>
          : null}
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>{task.assignee}</span>
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

const Tasks = () => {
  const data = window.NC_DATA;
  const projects = data.PROJECTS || [];
  const agents   = data.AGENTS   || [];
  const allTasks = data.TASKS    || [];

  // Project switcher: '' = all projects, otherwise project id
  const [activeProject, setActiveProject] = React.useState('');
  const [view, setView] = React.useState('board'); // 'board' | 'table'
  const [filter, setFilter]   = React.useState('');
  const [taskModal, setTaskModal] = React.useState({ open: false, task: null });
  const [projectModal, setProjectModal] = React.useState({ open: false, project: null });

  // Pick a default project once projects load (pinned ones float first).
  React.useEffect(() => {
    if (!activeProject && projects.length > 0) setActiveProject(projects[0].id);
  }, [projects.length]);

  const visibleTasks = React.useMemo(() => {
    let xs = allTasks.filter(t => !t.archived);
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

  return (
    <div>
      <PageHeader
        title="Mission Control"
        subtitle="// projects · tasks · drag to move · click to edit"
        right={<>
          <span className="tag muted">{counts.todo} todo</span>
          <span className="tag blue">{counts.doing} doing</span>
          <span className="tag amber">{counts.review} review</span>
          <span className="tag green">{counts.done} done</span>
          <button className="nc-btn" onClick={() => window.NC_LIVE.refresh()}><Icon name="refresh" size={12}/> Refresh</button>
          <button className="nc-btn primary" onClick={() => setTaskModal({ open: true, task: null })}><Icon name="plus" size={12}/> New Task</button>
        </>}
      />

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
          <button className={`nc-btn ${view === 'board' ? 'primary' : 'ghost'}`} onClick={() => setView('board')} style={{ borderRadius: 0 }}>Board</button>
          <button className={`nc-btn ${view === 'table' ? 'primary' : 'ghost'}`} onClick={() => setView('table')} style={{ borderRadius: 0 }}>Table</button>
        </div>
      </div>

      {view === 'board' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {STATUS_COLS.map(c => {
            const items = visibleTasks
              .filter(t => t.status === c.id)
              .sort((a, b) => (a.task_order || 0) - (b.task_order || 0));
            return (
              <div key={c.id}
                   className="nc-panel"
                   onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                   onDrop={(e) => onDropColumn(e, c.id)}
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
                    <div className="mono muted" style={{ fontSize: 10, textAlign: 'center', padding: 18, border: '1px dashed rgba(0,183,255,0.1)', borderRadius: 2 }}>// drop here</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'table' && (
        <div className="nc-panel" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'rgba(0,183,255,0.06)', textAlign: 'left' }}>
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
                  <tr key={t.id} style={{ borderBottom: '1px dashed rgba(0,183,255,0.06)', cursor: 'pointer' }} onClick={() => setTaskModal({ open: true, task: t })}>
                    <td style={{ padding: '8px 10px', color: 'var(--text)' }}>{t.title}</td>
                    <td style={{ padding: '8px 10px' }}><span className="tag" style={{ fontSize: 9 }}>{t.status}</span></td>
                    <td style={{ padding: '8px 10px' }}><span className={`tag ${pTone}`} style={{ fontSize: 9 }}>{t.priority_level}</span></td>
                    <td style={{ padding: '8px 10px' }}>{agent ? '@' + agent.name : t.assignee}</td>
                    <td style={{ padding: '8px 10px' }}>{t.feature ? '#' + t.feature : <span className="muted">—</span>}</td>
                    <td style={{ padding: '8px 10px' }}>{(t.sources || []).length + (t.code_examples || []).length || <span className="muted">—</span>}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-soft)' }}>{(t._raw?.updated_at || '').slice(11, 19) || '—'}</td>
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

      <TaskEditModal open={taskModal.open} task={taskModal.task} projects={projects} agents={agents} onClose={() => setTaskModal({ open: false, task: null })}/>
      <ProjectModal  open={projectModal.open} project={projectModal.project} onClose={() => setProjectModal({ open: false, project: null })}/>
    </div>
  );
};

window.Tasks = Tasks;
