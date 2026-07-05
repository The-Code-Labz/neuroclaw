/* ConnectScreen — shown on first standalone PWA launch when no server is stored in localStorage */

const ConnectScreen = ({ onConnected }) => {
  const [url,      setUrl]      = React.useState('');
  const [token,    setToken]    = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const [error,    setError]    = React.useState(null);

  const connect = async () => {
    setError(null);
    setChecking(true);
    try {
      const base = url.replace(/\/$/, '');
      const r = await fetch(`${base}/api/status?token=${encodeURIComponent(token)}`);
      if (!r.ok) { setError('Invalid token or server returned an error.'); setChecking(false); return; }
      localStorage.setItem('nclaw_server', JSON.stringify({ url: base, token }));
      onConnected({ url: base, token });
    } catch {
      setError('Could not reach server. Check the URL and try again.');
    } finally {
      setChecking(false);
    }
  };

  const skipAndStart = () => {
    if (!url || !token) { setError('Enter server URL and token first.'); return; }
    const base = url.replace(/\/$/, '');
    localStorage.setItem('nclaw_server', JSON.stringify({ url: base, token }));
    onConnected({ url: base, token, startNew: true });
  };

  const onKey = (e) => { if (e.key === 'Enter') connect(); };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#000814',
    }}>
      <div className="nc-panel glow" style={{ width: 420, fontFamily: 'var(--mono)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">REMOTE CONTROL · CONNECT TO SERVER</div>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="label" style={{ marginBottom: 5 }}>SERVER URL</div>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={onKey}
              placeholder="https://my.server.com"
              style={{
                width: '100%', boxSizing: 'border-box', background: '#050508',
                border: '1px solid var(--line)', borderRadius: 4, padding: '7px 10px',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, outline: 0,
              }}
            />
          </div>
          <div>
            <div className="label" style={{ marginBottom: 5 }}>DASHBOARD TOKEN</div>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              onKeyDown={onKey}
              placeholder="your-dashboard-token"
              style={{
                width: '100%', boxSizing: 'border-box', background: '#050508',
                border: '1px solid var(--line)', borderRadius: 4, padding: '7px 10px',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, outline: 0,
              }}
            />
          </div>
          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 11 }}>{error}</div>
          )}
          <button
            onClick={connect}
            disabled={!url || !token || checking}
            style={{
              padding: '9px 0', background: 'var(--accent)', color: '#000',
              fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
              border: 0, borderRadius: 4, cursor: (!url || !token || checking) ? 'not-allowed' : 'pointer',
              opacity: (!url || !token || checking) ? 0.6 : 1,
            }}>
            {checking ? 'connecting...' : 'Connect & Continue'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--line-soft)' }} />
            <span className="muted" style={{ fontSize: 10 }}>or</span>
            <div style={{ flex: 1, height: 1, background: 'var(--line-soft)' }} />
          </div>
          <button
            onClick={skipAndStart}
            disabled={!url || !token}
            style={{
              padding: '7px 0', background: 'transparent', color: 'var(--muted)',
              fontFamily: 'var(--mono)', fontSize: 11,
              border: '1px solid var(--line-soft)', borderRadius: 4,
              cursor: (!url || !token) ? 'not-allowed' : 'pointer',
              opacity: (!url || !token) ? 0.5 : 1,
            }}>
            Skip validation · Start New Session
          </button>
        </div>
      </div>
    </div>
  );
};
