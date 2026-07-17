/* Docs — wiki-style sidebar + markdown article pane */

const Docs = () => {
  const [tree, setTree] = React.useState(null);     // null = loading; [] = empty
  const [active, setActive] = React.useState(null); // { section, slug } or null
  const [article, setArticle] = React.useState(null);
  const [articleErr, setArticleErr] = React.useState(null);
  const [renderErr, setRenderErr] = React.useState(false);
  const [openSections, setOpenSections] = React.useState({}); // sectionSlug -> bool, default open
  const [mobilePane, setMobilePane] = React.useState('list'); // 'list' | 'article' — narrow-viewport toggle

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
    setMobilePane('article');
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
    <div>
      <PageHeader title="Docs" subtitle="// wiki · reference articles agents & you maintain"/>

      <div className="nt-mobile-tabs">
        <button className={`nc-btn ghost ${mobilePane === 'list' ? 'active' : ''}`} onClick={() => setMobilePane('list')}><Icon name="sessions" size={12}/> Sections</button>
        <button className={`nc-btn ghost ${mobilePane === 'article' ? 'active' : ''}`} onClick={() => setMobilePane('article')} disabled={!active}><Icon name="docs" size={12}/> Article</button>
      </div>

      <div className="nt-split">
        <aside className={`mem-rail ${mobilePane === 'article' ? 'nt-mobile-hide' : ''}`} style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 180px)' }}>
          {tree === null && <div className="muted mono" style={{ padding: '8px 10px', fontSize: 11 }}>Loading…</div>}
          {tree && tree.length === 0 && <div className="muted mono" style={{ padding: '8px 10px', fontSize: 11 }}>No articles yet. Drop a markdown file in <code>docs/wiki/&lt;section&gt;/&lt;slug&gt;.md</code>.</div>}
          {tree && tree.map(section => (
            <div key={section.slug} style={{ marginBottom: 6 }}>
              <div
                className="label-tiny"
                style={{ padding: '8px 10px 4px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', userSelect: 'none' }}
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
                       className="mono mem-type-row"
                       style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-soft)', textDecoration: 'none' }}>
                      <span>{a.title}</span>
                      <span className="muted" style={{ fontSize: 9 }}>↗</span>
                    </a>
                  );
                }
                return (
                  <div key={a.slug}
                       className={`mono mem-type-row ${isActive ? 'is-active' : ''}`}
                       onClick={() => setActive({ section: section.slug, slug: a.slug })}
                       style={{ fontSize: 12, color: isActive ? 'var(--accent)' : 'var(--text-soft)' }}
                  >{a.title}</div>
                );
              })}
            </div>
          ))}
        </aside>

        <section className={mobilePane === 'list' ? 'nt-mobile-hide' : ''} style={{ minWidth: 0, overflowY: 'auto' }}>
          {!active && tree && tree.length > 0 && (
            <div className="muted mono" style={{ fontSize: 12 }}>Pick an article from the sidebar to begin.</div>
          )}
          {articleErr && (
            <div className="mem-panel" style={{ borderLeft: '2px solid var(--danger)' }}>
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
    </div>
  );
};

window.Docs = Docs;
