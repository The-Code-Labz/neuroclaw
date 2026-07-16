/* Compression Studio — lightweight per-engine token-savings telemetry */

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + ' MB';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + ' KB';
  return v + ' B';
};

const Compression = () => {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.NC_API.get('/api/compression/telemetry');
      setData(r || null);
    } catch (e) {
      console.warn('[Compression] telemetry failed', e);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const engines = ['lite', 'headroom', 'rtk'];
  const rows = engines.map((key) => {
    const s = data?.engines?.[key] || { calls: 0, bytesIn: 0, bytesOut: 0 };
    const saved = Math.max(0, s.bytesIn - s.bytesOut);
    const ratio = s.bytesIn > 0 ? ((saved / s.bytesIn) * 100).toFixed(1) : '0.0';
    return { key, label: key.toUpperCase(), ...s, saved, ratio };
  });

  return (
    <div>
      <PageHeader
        title="Compression Studio"
        subtitle="// tool-output token savings · roll-up counters · no per-call DB rows"
        right={
          <button className="nc-btn" onClick={load} disabled={loading}>
            <Icon name="refresh" size={12}/> {loading ? 'loading…' : 'Refresh'}
          </button>
        }
      />

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        {rows.map((r) => (
          <StatCard
            key={r.key}
            label={r.label}
            value={fmtBytes(r.saved)}
            sub={`${r.calls.toLocaleString()} calls · ${r.ratio}% saved · ${fmtBytes(r.bytesIn)} in`}
            tone={r.key === 'rtk' ? 'violet' : 'cyan'}
            icon="analytics"
          />
        ))}
      </div>

      <Section title="Per-engine counters">
        {loading && !data && <div className="mono muted" style={{ padding: 12 }}>// loading telemetry…</div>}
        {data && (
          <div className="table-responsive">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  <th className="mono" style={{ textAlign: 'left', padding: '8px 10px' }}>ENGINE</th>
                  <th className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>CALLS</th>
                  <th className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>BYTES IN</th>
                  <th className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>BYTES OUT</th>
                  <th className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>SAVED</th>
                  <th className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>RATIO</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={{ borderBottom: '1px dashed var(--line-soft)' }}>
                    <td style={{ padding: '8px 10px' }}>
                      <span className="tag blue" style={{ fontSize: 9 }}>{r.label}</span>
                    </td>
                    <td className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>{r.calls.toLocaleString()}</td>
                    <td className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>{fmtBytes(r.bytesIn)}</td>
                    <td className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>{fmtBytes(r.bytesOut)}</td>
                    <td className="mono" style={{ textAlign: 'right', padding: '8px 10px', color: 'var(--accent-2)' }}>{fmtBytes(r.saved)}</td>
                    <td className="mono" style={{ textAlign: 'right', padding: '8px 10px' }}>{r.ratio}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div className="mono muted" style={{ fontSize: 10, marginTop: 10 }}>
            // exempt calls: {data.exemptCalls?.toLocaleString() || 0} · global flags: lite={data.global?.lite ? 'on' : 'off'} · headroom={data.global?.headroom ? 'on' : 'off'} · rtk={data.global?.rtk ? 'on' : 'off'}
          </div>
        )}
      </Section>
    </div>
  );
};

window.Compression = Compression;
