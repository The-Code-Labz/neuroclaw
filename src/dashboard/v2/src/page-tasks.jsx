/* Tasks - Mission Control */

const Tasks = () => {
  const { TASKS, AGENTS } = window.NC_DATA;
  const cols = [
    { id: 'todo', label: 'TODO', tone: 'muted' },
    { id: 'doing', label: 'DOING', tone: 'cyan' },
    { id: 'review', label: 'REVIEW', tone: 'amber' },
    { id: 'done', label: 'DONE', tone: 'green' },
    { id: 'failed', label: 'FAILED', tone: 'red' },
  ];

  return (
    <div>
      <PageHeader
        title="Mission Control"
        subtitle="// task orchestration · auto-delegation · background jobs"
        right={<>
          <span className="tag green">{TASKS.filter(t => t.status === 'done').length} done · 24h</span>
          <span className="tag amber">{TASKS.filter(t => t.status === 'review').length} review</span>
          <span className="tag red">{TASKS.filter(t => t.status === 'failed').length} failed</span>
          <button className="nc-btn"><Icon name="bolt" size={12}/> Auto-assign</button>
          <button className="nc-btn primary"><Icon name="plus" size={12}/> New Mission</button>
        </>}
      />

      {/* Top air-traffic strip */}
      <div className="nc-panel glow" style={{ padding: 14, marginBottom: 16, position: 'relative', overflow: 'hidden' }}>
        <div className="scan-line"/>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="label-tiny neonc">AIR TRAFFIC · LIVE EXECUTION</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>4 in flight · 2 background · capacity 12</div>
        </div>
        <div style={{ position: 'relative', height: 44, borderRadius: 2, border: '1px solid var(--line-soft)', overflow: 'hidden' }}>
          <div className="grid-bg" style={{ position: 'absolute', inset: 0, opacity: 0.4 }}/>
          {/* Lanes */}
          {[0,1,2,3].map(l => <div key={l} style={{ position: 'absolute', left: 0, right: 0, top: `${(l+1)*11}px`, height: 1, background: 'rgba(0,183,255,0.08)' }}/>)}
          {/* Tasks moving across */}
          {[
            { id: 'T-204', x: 0.62, y: 0, color: 'var(--danger)' },
            { id: 'T-205', x: 0.42, y: 1, color: 'var(--neon)' },
            { id: 'T-206', x: 0.78, y: 2, color: 'var(--amber)' },
            { id: 'T-207', x: 0.12, y: 3, color: 'var(--neon-2)' },
          ].map((t, i) => (
            <div key={i} style={{ position: 'absolute', left: `${t.x*100}%`, top: `${4 + t.y*11}px`, fontFamily: 'var(--mono)', fontSize: 10, color: t.color, letterSpacing: '0.08em', textShadow: `0 0 4px ${t.color}` }}>
              ◂─[{t.id}]─▸
            </div>
          ))}
        </div>
      </div>

      {/* Kanban */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        {cols.map(c => {
          const items = TASKS.filter(t => t.status === c.id);
          return (
            <div key={c.id} className="nc-panel" style={{ padding: 0, minHeight: 380 }}>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={`label-tiny ${c.tone === 'cyan' ? 'neonc' : c.tone === 'amber' ? 'amberc' : c.tone === 'green' ? 'greenc' : c.tone === 'red' ? 'dangerc' : 'muted'}`}>{c.label}</span>
                <span className={`tag ${c.tone === 'cyan' ? 'blue' : c.tone === 'amber' ? 'amber' : c.tone === 'green' ? 'green' : c.tone === 'red' ? 'red' : 'muted'}`} style={{ fontSize: 9 }}>{items.length}</span>
              </div>
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map(t => {
                  const agent = AGENTS.find(a => a.id === t.agent);
                  const pTone = t.priority === 'P0' ? 'red' : t.priority === 'P1' ? 'amber' : 'blue';
                  return (
                    <div key={t.id} className="nc-panel tilt" style={{ padding: 10, background: 'rgba(2,6,23,0.7)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span className="mono muted" style={{ fontSize: 10 }}>{t.id}</span>
                        <span className={`tag ${pTone}`} style={{ fontSize: 9, padding: '0 5px' }}>{t.priority}</span>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4, marginBottom: 8 }}>{t.title}</div>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ width: 18, height: 18, borderRadius: 4, background: 'rgba(0,183,255,0.15)', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700 }}>{agent?.name[0]}</span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-soft)' }}>@{agent?.name}</span>
                        {t.auto && <span className="tag cyan" style={{ fontSize: 8, padding: '0 4px' }}>AUTO</span>}
                        {t.bg && <span className="tag violet" style={{ fontSize: 8, padding: '0 4px' }}>BG</span>}
                      </div>
                      {/* Step pipeline */}
                      <div style={{ display: 'flex', gap: 2, marginBottom: 6 }}>
                        {t.steps.map((_, i) => (
                          <div key={i} style={{ flex: 1, height: 3, background: i < t.stepIdx ? 'var(--neon)' : i === t.stepIdx ? 'var(--amber)' : 'rgba(0,183,255,0.1)', borderRadius: 1, boxShadow: i === t.stepIdx ? '0 0 6px var(--amber)' : 'none' }}/>
                        ))}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="mono muted" style={{ fontSize: 9 }}>{t.steps[Math.min(t.stepIdx, t.steps.length-1)]}</span>
                        <span className={`mono ${t.status === 'failed' ? 'dangerc' : t.status === 'done' ? 'greenc' : 'neon2'}`} style={{ fontSize: 9 }}>{t.eta}</span>
                      </div>
                      {t.status === 'failed' && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                          <button className="nc-btn ghost" style={{ flex: 1, fontSize: 9, padding: 4 }}>retry</button>
                          <button className="nc-btn ghost" style={{ flex: 1, fontSize: 9, padding: 4 }}>cancel</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <div className="mono muted" style={{ fontSize: 10, textAlign: 'center', padding: 18, border: '1px dashed rgba(0,183,255,0.1)', borderRadius: 2 }}>// empty</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

window.Tasks = Tasks;
