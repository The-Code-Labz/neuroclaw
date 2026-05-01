/* Dream Cycle page */
const Dream = () => {
  const { DREAM } = window.NC_DATA;
  const stages = DREAM.pipeline;
  return (
    <div>
      <PageHeader title="Dream Cycle" subtitle="// nightly memory wash · insight extraction · plan generation" right={<>
        <span className="tag green"><span className="dot green pulse"/>enabled</span>
        <span className="tag blue">next · {DREAM.next}</span>
        <button className="nc-btn primary"><Icon name="play" size={12}/> Run Now</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        {[
          ['SESSIONS PROCESSED', DREAM.last.processed],
          ['MEMORIES EXTRACTED', DREAM.last.extracted],
          ['PROMOTED', DREAM.last.promoted],
          ['INSIGHTS GENERATED', DREAM.last.insights],
          ['NEXT-DAY PLAN', DREAM.last.plan ? 'READY' : '—'],
        ].map(([l, v], i) => <StatCard key={i} label={l} value={v} sub={i === 0 ? 'last cycle' : ''} tone="cyan"/>)}
      </div>

      <Section title="WASH PIPELINE">
        <div style={{ position: 'relative', padding: '20px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ position: 'absolute', left: '6%', right: '6%', top: '50%', height: 2, background: 'linear-gradient(90deg, rgba(0,183,255,0.2), var(--neon), var(--neon-2), var(--violet), rgba(139,92,246,0.4))', boxShadow: '0 0 10px rgba(0,183,255,0.4)' }}/>
          {stages.map((s, i) => (
            <div key={i} style={{ position: 'relative', textAlign: 'center', flex: 1 }}>
              <div style={{ width: 50, height: 50, borderRadius: '50%', margin: '0 auto', background: 'radial-gradient(circle, rgba(0,183,255,0.5), rgba(0,0,0,0))', border: `1.5px solid ${i === 4 ? 'var(--neon)' : 'var(--line-hard)'}`, boxShadow: i === 4 ? '0 0 18px var(--neon)' : '0 0 8px rgba(0,183,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontWeight: 700, color: '#fff', fontSize: 12, position: 'relative', background: '#020617' }}>{i+1}</div>
              <div className="mono" style={{ fontSize: 10, marginTop: 8, color: 'var(--text-soft)', letterSpacing: '0.06em' }}>{s.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Section title="LAST CYCLE LOG">
          <pre className="mono" style={{ margin: 0, fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
{`02:59:51  starting dream cycle [lookback=24h]
03:00:02  loaded 38 sessions, 1.2M tokens
03:00:18  wash → removed 712 chat noise tokens
03:01:04  extract → 12 candidate memories
03:01:51  categorize → 3 procedural · 5 episodic · 4 preference
03:02:30  store → vault wrote 11 / 12
03:02:42  insight → 2 generated, 1 promoted
03:03:01  tomorrow plan ✓ "AgentOS v2 outline"
03:03:09  cycle complete · duration 3m 18s`}
          </pre>
        </Section>
        <Section title="TOMORROW PLAN">
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.7 }}>
            <div className="neonc">// 2026-05-01 · 6 actions</div>
            <div>· 09:00  Morning brief · alfred</div>
            <div>· 10:30  Resolve T-205 retry policy · coder</div>
            <div>· 12:00  Vault cleanup pass · archivist</div>
            <div>· 14:00  Research scan: gateway updates · researcher</div>
            <div>· 17:00  Weekly insights draft · archivist</div>
            <div>· 22:00  Pre-warm dream cycle (jittered) · planner</div>
          </div>
        </Section>
      </div>
    </div>
  );
};
window.Dream = Dream;
