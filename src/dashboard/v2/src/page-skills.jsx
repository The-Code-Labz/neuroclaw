// Skills — manage SKILL.md files under .claude/skills/<name>/.
// Universal across providers because alfred.ts inlines the matching skill body
// into history[0] before the LLM call (regardless of agent runtime).

const Skills = () => {
  const { SKILLS } = window.NC_DATA;
  const [editing, setEditing]   = React.useState(null);   // { mode: 'edit'|'new'|'fromScript', ... }
  const [expanded, setExpanded] = React.useState({});      // skill name → bool
  const [scriptDraft, setScriptDraft] = React.useState({}); // skill name → { filename, content }
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = () => window.NC_LIVE?.refresh?.();

  const startNew = () => setEditing({
    mode: 'new', name: '', description: '', body: '', triggers: '', tools: '', always_on: false,
  });

  const startFromScript = () => setEditing({
    mode: 'fromScript', name: '', description: '', filename: '', content: '',
  });

  const startUpload = () => setEditing({
    mode: 'upload', name: '', filename: '', content: '',
  });

  const startInstall = () => setEditing({
    mode: 'install', kind: 'plugin', spec: '', running: false, output: '',
  });

  const startEdit = (s) => setEditing({
    mode:        'edit',
    name:        s.name,
    description: s.description || '',
    body:        s.body || '',
    triggers:    (s.triggers || []).join(', '),
    tools:       (s.tools    || []).join(', '),
    source:      s.source,
    always_on:   !!s.always_on,
  });

  const toggleAlwaysOn = async (s) => {
    setErr(null);
    const r = await fetch(`/api/skills/${encodeURIComponent(s.name)}/always-on`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !s.always_on }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || `HTTP ${r.status}`); return; }
    refresh();
  };

  const csv = (raw) => (raw || '').split(',').map(s => s.trim()).filter(Boolean);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      if (editing.mode === 'new') {
        if (!editing.name.trim() || !editing.body.trim()) throw new Error('name and body are required');
        await window.NC_API.post('/api/skills', {
          name:        editing.name.trim(),
          description: editing.description.trim(),
          body:        editing.body,
          triggers:    csv(editing.triggers),
          tools:       csv(editing.tools),
          always_on:   !!editing.always_on,
        });
      } else if (editing.mode === 'fromScript') {
        if (!editing.name.trim() || !editing.filename.trim() || !editing.content.trim()) {
          throw new Error('name, filename, and script content are required');
        }
        await window.NC_API.post('/api/skills/from-script', {
          name:        editing.name.trim(),
          description: editing.description.trim(),
          filename:    editing.filename.trim(),
          content:     editing.content,
        });
      } else if (editing.mode === 'upload') {
        if (!editing.content || !editing.content.trim()) throw new Error('paste or upload a SKILL.md first');
        const r = await fetch('/api/skills/upload', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content:  editing.content,
            name:     editing.name?.trim() || undefined,
            filename: editing.filename || undefined,
          }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      } else if (editing.mode === 'edit') {
        if (editing.source !== 'project') throw new Error('only project-local skills (.claude/skills/) can be edited');
        const r = await fetch(`/api/skills/${encodeURIComponent(editing.name)}`, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            description: editing.description,
            body:        editing.body,
            triggers:    csv(editing.triggers),
            tools:       csv(editing.tools),
            always_on:   !!editing.always_on,
          }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      }
      setEditing(null);
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (s) => {
    if (s.source !== 'project') { setErr('cannot delete user-global skills from this UI'); return; }
    if (!confirm(`Delete skill "${s.name}"? This removes its folder from .claude/skills/.`)) return;
    const r = await fetch(`/api/skills/${encodeURIComponent(s.name)}`, { method: 'DELETE', credentials: 'same-origin' });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || `HTTP ${r.status}`); return; }
    refresh();
  };

  const addScript = async (skillName) => {
    const draft = scriptDraft[skillName] || {};
    const filename = (draft.filename || '').trim();
    const content  = draft.content || '';
    if (!filename || !content.trim()) { setErr('script filename and content required'); return; }
    setErr(null);
    const r = await fetch(`/api/skills/${encodeURIComponent(skillName)}/scripts`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename, content }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || `HTTP ${r.status}`); return; }
    setScriptDraft(d => ({ ...d, [skillName]: { filename: '', content: '' } }));
    refresh();
  };

  const removeScript = async (skillName, filename) => {
    if (!confirm(`Delete script "${filename}" from skill "${skillName}"?`)) return;
    const r = await fetch(`/api/skills/${encodeURIComponent(skillName)}/scripts/${encodeURIComponent(filename)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || `HTTP ${r.status}`); return; }
    refresh();
  };

  const items = SKILLS || [];
  const alwaysOnNames = items.filter(s => s.always_on).map(s => `/${s.name}`);

  return (
    <div className="page page-skills">
      <PageHeader
        title="Skills"
        subtitle="// .claude/skills/*/SKILL.md · universal across all model providers · invoke via /<name> in chat"
        right={<>
          <button className="nc-btn ghost" onClick={refresh}><Icon name="refresh" size={12}/> Refresh</button>
          <button className="nc-btn" onClick={startFromScript}><Icon name="terminal" size={12}/> Script → Skill</button>
          <button className="nc-btn" onClick={startUpload}><Icon name="terminal" size={12}/> Upload SKILL.md</button>
          <button className="nc-btn" onClick={startInstall}><Icon name="terminal" size={12}/> Install Skill</button>
          <button className="nc-btn primary" onClick={startNew}>+ New Skill</button>
        </>}
      />

      {err && <div className="mono" style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 10 }}>// {err}</div>}

      <div className="nc-panel" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 11, color: 'var(--text-soft)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
        <span className="neonc">tip ▸</span> in chat type <code className="neonc">/skill-name [args]</code> to invoke a skill on the current turn — it&apos;s expanded into the prompt before send so it works for every agent regardless of provider.
      </div>

      {alwaysOnNames.length > 0 && (
        <div className="mono" style={{ fontSize: 11, marginBottom: 10 }}>
          <span className="tag green" style={{ fontSize: 9, marginRight: 6 }}>always-on:</span>
          {alwaysOnNames.join(', ')}
        </div>
      )}

      {editing && <SkillEditor editing={editing} setEditing={setEditing} submit={submit} cancel={() => { setEditing(null); setErr(null); }} busy={busy}/>}

      {items.length === 0 && !editing && (
        <div className="nc-panel" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>// no skills yet</div>
          <div className="muted" style={{ fontSize: 10 }}>
            Click <strong>+ New Skill</strong> to write a SKILL.md, or <strong>Script → Skill</strong> to wrap an existing
            shell/python/node script as a callable skill. Files land in <code>.claude/skills/&lt;name&gt;/</code>.
          </div>
        </div>
      )}

      {items.map(s => (
        <div key={s.name} className="nc-panel" style={{ marginBottom: 10, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <code className="neonc" style={{ fontSize: 13 }}>/{s.name}</code>
                <span className={`tag ${s.source === 'project' ? 'cyan' : s.source === 'plugin' ? 'amber' : s.source === 'marketplace' ? 'green' : 'violet'}`} style={{ fontSize: 9 }}>{s.source}</span>
                {s.plugin && <span className="muted mono" style={{ fontSize: 10 }}>· {s.plugin}</span>}
                {s.always_on && (
                  <span className="tag green" style={{ fontSize: 9 }}>ALWAYS ON</span>
                )}
                {(s.scripts || []).length > 0 && (
                  <span className="tag" style={{ fontSize: 9 }}>{s.scripts.length} script{s.scripts.length === 1 ? '' : 's'}</span>
                )}
                {(s.tools || []).length > 0 && (
                  <span className="muted mono" style={{ fontSize: 10 }}>· tools: {s.tools.join(', ')}</span>
                )}
              </div>
              {s.description && (
                <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{s.description}</div>
              )}
              <div className="muted mono" style={{ fontSize: 9, marginTop: 3, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.path}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => setExpanded(p => ({ ...p, [s.name]: !p[s.name] }))}>
                {expanded[s.name] ? 'Hide' : 'Body'}
              </button>
              <button
                className="nc-btn ghost"
                style={{ fontSize: 10, opacity: s.source === 'project' ? 1 : 0.5 }}
                disabled={s.source !== 'project'}
                title={s.source === 'project' ? 'Inject this skill into every agent\'s prompt' : 'user-global skills are read-only'}
                onClick={() => toggleAlwaysOn(s)}
              >
                {s.always_on ? 'Always off' : 'Always on'}
              </button>
              {s.source === 'project' && <button className="nc-btn ghost" style={{ fontSize: 10 }} onClick={() => startEdit(s)}>Edit</button>}
              {s.source === 'project' && <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => remove(s)}>×</button>}
            </div>
          </div>

          {expanded[s.name] && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div className="label-tiny" style={{ marginBottom: 6 }}>SKILL.md body</div>
              <pre className="mono" style={{ fontSize: 11, background: 'var(--bg-2)', padding: 10, borderRadius: 3, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {s.body || s.bodyPreview || '// (empty)'}
              </pre>

              {(s.scripts || []).length > 0 && (
                <>
                  <div className="label-tiny" style={{ marginTop: 14, marginBottom: 6 }}>SCRIPTS</div>
                  {s.scripts.map(fn => (
                    <div key={fn} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px dashed rgba(0,183,255,0.06)' }}>
                      <code className="mono" style={{ fontSize: 11 }}>{fn}</code>
                      {s.source === 'project' && (
                        <button className="nc-btn ghost" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={() => removeScript(s.name, fn)}>remove</button>
                      )}
                    </div>
                  ))}
                </>
              )}

              {s.source === 'project' && (
                <div style={{ marginTop: 14 }}>
                  <div className="label-tiny" style={{ marginBottom: 6 }}>+ ADD SCRIPT</div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input className="nc-input" style={{ flex: 1 }} placeholder="filename (e.g. greet.sh, hello.py)"
                           value={(scriptDraft[s.name]?.filename) || ''}
                           onChange={e => setScriptDraft(d => ({ ...d, [s.name]: { ...(d[s.name] || {}), filename: e.target.value } }))}/>
                    <button className="nc-btn primary" style={{ fontSize: 10 }} onClick={() => addScript(s.name)}>save script</button>
                  </div>
                  <textarea className="nc-textarea" rows={6} placeholder="#!/usr/bin/env bash&#10;echo &quot;hello $1&quot;"
                            value={(scriptDraft[s.name]?.content) || ''}
                            onChange={e => setScriptDraft(d => ({ ...d, [s.name]: { ...(d[s.name] || {}), content: e.target.value } }))}/>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// Best-effort frontmatter `name:` extractor — runs client-side so the user can
// see what the upload will be named before submitting.
const sniffFrontmatterName = (md) => {
  if (!md) return '';
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const line = m[1].split(/\r?\n/).find(l => /^\s*name\s*:/.test(l));
  if (!line) return '';
  let v = line.replace(/^\s*name\s*:\s*/, '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
};

const INSTALL_EXAMPLES = [
  { kind: 'plugin',      spec: 'skill-creator@claude-plugins-official',   label: '/plugin install skill-creator@claude-plugins-official' },
  { kind: 'plugin',      spec: 'superpowers@claude-plugins-official',     label: '/plugin install superpowers@claude-plugins-official' },
  { kind: 'plugin',      spec: 'frontend-design@claude-plugins-official', label: '/plugin install frontend-design@claude-plugins-official' },
  { kind: 'plugin',      spec: 'context-mode@context-mode',               label: '/plugin install context-mode@context-mode' },
  { kind: 'plugin',      spec: 'claude-mem',                              label: '/plugin install claude-mem' },
  { kind: 'marketplace', spec: 'mksglu/context-mode',                     label: '/plugin marketplace add mksglu/context-mode' },
  { kind: 'marketplace', spec: 'thedotmack/claude-mem',                   label: '/plugin marketplace add thedotmack/claude-mem' },
  { kind: 'npx',         spec: 'get-shit-done-cc --claude --global',      label: 'npx get-shit-done-cc --claude --global' },
];

const installPlaceholders = {
  plugin:      'skill-creator@claude-plugins-official',
  marketplace: 'owner/repo',
  npx:         'get-shit-done-cc --claude --global',
};

const installHints = {
  plugin:      'Runs `claude plugin install <spec>`. spec must match `name[@source]` (lowercase letters/digits/dots/dashes/underscores).',
  marketplace: 'Runs `claude plugin marketplace add <owner/repo>`. spec must match a GitHub `owner/repo`.',
  npx:         'Runs `npx <pkg> [--flags]`. Only `--flag`-style args (no values) are allowed; no shell metachars.',
};

const SkillEditor = ({ editing, setEditing, submit, cancel, busy }) => {
  if (editing.mode === 'install') {
    const runInstall = async () => {
      setEditing({ ...editing, running: true, output: `// running: ${editing.kind} ${editing.spec}\n` });
      try {
        const r = await fetch('/api/skills/install', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: editing.kind, spec: editing.spec.trim() }),
        });
        const j = await r.json().catch(() => ({}));
        const head = `// ${j.command || `${editing.kind} ${editing.spec}`} — exit ${j.exit_code ?? '—'} in ${j.duration_ms ?? '?'}ms (ok=${!!j.ok})${j.error ? ` [${j.error}]` : ''}\n`;
        const out = head
          + (j.stdout ? `\n--- stdout ---\n${j.stdout}` : '')
          + (j.stderr ? `\n--- stderr ---\n${j.stderr}` : '');
        setEditing(prev => ({ ...prev, running: false, output: out }));
        if (j && j.ok) window.NC_LIVE?.refresh?.();
      } catch (e) {
        setEditing(prev => ({ ...prev, running: false, output: `// fetch failed: ${e.message}` }));
      }
    };
    const useExample = (ex) => setEditing({ ...editing, kind: ex.kind, spec: ex.spec });
    return (
      <div className="nc-panel glow" style={{ padding: 16, marginBottom: 14 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 10 }}>INSTALL SKILL · run /plugin or npx commands · output capped at 64KB · 90s timeout</div>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10 }}>
          <div className="field">
            <label>Kind</label>
            <select className="nc-input" value={editing.kind} onChange={e => setEditing({ ...editing, kind: e.target.value })}>
              <option value="plugin">Plugin</option>
              <option value="marketplace">Marketplace</option>
              <option value="npx">Npx</option>
            </select>
          </div>
          <div className="field">
            <label>Spec</label>
            <input className="nc-input" value={editing.spec}
                   onChange={e => setEditing({ ...editing, spec: e.target.value })}
                   placeholder={installPlaceholders[editing.kind] || ''}/>
          </div>
        </div>
        <small className="muted mono" style={{ display: 'block', marginTop: 4, fontSize: 10 }}>{installHints[editing.kind]}</small>

        <div className="label-tiny" style={{ marginTop: 14, marginBottom: 6 }}>COMMON INSTALLS · click to pre-fill</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {INSTALL_EXAMPLES.map(ex => (
            <button key={ex.label} className="nc-btn ghost" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}
                    onClick={() => useExample(ex)}>{ex.label}</button>
          ))}
        </div>

        {editing.output && (
          <pre className="mono" style={{ fontSize: 11, background: 'var(--bg-2)', padding: 10, borderRadius: 3, maxHeight: 360, overflow: 'auto', marginTop: 14, whiteSpace: 'pre-wrap' }}>
            {editing.output}
          </pre>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="nc-btn ghost" onClick={cancel}>Close</button>
          <button className="nc-btn primary" onClick={runInstall} disabled={editing.running || !editing.spec.trim()}>
            {editing.running ? 'Running…' : 'Install'}
          </button>
        </div>
      </div>
    );
  }

  if (editing.mode === 'upload') {
    const onFile = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        const sniffed = sniffFrontmatterName(text);
        setEditing(prev => ({
          ...prev,
          filename: file.name,
          content:  text,
          // Only autopopulate the name override when empty — don't clobber an explicit user edit.
          name:     prev.name && prev.name.trim() ? prev.name : sniffed,
        }));
      };
      reader.readAsText(file);
    };
    return (
      <div className="nc-panel glow" style={{ padding: 16, marginBottom: 14 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 10 }}>UPLOAD SKILL.md · drop in an existing skill (frontmatter optional) · lands at .claude/skills/&lt;name&gt;/</div>
        <div className="field" style={{ marginBottom: 10 }}>
          <label>SKILL.md file</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={onFile}/>
            {editing.filename && <code className="mono muted" style={{ fontSize: 11 }}>{editing.filename}</code>}
          </div>
        </div>
        <div className="field" style={{ marginBottom: 10 }}>
          <label>Name override <span className="muted" style={{ fontSize: 10 }}>(lowercase-dash · leave blank to use frontmatter or filename)</span></label>
          <input className="nc-input" value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="my-skill"/>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>SKILL.md contents <span className="muted" style={{ fontSize: 10 }}>(editable preview)</span></label>
          <textarea className="nc-textarea" rows={14} value={editing.content || ''}
                    onChange={e => {
                      const v = e.target.value;
                      const sniffed = sniffFrontmatterName(v);
                      setEditing(prev => ({
                        ...prev,
                        content: v,
                        name: prev.name && prev.name.trim() ? prev.name : sniffed,
                      }));
                    }}
                    placeholder={'---\nname: my-skill\ndescription: ...\n---\n\n## Purpose\n...'}/>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="nc-btn ghost" onClick={cancel}>Cancel</button>
          <button className="nc-btn primary" onClick={submit} disabled={busy || !(editing.content && editing.content.trim())}>
            {busy ? 'Uploading…' : 'Upload skill'}
          </button>
        </div>
      </div>
    );
  }

  if (editing.mode === 'fromScript') {
    return (
      <div className="nc-panel glow" style={{ padding: 16, marginBottom: 14 }}>
        <div className="label-tiny neonc" style={{ marginBottom: 10 }}>SCRIPT → SKILL · paste a script, get a callable skill</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="field">
            <label>Skill name <span className="muted" style={{ fontSize: 10 }}>(lowercase-dash)</span></label>
            <input className="nc-input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="greet-user"/>
          </div>
          <div className="field">
            <label>Script filename <span className="muted" style={{ fontSize: 10 }}>(.sh / .py / .js)</span></label>
            <input className="nc-input" value={editing.filename} onChange={e => setEditing({ ...editing, filename: e.target.value })} placeholder="greet.sh"/>
          </div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Description</label>
          <input className="nc-input" value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="Greet the user by name"/>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Script content</label>
          <textarea className="nc-textarea" rows={10} value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })}
                    placeholder={'#!/usr/bin/env bash\nname="${1:-world}"\necho "hello $name"'}/>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="nc-btn ghost" onClick={cancel}>Cancel</button>
          <button className="nc-btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Create skill'}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="nc-panel glow" style={{ padding: 16, marginBottom: 14 }}>
      <div className="label-tiny neonc" style={{ marginBottom: 10 }}>{editing.mode === 'edit' ? `EDIT · ${editing.name}` : 'NEW SKILL'}</div>
      {editing.mode === 'new' && (
        <div className="field" style={{ marginBottom: 10 }}>
          <label>Name <span className="muted" style={{ fontSize: 10 }}>(lowercase-dash, used as /<code>name</code>)</span></label>
          <input className="nc-input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="my-skill"/>
        </div>
      )}
      <div className="field" style={{ marginBottom: 10 }}>
        <label>Description</label>
        <input className="nc-input" value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="What this skill does (one line)"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="field">
          <label>Triggers <span className="muted" style={{ fontSize: 10 }}>(comma-sep, informational)</span></label>
          <input className="nc-input" value={editing.triggers} onChange={e => setEditing({ ...editing, triggers: e.target.value })} placeholder="summarize, tldr"/>
        </div>
        <div className="field">
          <label>Allowed tools <span className="muted" style={{ fontSize: 10 }}>(comma-sep, informational)</span></label>
          <input className="nc-input" value={editing.tools} onChange={e => setEditing({ ...editing, tools: e.target.value })} placeholder="vault_search, run_skill_script"/>
        </div>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>Body <span className="muted" style={{ fontSize: 10 }}>(markdown, gets prepended to the agent prompt when active)</span></label>
        <textarea className="nc-textarea" rows={14} value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })}
                  placeholder={'## Purpose\nDo X when invoked.\n\n## Steps\n1. ...\n2. ...'}/>
      </div>
      <div className="field" style={{ marginTop: 10, fontSize: 11 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!editing.always_on}
            onChange={e => setEditing({ ...editing, always_on: e.target.checked })}
          />
          Always on <span className="muted" style={{ fontSize: 10 }}>(apply to every agent, regardless of agent.skills)</span>
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="nc-btn ghost" onClick={cancel}>Cancel</button>
        <button className="nc-btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : (editing.mode === 'edit' ? 'Save' : 'Create skill')}</button>
      </div>
    </div>
  );
};

window.Skills = Skills;
