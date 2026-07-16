/* Photopea editor — Studio sub-tab (v3 §1).
 * Embeds the Photopea web editor (photopea.com) in an iframe and drives it via
 * its postMessage script API. Receives generated images from the Generate tab
 * through the shared `window.__ncStudioEditorImage` handoff + the live
 * `nc-studio-send-to-editor` event, and also supports URL / local-file loads.
 *
 * CORS note: Photopea fetches image URLs from its OWN origin, which fails on
 * cross-origin hosts without permissive CORS. To sidestep that we fetch the
 * image in the parent first, convert to a data: URL, and hand Photopea the
 * bytes via `app.open(<dataURL>)`. If the parent fetch is itself CORS-blocked
 * we fall back to letting Photopea fetch the raw URL directly. */

const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
// Dark theme, English, no template picker on boot.
const PHOTOPEA_INIT = encodeURIComponent(JSON.stringify({
  environment: { theme: 1, lang: 'en', vmode: 0, intro: false },
}));

const Photopea = () => {
  const iframeRef  = React.useRef(null);
  const readyRef   = React.useRef(false);
  const [ready,   setReady]   = React.useState(false);
  const [status,  setStatus]  = React.useState('booting editor…');
  const [urlDraft, setUrlDraft] = React.useState('');

  // Send a raw script to the Photopea document.
  const runScript = React.useCallback((script) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(script, '*');
  }, []);

  // Open an image into Photopea as a new document. Tries parent-fetch → dataURL
  // (CORS-proof) and falls back to a direct Photopea fetch of the raw URL.
  const openImage = React.useCallback(async (url, label) => {
    if (!url) return;
    setStatus(`loading ${label || 'image'}…`);
    // Already a data: URL — hand straight over.
    if (url.startsWith('data:')) {
      runScript(`app.open("${url}", null, false);`);
      setStatus(`opened ${label || 'image'}`);
      return;
    }
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      runScript(`app.open("${dataUrl}", null, false);`);
      setStatus(`opened ${label || 'image'}`);
    } catch (err) {
      // Parent fetch blocked — let Photopea try the raw URL itself.
      runScript(`app.open("${url}", null, false);`);
      setStatus(`opened via direct fetch (parent CORS-blocked: ${err.message})`);
    }
  }, [runScript]);

  // Photopea posts a message once the editor is fully loaded, and after each
  // script it runs. First message we hear = ready.
  React.useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== PHOTOPEA_ORIGIN) return;
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
        setStatus('editor ready');
        // Drain any image the Generate tab handed off before we mounted.
        const pending = window.__ncStudioEditorImage;
        if (pending?.url) {
          openImage(pending.url, pending.provider || 'generated image');
          window.__ncStudioEditorImage = null;
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [openImage]);

  // Live handoff while Photopea is the open tab.
  React.useEffect(() => {
    const onSend = (e) => {
      const url = e?.detail?.imageUrl;
      if (url) openImage(url, e.detail.provider || 'generated image');
    };
    window.addEventListener('nc-studio-send-to-editor', onSend);
    return () => window.removeEventListener('nc-studio-send-to-editor', onSend);
  }, [openImage]);

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => { runScript(`app.open("${fr.result}", null, false);`); setStatus(`opened ${file.name}`); };
    fr.readAsDataURL(file);
    e.target.value = '';
  };

  const openUrl = () => {
    const u = urlDraft.trim();
    if (!u) return;
    openImage(u, 'url');
    setUrlDraft('');
  };

  const btn = {
    padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
    color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', borderRadius: 3,
    background: 'color-mix(in srgb, var(--accent) 8%, transparent)', whiteSpace: 'nowrap',
  };

  return (
    <>
      <PageHeader title="Photopea" subtitle="Full raster / PSD editor · edit generated images in-studio" />

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: ready ? 'var(--accent-2)' : 'var(--amber)', display: 'inline-block' }} />
        <span className="mono muted" style={{ fontSize: 10, minWidth: 120 }}>{status}</span>

        <input
          value={urlDraft}
          onChange={e => setUrlDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') openUrl(); }}
          placeholder="paste image URL…"
          style={{ flex: 1, minWidth: 160, background: 'rgba(0,8,20,0.6)', border: '1px solid var(--line-soft)',
            borderRadius: 3, padding: '5px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none' }}
        />
        <div style={btn} onClick={openUrl}>open url</div>

        <label style={{ ...btn, color: 'var(--accent-2)', borderColor: 'rgba(0,255,200,0.3)', background: 'rgba(0,255,200,0.06)' }}>
          upload file
          <input type="file" accept="image/*,.psd,.pdf,.svg" onChange={onFile} style={{ display: 'none' }} />
        </label>

        <div style={{ ...btn, color: 'var(--muted)', borderColor: 'var(--line-soft)', background: 'transparent' }}
          onClick={() => { readyRef.current = false; setReady(false); setStatus('reloading…');
            if (iframeRef.current) iframeRef.current.src = `${PHOTOPEA_ORIGIN}/#${PHOTOPEA_INIT}`; }}>
          reload
        </div>
      </div>

      {/* Editor */}
      <div style={{ height: 'calc(100vh - 210px)', border: '1px solid var(--line)', borderRadius: 4, overflow: 'hidden', background: '#181818' }}>
        <iframe
          ref={iframeRef}
          src={`${PHOTOPEA_ORIGIN}/#${PHOTOPEA_INIT}`}
          title="Photopea"
          style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          allow="clipboard-read; clipboard-write"
        />
      </div>

      <div className="mono muted" style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>
        // Export from Photopea: <span style={{ color: 'var(--text-soft)' }}>File → Export as</span> (PNG / JPG / PSD / PDF).
        Photopea runs client-side; nothing here touches NeuroClaw storage until you download.
      </div>
    </>
  );
};

window.Photopea = Photopea;
