/* Agents page */

const AgentCard = ({ a, onClick }) => {
  const accent = a.temp ? 'var(--violet)' : a.color === 'neon2' ? 'var(--neon-2)' : 'var(--neon)';
  return (
    <div className="nc-panel glow tilt" onClick={onClick} style={{ padding: 14, cursor: 'pointer', position: 'relative', overflow: 'hidden', borderColor: a.temp ? 'rgba(139,92,246,0.35)' : 'var(--line)' }}>
      {a.temp && <div className="stripe-bg" style={{ position: 'absolute', inset: 0, opacity: 0.2 }}/>}
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ width: 46, height: 46, flex: 'none', borderRadius: 10, background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.4), transparent 30%), radial-gradient(circle, ${accent}, rgba(0,0,0,0))`, border: `1px solid ${accent}`, boxShadow: `0 0 14px ${accent}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: '#fff', textShadow: `0 0 6px ${accent}` }}>
            {a.name[0]}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--display)', fontSize: 16, fontWeight: 600 }}>{a.name}</span>
              {a.temp && <span className="tag violet" style={{ fontSize: 9 }}>TEMP · {a.expires}</span>}
            </div>
            <div className="mono muted" style={{ fontSize: 11 }}>{a.role}</div>
          </div>
          <span className={`dot ${a.status === 'live' ? 'green' : a.status === 'busy' ? 'amber' : 'muted'} ${a.status !== 'idle' ? 'pulse' : ''}`}/>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.55, minHeight: 32 }}>{a.desc}</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, margin: '12px 0 10px' }}>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">PROVIDER</span><br/>
            <span className="neonc">{a.provider}</span>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">MODEL</span><br/>
            <span style={{ color: 'var(--text)' }}>{a.model}</span>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">SCOPE</span><br/>
            <span className="neon2">{a.scope}</span>
          </div>
          <div className="mono" style={{ fontSize: 10 }}>
            <span className="muted">DEPTH · TASKS</span><br/>
            <span style={{ color: 'var(--text)' }}>{a.spawnDepth} · {a.tasks}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {a.caps.map(c => <span key={c} className="tag" style={{ fontSize: 9, padding: '1px 6px' }}>{c}</span>)}
          {a.exec && <span className="tag amber" style={{ fontSize: 9, padding: '1px 6px' }}>exec</span>}
        </div>

        <div style={{ display: 'flex', gap: 6, paddingTop: 10, borderTop: '1px dashed rgba(0,183,255,0.1)' }}>
          <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, padding: '5px 6px' }}>edit</button>
          <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, padding: '5px 6px' }}>memory</button>
          <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10, padding: '5px 6px' }}>logs</button>
        </div>
      </div>
    </div>
  );
};

const Agents = () => {
  const { AGENTS } = window.NC_DATA;
  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="// roster · loadouts · spawn graph"
        right={<>
          <button className="nc-btn"><Icon name="bolt" size={12}/> Spawn Temp</button>
          <button className="nc-btn primary"><Icon name="plus" size={12}/> New Agent</button>
        </>}
      />

      {/* Filter row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="tag blue">ALL · {AGENTS.length}</span>
        <span className="tag">PERMANENT · {AGENTS.filter(a => !a.temp).length}</span>
        <span className="tag violet">TEMP · {AGENTS.filter(a => a.temp).length}</span>
        <span className="tag green">LIVE · {AGENTS.filter(a => a.status === 'live').length}</span>
        <span className="tag amber">BUSY · {AGENTS.filter(a => a.status === 'busy').length}</span>
        <span style={{ flex: 1 }}/>
        <input className="nc-input" placeholder="filter agents..." style={{ maxWidth: 240 }}/>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12, marginBottom: 16 }}>
        {AGENTS.map(a => <AgentCard key={a.id} a={a}/>)}
      </div>

      {/* Spawn graph */}
      <Section title="SPAWN GRAPH · LIVE">
        <div className="grid-bg" style={{ position: 'relative', height: 220, border: '1px solid var(--line-soft)', borderRadius: 2 }}>
          <svg viewBox="0 0 800 220" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <defs>
              <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="#00b7ff"/>
              </marker>
            </defs>
            {/* Alfred center */}
            <line x1="400" y1="110" x2="180" y2="60" stroke="rgba(0,183,255,0.6)" strokeWidth="1.4" markerEnd="url(#arr)"/>
            <line x1="400" y1="110" x2="180" y2="170" stroke="rgba(0,183,255,0.6)" strokeWidth="1.4" markerEnd="url(#arr)"/>
            <line x1="400" y1="110" x2="620" y2="60" stroke="rgba(0,183,255,0.6)" strokeWidth="1.4" markerEnd="url(#arr)"/>
            <line x1="400" y1="110" x2="620" y2="170" stroke="rgba(0,183,255,0.6)" strokeWidth="1.4" markerEnd="url(#arr)"/>
            <line x1="180" y1="170" x2="80" y2="200" stroke="rgba(139,92,246,0.7)" strokeDasharray="4 3" strokeWidth="1.4" markerEnd="url(#arr)"/>
            <line x1="400" y1="110" x2="700" y2="200" stroke="rgba(139,92,246,0.7)" strokeDasharray="4 3" strokeWidth="1.4" markerEnd="url(#arr)"/>
          </svg>
          {[
            { x: 400, y: 110, name: 'Alfred', color: 'var(--neon)' },
            { x: 180, y: 60, name: 'Researcher', color: 'var(--neon-2)' },
            { x: 180, y: 170, name: 'Coder', color: 'var(--neon)' },
            { x: 620, y: 60, name: 'Planner', color: 'var(--neon-2)' },
            { x: 620, y: 170, name: 'Archivist', color: 'var(--violet)' },
            { x: 80, y: 200, name: 'Debugger-42', color: 'var(--violet)', temp: true },
            { x: 700, y: 200, name: 'Scribe-08', color: 'var(--violet)', temp: true },
          ].map((n, i) => (
            <div key={i} style={{ position: 'absolute', left: `${(n.x/800)*100}%`, top: `${(n.y/220)*100}%`, transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
              <div style={{ width: 38, height: 38, borderRadius: '50%', background: `radial-gradient(circle, ${n.color}, rgba(0,0,0,0))`, border: `1px solid ${n.color}`, boxShadow: `0 0 12px ${n.color}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontWeight: 700, color: '#fff', margin: '0 auto', fontSize: 13 }}>{n.name[0]}</div>
              <div className="mono" style={{ fontSize: 9, color: n.temp ? 'var(--violet)' : 'var(--text-soft)', marginTop: 4, letterSpacing: '0.06em' }}>{n.name}</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
};

window.Agents = Agents;
