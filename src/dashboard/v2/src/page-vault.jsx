/* NeuroVault page */
const Vault = () => {
  const { VAULT_TREE } = window.NC_DATA;
  const firstLeaf = (() => {
    const findLeaf = (items) => {
      for (const it of items || []) {
        if (it.path) return it.path;
        if (it.children) { const r = findLeaf(it.children); if (r) return r; }
      }
      return null;
    };
    return findLeaf(VAULT_TREE) || '';
  })();
  const [active, setActive] = React.useState(firstLeaf);
  const [noteBody, setNoteBody] = React.useState('// click a file to load its contents from NeuroVault MCP');

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setNoteBody('// loading…');
    window.NC_API.get('/api/vault/file?path=' + encodeURIComponent(active))
      .then(r => { if (!cancelled) setNoteBody(r?.content ?? '// (empty)'); })
      .catch(err => { if (!cancelled) setNoteBody('// error: ' + err.message); });
    return () => { cancelled = true; };
  }, [active]);

  const Tree = ({ items, depth = 0 }) => (
    <div>
      {items.map((it, i) => (
        <div key={i}>
          <div onClick={() => !it.children && setActive(it.path || it.name)} style={{ padding: '4px 6px', paddingLeft: 8 + depth*14, fontFamily: 'var(--mono)', fontSize: 11, cursor: it.children ? 'default' : 'pointer', color: active === (it.path || it.name) ? '#fff' : 'var(--text-soft)', background: active === (it.path || it.name) ? 'rgba(0,183,255,0.12)' : 'transparent', borderLeft: active === (it.path || it.name) ? '2px solid var(--neon)' : '2px solid transparent', display: 'flex', alignItems: 'center', gap: 6 }}>
            {it.children ? <span className="neonc">▾</span> : <span className="muted">·</span>}
            <span style={{ color: it.children ? 'var(--neon-2)' : undefined }}>{it.name}</span>
          </div>
          {it.children && <Tree items={it.children} depth={depth+1}/>}
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader title="NeuroVault" subtitle="// markdown vault · MCP-bridged · obsidian-compatible" right={<>
        <span className="tag green"><span className="dot green pulse"/>connected</span>
        <span className="tag muted">vault: <span className="neonc">default</span></span>
        <button className="nc-btn"><Icon name="refresh" size={12}/> Sync</button>
        <button className="nc-btn primary"><Icon name="plus" size={12}/> New Note</button>
      </>}/>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: 12 }}>
        {/* Tree */}
        <div className="nc-panel glow" style={{ padding: 0, height: 580, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line-soft)' }}>
            <input className="nc-input" placeholder="vault search..." style={{ fontSize: 11 }}/>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
            <Tree items={VAULT_TREE}/>
          </div>
        </div>

        {/* Preview */}
        <div className="nc-panel glow" style={{ padding: 0, display: 'flex', flexDirection: 'column', height: 580, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--neon-2)' }}>{active}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="nc-btn ghost" style={{ fontSize: 10 }}>edit</button>
              <button className="nc-btn ghost" style={{ fontSize: 10 }}>open</button>
            </div>
          </div>
          <pre className="mono" style={{ flex: 1, overflow: 'auto', padding: 18, margin: 0, fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.7, background: 'transparent' }}>{noteBody}</pre>
        </div>

        {/* Side */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="nc-panel glow" style={{ padding: 14 }}>
            <div className="label-tiny neonc" style={{ marginBottom: 8 }}>MCP CONNECTION</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.7 }}>
              <div><span className="muted">server:</span> <span className="neonc">neurovault</span></div>
              <div><span className="muted">url:</span> wss://****.local</div>
              <div><span className="muted">vault:</span> default</div>
              <div><span className="muted">uuid:</span> 4f6···c92</div>
              <div><span className="muted">tools:</span> 4 / 4</div>
              <div><span className="muted">latency:</span> <span className="greenc">84ms</span></div>
            </div>
          </div>
          <div className="nc-panel glow" style={{ padding: 14 }}>
            <div className="label-tiny neonc" style={{ marginBottom: 8 }}>RECENT WRITES</div>
            {['insights/mcp-latency.md','agents/alfred/style.md','procedures/mcp-retry.md','logs/2026-04-30.md'].map((p, i) => (
              <div key={i} className="mono" style={{ fontSize: 11, padding: '5px 0', borderBottom: '1px dashed rgba(0,183,255,0.06)', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-soft)' }}>{p}</span>
                <span className="muted" style={{ fontSize: 9 }}>{i*4+2}m</span>
              </div>
            ))}
          </div>
          <div className="nc-panel glow" style={{ padding: 14 }}>
            <div className="label-tiny neonc" style={{ marginBottom: 8 }}>FAILED SYNCS</div>
            <div className="mono muted" style={{ fontSize: 11 }}>// 0 in queue</div>
          </div>
        </div>
      </div>
    </div>
  );
};
window.Vault = Vault;
