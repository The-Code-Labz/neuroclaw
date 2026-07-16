/* Docs — wiki-style sidebar + markdown article pane */

const Docs = () => {
  const [tree, setTree] = React.useState(null);     // null = loading; [] = empty
  const [active, setActive] = React.useState(null); // { section, slug } or null
  const [article, setArticle] = React.useState(null);
  const [articleErr, setArticleErr] = React.useState(null);
  const [renderErr, setRenderErr] = React.useState(false);
  const [openSections, setOpenSections] = React.useState({}); // sectionSlug -> bool, default open

  // Initial deep-link: ?article=section/slug from the URL
  React.useEffect(() => {
    const m = (location.search.match(/[?&]article=([^&]+)/) || [])[1];
    if (m) {
      const decoded = decodeURIComponent(m);
      const slash = decoded.indexOf('/');
      if (slash > 0) {
        setActive({ section: decoded.slice(0, slash), slug: decoded.slice(slash + 1) });
      }
    }
  }, []);

  // Load the tree once
  React.useEffect(() => {
    let alive = true;
    window.NC_API.get('/api/docs/tree').then(d => {
      if (!alive) return;
      const sections = d?.sections || [];
      setTree(sections);
      const open = {};
      for (const s of sections) open[s.slug] = true;
      setOpenSections(open);
      // Auto-select first non-external article if none picked yet
      if (!active) {
        for (const s of sections) {
          for (const a of s.articles) {
            if (!a.external_url) { setActive({ section: s.slug, slug: a.slug }); return; }
          }
        }
      }
    }).catch(() => alive && setTree([]));
    return () => { alive = false; };
  }, []);

  // Load the active article whenever it changes
  React.useEffect(() => {
    if (!active) { setArticle(null); return; }
    setArticleErr(null);
    setRenderErr(false);
    window.NC_API.get(`/api/docs/article/${active.section}/${active.slug}`)
      .then(d => setArticle(d?.article || null))
      .catch(e => {
        setArticle(null);
        setArticleErr(String(e?.message || e));
      });
    const params = new URLSearchParams(location.search);
    params.set('article', `${active.section}/${active.slug}`);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }, [active?.section, active?.slug]);

  const html = React.useMemo(() => {
    if (!article || !window.marked) return '';
    try {
      const m = window.marked;
      const fn = typeof m.parse === 'function' ? m.parse.bind(m) : (typeof m === 'function' ? m : null);
      if (!fn) return article.markdown;
      return fn(article.markdown, { mangle: false, headerIds: true });
    } catch {
      setRenderErr(true);
      return '';
    }
  }, [article]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <aside className="nc-panel" style={{ width: 280, minWidth: 280, overflowY: 'auto', borderRight: '1px solid var(--line-soft)', padding: '12px 0' }}>
        {tree === null && <div className="muted mono" style={{ padding: '8px 16px', fontSize: 11 }}>Loading…</div>}
        {tree && tree.length === 0 && <div className="muted mono" style={{ padding: '8px 16px', fontSize: 11 }}>No articles yet. Drop a markdown file in <code>docs/wiki/&lt;section&gt;/&lt;slug&gt;.md</code>.</div>}
        {tree && tree.map(section => (
          <div key={section.slug} style={{ marginBottom: 8 }}>
            <div
              className="label-tiny"
              style={{ padding: '8px 16px 4px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', userSelect: 'none' }}
              onClick={() => setOpenSections(s => ({ ...s, [section.slug]: !s[section.slug] }))}
            >
              <span>{section.title}</span>
              <span className="muted" style={{ fontSize: 9 }}>{openSections[section.slug] ? '▾' : '▸'}</span>
            </div>
            {openSections[section.slug] && section.articles.map(a => {
              const isActive = active && active.section === section.slug && active.slug === a.slug;
              if (a.external_url) {
                return (
                  <a key={a.slug} href={a.external_url} target="_blank" rel="noopener noreferrer"
                     className="mono"
                     style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px', fontSize: 12, color: 'var(--text-soft)', textDecoration: 'none' }}>
                    <span>{a.title}</span>
                    <span className="muted" style={{ fontSize: 9 }}>↗</span>
                  </a>
                );
              }
              return (
                <div key={a.slug}
                     className="mono"
                     onClick={() => setActive({ section: section.slug, slug: a.slug })}
                     style={{
                       padding: '6px 16px', fontSize: 12, cursor: 'pointer',
                       background: isActive ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                       color: isActive ? 'var(--accent)' : 'var(--text-soft)',
                       borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                     }}
                >{a.title}</div>
              );
            })}
          </div>
        ))}
      </aside>

      <section style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '20px 32px' }}>
        {!active && tree && tree.length > 0 && (
          <div className="muted mono" style={{ fontSize: 12 }}>Pick an article from the sidebar to begin.</div>
        )}
        {articleErr && (
          <div className="nc-panel" style={{ padding: 16, borderColor: 'var(--danger)' }}>
            <div className="mono" style={{ color: 'var(--danger)' }}>Article not found</div>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{articleErr}</div>
          </div>
        )}
        {article && (
          <>
            <div className="label-tiny muted" style={{ marginBottom: 8 }}>{tree?.find(s => s.slug === article.section)?.title || article.section}</div>
            {renderErr && (
              <div className="muted mono" style={{ fontSize: 11, marginBottom: 12 }}>Couldn't render this article. Showing raw source.</div>
            )}
            {renderErr ? (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 12 }}>{article.markdown}</pre>
            ) : (
              <div className="nc-prose" dangerouslySetInnerHTML={{ __html: html }}/>
            )}
          </>
        )}
      </section>
    </div>
  );
};

window.Docs = Docs;
