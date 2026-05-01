/* MCP Tools */
const MCP = () => {
  const { MCP_SERVERS } = window.NC_DATA;
  return (
    <div>
      <PageHeader title="MCP Tools" subtitle="// model context protocol · tool registry · servers" right={<>
        <button className="nc-btn"><Icon name="refresh" size={12}/> Reconnect All</button>
        <button className="nc-btn primary"><Icon name="plus" size={12}/> Add Server</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        {MCP_SERVERS.map(s => (
          <div key={s.id} className="nc-panel glow tilt" style={{ padding: 14, position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`dot ${s.status === 'online' ? 'green' : s.status === 'degraded' ? 'amber' : 'red'} pulse`}/>
                <span style={{ fontFamily: 'var(--display)', fontSize: 16, fontWeight: 600 }}>{s.name}</span>
              </div>
              <span className={`tag ${s.status === 'online' ? 'green' : 'amber'}`} style={{ fontSize: 9 }}>{s.status}</span>
            </div>
            <div className="mono muted" style={{ fontSize: 10, marginBottom: 10 }}>{s.url}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
              <div><div className="label-tiny">OK</div><div className="mono greenc" style={{ fontSize: 14 }}>{s.ok}</div></div>
              <div><div className="label-tiny">FAIL</div><div className="mono dangerc" style={{ fontSize: 14 }}>{s.fail}</div></div>
              <div><div className="label-tiny">LATENCY</div><div className="mono" style={{ fontSize: 14, color: s.latency > 1500 ? 'var(--amber)' : 'var(--neon-2)' }}>{s.latency}ms</div></div>
            </div>
            <div className="label-tiny" style={{ marginBottom: 6 }}>TOOLS · {s.tools.length}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
              {s.tools.map(t => <span key={t} className="tag blue" style={{ fontSize: 9 }}>{t}</span>)}
            </div>
            <div className="mono muted" style={{ fontSize: 10, marginBottom: 8 }}>last call · {s.lastCall}</div>
            <div style={{ display: 'flex', gap: 6, paddingTop: 8, borderTop: '1px dashed rgba(0,183,255,0.1)' }}>
              <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10 }}>test</button>
              <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10 }}>logs</button>
              <button className="nc-btn ghost" style={{ flex: 1, fontSize: 10 }}>disable</button>
            </div>
          </div>
        ))}
      </div>

      <Section title="TOOL CATALOG" padded={false}>
        <div className="mono" style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 90px 90px 100px', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.14em' }}>
          <span>TOOL</span><span>SERVER</span><span>SCHEMA</span><span>OK</span><span>FAIL</span><span>ACTIONS</span>
        </div>
        {[
          ['vault_search','neurovault','{q,limit,folder}', 842, 1],
          ['vault_read_note','neurovault','{path}', 311, 0],
          ['vault_create_note','neurovault','{path,body,tags}', 87, 1],
          ['vault_update_note','neurovault','{path,body}', 44, 1],
          ['researchlm_search','researchlm','{q,topk}', 188, 4],
          ['researchlm_deep_research','researchlm','{q,depth}', 224, 5],
          ['insightslm_search_sources','insightslm','{q,collection}', 102, 11],
          ['insightslm_ask_collection','insightslm','{q,collection_id}', 96, 11],
        ].map((r, i) => (
          <div key={i} className="mono" style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 90px 90px 100px', gap: 10, padding: '10px 16px', borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 11, alignItems: 'center' }}>
            <span className="neonc">{r[0]}</span>
            <span style={{ color: 'var(--text-soft)' }}>{r[1]}</span>
            <span className="muted">{r[2]}</span>
            <span className="greenc">{r[3]}</span>
            <span className="dangerc">{r[4]}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px' }}>test</button>
              <button className="nc-btn ghost" style={{ fontSize: 9, padding: '3px 6px' }}>i/o</button>
            </span>
          </div>
        ))}
      </Section>
    </div>
  );
};
window.MCP = MCP;
