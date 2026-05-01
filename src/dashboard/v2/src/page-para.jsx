/* PARA · Areas of Life · top-down pixel-art rooms
   Each Area is a full themed room (Lifestyle, Finance, Health, etc).
   User can add/rename/delete areas, change icon + color, and assign agents.
   Agents render as sprites at desks inside their assigned area. */

const Para = () => {
  const { AGENTS } = window.NC_DATA;
  const [tick, setTick] = React.useState(0);
  const [selected, setSelected] = React.useState(null);
  const [editingArea, setEditingArea] = React.useState(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [focusedArea, setFocusedArea] = React.useState(null);
  React.useEffect(() => { const i = setInterval(() => setTick(t => t + 1), 600); return () => clearInterval(i); }, []);

  // ─── Default areas of life ───────────────────────────────
  const ICON_OPTIONS = [
    { key: 'lifestyle', glyph: '◈', label: 'Lifestyle' },
    { key: 'finance',   glyph: '$',  label: 'Finance' },
    { key: 'health',    glyph: '+',  label: 'Health' },
    { key: 'work',      glyph: '▣',  label: 'Work' },
    { key: 'learning',  glyph: '✦',  label: 'Learning' },
    { key: 'creative',  glyph: '◇',  label: 'Creative' },
    { key: 'family',    glyph: '♥',  label: 'Family' },
    { key: 'travel',    glyph: '➤',  label: 'Travel' },
  ];
  const COLOR_OPTIONS = [
    '#00f5d4', '#00b7ff', '#8b5cf6', '#ffb86b',
    '#ff5f7e', '#69f0ae', '#f5d76e', '#b388ff',
  ];

  const [areas, setAreas] = React.useState([
    { id: 'a-life',  name: 'Lifestyle', glyph: '◈', color: '#00f5d4', agentIds: ['alfred','planner'] },
    { id: 'a-fin',   name: 'Finance',   glyph: '$', color: '#69f0ae', agentIds: ['coder'] },
    { id: 'a-health',name: 'Health',    glyph: '+', color: '#ff5f7e', agentIds: ['debugger-42'] },
    { id: 'a-work',  name: 'Work',      glyph: '▣', color: '#00b7ff', agentIds: ['researcher'] },
    { id: 'a-learn', name: 'Learning',  glyph: '✦', color: '#b388ff', agentIds: ['archivist','scribe-08'] },
  ]);

  const addArea = () => {
    const id = `a-${Date.now()}`;
    const palette = COLOR_OPTIONS[areas.length % COLOR_OPTIONS.length];
    setAreas(p => [...p, { id, name: `Area ${p.length + 1}`, glyph: '◇', color: palette, agentIds: [] }]);
    setEditingArea(id);
    setRenameValue(`Area ${areas.length + 1}`);
  };
  const removeArea = id => { if (areas.length <= 1) return; setAreas(p => p.filter(a => a.id !== id)); };
  const renameArea = (id, name) => { setAreas(p => p.map(a => a.id === id ? { ...a, name: name || a.name } : a)); setEditingArea(null); };
  const updateArea = (id, patch) => setAreas(p => p.map(a => a.id === id ? { ...a, ...patch } : a));
  const assignAgent = (agentId, areaId) =>
    setAreas(p => p.map(a => ({
      ...a,
      agentIds: a.id === areaId
        ? (a.agentIds.includes(agentId) ? a.agentIds.filter(x => x !== agentId) : [...a.agentIds, agentId])
        : a.agentIds.filter(x => x !== agentId),
    })));

  // Sprite palette
  const PAL = {
    alfred:    { body: '#f5d76e', accent: '#1a3357', hair: '#3a2a1a' },
    coder:     { body: '#5fc8ff', accent: '#0d2b4a', hair: '#1a1a2a' },
    researcher:{ body: '#b388ff', accent: '#3a1a4a', hair: '#2a1a3a' },
    planner:   { body: '#ffb86b', accent: '#4a2a0a', hair: '#3a1f0a' },
    archivist: { body: '#69f0ae', accent: '#0a3a1a', hair: '#1a2a1a' },
    'debugger-42': { body: '#ff5f7e', accent: '#4a0a1a', hair: '#2a0a1a' },
    'scribe-08':   { body: '#00f5d4', accent: '#0a3a3a', hair: '#1a2a2a' },
  };
  const colorFor = id => PAL[id] || { body: '#9ab0c4', accent: '#1a2a3a', hair: '#222' };

  // ─── Sprite renderer ──────────────────────────────────────
  const Sprite = ({ id, frame, state }) => {
    const c = colorFor(id);
    const sleeping = state === 'sleeping';
    const sitting = state === 'working';
    let map;
    if (sleeping) {
      map = ['............','............','....HHHH....','...HFFFFH...','...HFFFFH...','...HHHHHH...','..BBBBBBBB..','..BAAAAAAB..','..BBBBBBBB..','............'];
    } else if (sitting) {
      const wob = frame % 2;
      map = ['....HHHH....','...HHHHHH...','...HFFFFH...','...HFEEFH...','...HFFFFH...','...HHHHHH...','..BBBBBBBB..','.BBBBBBBBBB.','.BB' + (wob?'B':'.') + 'BBBB' + (wob?'.':'B') + 'BB.','.BBBBBBBBBB.'];
    } else {
      const wob = frame % 2;
      map = ['....HHHH....','...HHHHHH...','...HFFFFH...','...HFEEFH...','...HFFFFH...','..BBBBBBBB..','.BBBBBBBBBB.','.BBBBBBBBBB.','..BB....BB..','..AA....AA..', wob ? '.AAA....AAA.' : 'AAA......AAA'];
    }
    const px = 2;
    const cells = [];
    for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) {
      const ch = map[y][x]; if (ch === '.') continue;
      const bg = ch === 'H' ? c.hair : ch === 'F' ? '#ffd6a5' : ch === 'B' ? c.body : ch === 'A' ? c.accent : '#0a0a0a';
      cells.push(<span key={`${x}-${y}`} style={{ position: 'absolute', left: x * px, top: y * px, width: px, height: px, background: bg }} />);
    }
    return <div style={{ position: 'relative', width: 12 * px, height: map.length * px }}>{cells}</div>;
  };

  const Desk = ({ active, color }) => (
    <div style={{ position: 'relative', width: 28, height: 14 }}>
      <div style={{ position: 'absolute', left: 0, top: 8, width: 28, height: 6, background: '#5a3a1f', borderTop: '2px solid #7a5a3a' }} />
      <div style={{ position: 'absolute', left: 8, top: 0, width: 12, height: 8, background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
        <div style={{ position: 'absolute', inset: 1, background: active ? color : '#1a3344', opacity: 0.85 }} />
        <div style={{ position: 'absolute', left: 2, top: 2, width: 6, height: 1, background: '#fff', opacity: 0.5 }} />
      </div>
      <div style={{ position: 'absolute', left: 6, top: 9, width: 16, height: 2, background: '#aaa' }} />
    </div>
  );

  const Bubble = ({ text, color = '#fff' }) => (
    <div className="mono" style={{
      position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 4,
      background: color, color: '#0a0a14', padding: '2px 5px', fontSize: 8, letterSpacing: '0.05em',
      whiteSpace: 'nowrap', boxShadow: '2px 2px 0 rgba(0,0,0,0.5)',
    }}>
      {text}
      <span style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `4px solid ${color}` }} />
    </div>
  );

  const workBubbles = ['compiling…', 'tool: grep', 'streaming', 'route: opus', 'thinking', 'spawn child'];
  const idleBubbles = ['idle', 'tea?', 'reading', 'syncing'];
  const sleepBubbles = ['Zzz'];

  // ─── Workstation inside an area ──────────────────────────
  const Workstation = ({ agent, x, y, areaColor }) => {
    const stateMap = { busy: 'working', live: 'working', idle: 'sleeping' };
    const state = agent.temp ? 'standing' : (stateMap[agent.status] || 'standing');
    const frame = (tick + (agent.id.charCodeAt(0) || 0)) % 2;
    const showBubble = tick % 8 < 5;
    const bubbleList = state === 'working' ? workBubbles : state === 'sleeping' ? sleepBubbles : idleBubbles;
    const bubble = bubbleList[(agent.id.charCodeAt(0) + Math.floor(tick / 6)) % bubbleList.length];

    return (
      <div
        onClick={(e) => { e.stopPropagation(); setSelected(agent); }}
        style={{ position: 'absolute', left: x, top: y, cursor: 'pointer', transform: 'translateX(-50%)' }}
      >
        <div className="mono" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: -10, fontSize: 7, color: 'rgba(255,255,255,0.65)', whiteSpace: 'nowrap' }}>
          {agent.name.toUpperCase()}
        </div>
        {showBubble && <Bubble text={bubble} color={areaColor} />}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ position: 'relative', height: 20, marginBottom: -6 }}>
            <Sprite id={agent.id} frame={frame} state={state} />
          </div>
          <Desk active={state === 'working'} color={areaColor} />
          <div style={{ width: 18, height: 4, background: '#2a1a0a', marginTop: 1 }} />
        </div>
      </div>
    );
  };

  // ─── Single Area room ────────────────────────────────────
  const AreaRoom = ({ area, focused }) => {
    const W = focused ? 800 : 360;
    const H = focused ? 360 : 200;
    const isEditing = editingArea === area.id;
    const agents = area.agentIds.map(id => AGENTS.find(a => a.id === id)).filter(Boolean);

    // floor tint based on area color
    const floorBg = `color-mix(in oklch, ${area.color} 18%, #0a0a14)`;

    return (
      <div style={{
        position: 'relative', width: W, height: H,
        background: floorBg,
        border: `3px solid ${area.color}`,
        boxShadow: `0 0 0 1px #000, inset 0 0 30px rgba(0,0,0,0.4), 0 0 14px ${area.color}55`,
      }}>
        {/* tiled floor */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${area.color}1a 1px, transparent 1px), linear-gradient(90deg, ${area.color}1a 1px, transparent 1px)`, backgroundSize: '24px 24px', opacity: 0.6 }} />

        {/* area door-sign / header */}
        <div style={{
          position: 'absolute', top: 6, left: 8, padding: '4px 8px',
          background: '#0a0a14', border: `2px solid ${area.color}`, zIndex: 5,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span className="pixel" style={{ fontSize: 13, color: area.color, textShadow: `0 0 6px ${area.color}` }}>{area.glyph}</span>
          {isEditing ? (
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={() => renameArea(area.id, renameValue)}
              onKeyDown={e => { if (e.key === 'Enter') renameArea(area.id, renameValue); if (e.key === 'Escape') setEditingArea(null); }}
              className="mono"
              style={{ background: '#000', color: area.color, border: `1px solid ${area.color}`, outline: 'none', fontSize: 10, padding: '1px 4px', width: 110, letterSpacing: '0.1em' }}
            />
          ) : (
            <span
              onClick={(e) => { e.stopPropagation(); setEditingArea(area.id); setRenameValue(area.name); }}
              className="pixel"
              style={{ fontSize: 11, color: area.color, letterSpacing: '0.16em', textShadow: `0 0 6px ${area.color}`, cursor: 'text' }}
              title="click to rename"
            >{area.name.toUpperCase()}</span>
          )}
        </div>

        {/* controls top-right */}
        <div style={{ position: 'absolute', top: 6, right: 8, display: 'flex', gap: 4, zIndex: 5 }}>
          <span className="mono" style={{ fontSize: 9, color: area.color, padding: '4px 6px', border: `1px solid ${area.color}55` }}>{agents.length} AGENTS</span>
          <button
            onClick={(e) => { e.stopPropagation(); setFocusedArea(focused ? null : area.id); }}
            className="mono" title={focused ? 'minimize' : 'expand'}
            style={{ background: 'transparent', color: area.color, border: `1px solid ${area.color}55`, fontSize: 9, padding: '2px 5px', cursor: 'pointer' }}
          >{focused ? '▢' : '⤢'}</button>
          {areas.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); if (confirm(`Delete area "${area.name}"?`)) removeArea(area.id); }}
              className="mono" title="delete area"
              style={{ background: 'transparent', color: area.color, border: `1px solid ${area.color}55`, fontSize: 9, padding: '2px 6px', cursor: 'pointer', fontWeight: 700 }}
            >×</button>
          )}
        </div>

        {/* corner pixels */}
        {[[0,0],[0,1],[1,0],[1,1]].map(([cx,cy]) => (
          <span key={`${cx}-${cy}`} style={{ position: 'absolute', [cx===0?'left':'right']: -3, [cy===0?'top':'bottom']: -3, width: 6, height: 6, background: area.color, boxShadow: `0 0 4px ${area.color}`, zIndex: 6 }} />
        ))}

        {/* room decor: depending on area icon */}
        {area.glyph === '$' && (
          <div style={{ position: 'absolute', right: 16, bottom: 14, fontFamily: 'monospace', fontSize: 18, color: area.color, opacity: 0.4, letterSpacing: 6 }}>$$$</div>
        )}
        {area.glyph === '+' && (
          <div style={{ position: 'absolute', right: 18, bottom: 14, fontFamily: 'monospace', fontSize: 22, color: area.color, opacity: 0.4 }}>♡</div>
        )}
        {area.glyph === '✦' && (
          <div style={{ position: 'absolute', right: 18, bottom: 12, fontFamily: 'monospace', fontSize: 22, color: area.color, opacity: 0.4 }}>📚</div>
        )}

        {/* desks laid out across the room */}
        {agents.map((a, i) => {
          const cols = focused ? Math.min(agents.length, 5) : Math.min(agents.length, 3);
          const rows = Math.ceil(agents.length / cols);
          const col = i % cols;
          const row = Math.floor(i / cols);
          const padX = 60, padY = 60;
          const innerW = W - padX * 2;
          const innerH = H - padY - 30;
          const x = padX + (cols === 1 ? innerW / 2 : (innerW / (cols - 1 || 1)) * col);
          const y = padY + (rows === 1 ? innerH / 2 : (innerH / (rows - 1 || 1)) * row);
          return <Workstation key={a.id} agent={a} x={x} y={y} areaColor={area.color} />;
        })}

        {agents.length === 0 && (
          <div className="mono" style={{ position: 'absolute', left: '50%', top: '60%', transform: 'translate(-50%,-50%)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.15em', textAlign: 'center' }}>
            // empty room<br/><span style={{ fontSize: 8 }}>assign agents in the right panel →</span>
          </div>
        )}

        {/* footer mini-stats */}
        <div className="mono" style={{ position: 'absolute', bottom: 4, left: 8, fontSize: 8, color: area.color, opacity: 0.7, letterSpacing: '0.1em' }}>
          T+{String(tick).padStart(4, '0')} · LIVE
        </div>
      </div>
    );
  };

  // ─── Detail panel for selected agent ─────────────────────
  const Detail = () => {
    if (!selected) return <div className="mono muted" style={{ padding: 16, textAlign: 'center', fontSize: 11 }}>// click an agent to inspect</div>;
    const a = selected;
    const c = colorFor(a.id);
    const inArea = areas.find(ar => ar.agentIds.includes(a.id));
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div style={{ background: '#0a0a14', padding: 4, border: `1px solid ${c.body}` }}>
            <Sprite id={a.id} frame={tick % 2} state="working" />
          </div>
          <div>
            <div className="mono" style={{ fontSize: 13, color: '#fff', fontWeight: 700 }}>{a.name}</div>
            <div className="mono muted" style={{ fontSize: 10 }}>@{a.id} · {a.role}</div>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 10, lineHeight: 1.7, color: 'var(--text-soft)' }}>
          <div>STATUS · <span style={{ color: '#fff' }}>{a.status}</span></div>
          <div>AREA · <span style={{ color: inArea ? inArea.color : 'var(--muted)' }}>{inArea ? inArea.name : 'unassigned'}</span></div>
          <div>PROVIDER · <span style={{ color: '#fff' }}>{a.provider} / {a.model}</span></div>
          <div>TASKS · <span style={{ color: 'var(--neon)' }}>{a.tasks}</span> active</div>
        </div>
      </div>
    );
  };

  // ─── Render ──────────────────────────────────────────────
  const focusedAreaObj = focusedArea ? areas.find(a => a.id === focusedArea) : null;

  return (
    <div>
      <PageHeader
        title="Areas of Life"
        subtitle="// each area is its own room · add, rename, customize, assign agents"
        right={<>
          <span className="tag blue pixel" style={{ fontSize: 11, letterSpacing: '0.2em' }}>{areas.length} AREAS</span>
          <button className="nc-btn primary" onClick={addArea}><Icon name="plus" size={12}/> New area</button>
        </>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 12 }}>
        {/* ─── BUILDING FLOOR ─── */}
        <div className="nc-panel glow" style={{ padding: 14, background: '#0a0a14', position: 'relative' }}>
          <div className="scan-line" />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--line-soft)' }}>
            <div>
              <div className="pixel" style={{ fontSize: 14, color: 'var(--neon)', letterSpacing: '0.2em', textShadow: '0 0 8px var(--neon)' }}>NEUROCLAW HQ · ROOMS</div>
              <div className="mono muted" style={{ fontSize: 9, marginTop: 2 }}>click ⤢ to expand any room · click an agent to inspect · click area title to rename</div>
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--neon-2)' }}>T+{String(tick).padStart(5, '0')} <span className="blink">▌</span></div>
          </div>

          {focusedAreaObj ? (
            <div>
              <button onClick={() => setFocusedArea(null)} className="nc-btn" style={{ marginBottom: 12 }}><Icon name="arrow-left" size={11}/> Back to all rooms</button>
              <AreaRoom area={focusedAreaObj} focused />
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              {areas.map(area => <AreaRoom key={area.id} area={area} focused={false} />)}
              <div
                onClick={addArea}
                style={{
                  height: 200, border: '3px dashed rgba(255,255,255,0.18)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: 'rgba(255,255,255,0.4)',
                  flexDirection: 'column', gap: 6,
                  transition: 'border-color 0.2s, color 0.2s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--neon)'; e.currentTarget.style.color = 'var(--neon)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
              >
                <span className="pixel" style={{ fontSize: 28, letterSpacing: '0.2em' }}>+</span>
                <span className="mono" style={{ fontSize: 10, letterSpacing: '0.18em' }}>NEW AREA</span>
              </div>
            </div>
          )}
        </div>

        {/* ─── RIGHT PANEL ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Section title="MANAGE AREAS">
            <div className="mono muted" style={{ fontSize: 9, marginBottom: 8 }}>// edit name · icon · color · agents</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflow: 'auto', paddingRight: 4 }}>
              {areas.map(area => (
                <div key={area.id} style={{ padding: 8, border: `1px solid ${area.color}66`, background: `${area.color}0d` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span className="pixel" style={{ fontSize: 14, color: area.color, textShadow: `0 0 4px ${area.color}` }}>{area.glyph}</span>
                    <input
                      value={area.name}
                      onChange={e => updateArea(area.id, { name: e.target.value })}
                      className="mono"
                      style={{ flex: 1, background: 'transparent', color: '#fff', border: 'none', borderBottom: `1px solid ${area.color}44`, outline: 'none', fontSize: 11, padding: '1px 0', letterSpacing: '0.08em' }}
                    />
                    {areas.length > 1 && (
                      <button onClick={() => { if (confirm(`Delete "${area.name}"?`)) removeArea(area.id); }}
                        style={{ background: 'transparent', border: 'none', color: area.color, fontSize: 14, cursor: 'pointer', padding: 0, lineHeight: 1, fontWeight: 700 }} title="delete">×</button>
                    )}
                  </div>
                  {/* icon picker */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 6 }}>
                    {ICON_OPTIONS.map(ic => (
                      <button key={ic.key} onClick={() => updateArea(area.id, { glyph: ic.glyph })} title={ic.label}
                        className="pixel"
                        style={{
                          width: 22, height: 22, fontSize: 12,
                          background: area.glyph === ic.glyph ? area.color : 'transparent',
                          color: area.glyph === ic.glyph ? '#000' : area.color,
                          border: `1px solid ${area.color}55`, cursor: 'pointer',
                        }}>{ic.glyph}</button>
                    ))}
                  </div>
                  {/* color picker */}
                  <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
                    {COLOR_OPTIONS.map(col => (
                      <button key={col} onClick={() => updateArea(area.id, { color: col })}
                        style={{ width: 18, height: 18, background: col, border: area.color === col ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)', cursor: 'pointer', padding: 0 }} />
                    ))}
                  </div>
                  {/* agent chips */}
                  <div className="mono" style={{ fontSize: 8, color: 'var(--muted)', marginBottom: 3, letterSpacing: '0.12em' }}>AGENTS</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {AGENTS.map(a => {
                      const inHere = area.agentIds.includes(a.id);
                      return (
                        <button key={a.id} onClick={() => assignAgent(a.id, area.id)}
                          className="mono"
                          style={{
                            fontSize: 8, padding: '2px 5px', letterSpacing: '0.06em',
                            background: inHere ? area.color : 'transparent',
                            color: inHere ? '#000' : 'var(--text-soft)',
                            border: `1px solid ${inHere ? area.color : 'rgba(255,255,255,0.12)'}`,
                            cursor: 'pointer',
                          }}>{a.name}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <button className="nc-btn primary" onClick={addArea} style={{ width: '100%' }}>
                <Icon name="plus" size={11}/> Add area
              </button>
            </div>
          </Section>

          <Section title="AGENT INSPECTOR">
            <Detail />
          </Section>
        </div>
      </div>
    </div>
  );
};

window.Para = Para;
