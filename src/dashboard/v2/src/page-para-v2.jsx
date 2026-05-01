/* PARA Office Visualizer · top-down pixel-art floor plan
   4 wings (Projects, Areas, Resources, Archives) with themed rooms.
   Each agent has a desk + sprite that animates based on status. */

const Para = () => {
  const { AGENTS } = window.NC_DATA;
  const [tick, setTick] = React.useState(0);
  const [selected, setSelected] = React.useState(null);
  // EDITABLE AREAS — user can add/rename/delete sub-areas inside the AREAS wing.
  // Each area is a "huddle pod" with assigned standby agents.
  const [areas, setAreas] = React.useState([
    { id: 'a-1', name: 'Standby Floor', agentIds: [] }, // default catch-all
    { id: 'a-2', name: 'Reading Room', agentIds: [] },
    { id: 'a-3', name: 'Briefing Pod', agentIds: [] },
  ]);
  const [editingArea, setEditingArea] = React.useState(null);
  const [renameValue, setRenameValue] = React.useState('');
  React.useEffect(() => { const i = setInterval(() => setTick(t => t+1), 600); return () => clearInterval(i); }, []);

  const addArea = () => {
    const id = `a-${Date.now()}`;
    setAreas(prev => [...prev, { id, name: `New Area ${prev.length + 1}`, agentIds: [] }]);
  };
  const removeArea = (id) => {
    if (areas.length <= 1) return; // keep at least one
    setAreas(prev => prev.filter(a => a.id !== id));
  };
  const renameArea = (id, name) => {
    setAreas(prev => prev.map(a => a.id === id ? { ...a, name } : a));
    setEditingArea(null);
  };
  const assignAgent = (agentId, areaId) => {
    setAreas(prev => prev.map(a => ({
      ...a,
      agentIds: a.id === areaId ? [...new Set([...a.agentIds, agentId])] : a.agentIds.filter(x => x !== agentId)
    })));
  };

  // Map agents → desk slots in the four wings
  // PROJECTS = working, AREAS = standby, RESOURCES = temp/queue, ARCHIVES = sleeping
  const placements = {
    projects:  AGENTS.filter(a => a.status === 'busy' || (a.status === 'live' && a.tasks > 3)),
    areas:     AGENTS.filter(a => a.status === 'live' && a.tasks <= 3 && !a.temp),
    resources: AGENTS.filter(a => a.temp),
    archives:  AGENTS.filter(a => a.status === 'idle'),
  };

  // ─── Agent palette (pixel sprites — 12x16 px each, 2 frames) ──────────────
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

  // ─── Sprite renderer (CSS box-shadows over a single dot — one element per pixel) ──
  // Returns a div with absolute-positioned pixel cells. body/hair/accent applied per pixel.
  const Sprite = ({ id, frame, dir = 'down', state }) => {
    const c = colorFor(id);
    // 12x16 pixel sprite. Codes: H=hair, F=face/skin (#ffd6a5), B=body, A=accent (shoes/belt), E=eyes, .=transparent
    // Two frames for walk; one for sit; sleep frame closes eyes.
    const sleeping = state === 'sleeping';
    const sitting = state === 'working' || state === 'standby' || state === 'queue';
    let map;
    if (sleeping) {
      // Lying down (rotated form, pillow)
      map = [
        '............',
        '............',
        '............',
        '....HHHH....',
        '...HFFFFH...',
        '...HFEFFH...',  // closed eyes (no E dots, just face)
        '...HFFFFH...',
        '...HHHHHH...',
        '..BBBBBBBB..',
        '..BAAAAAAB..',
        '..BBBBBBBB..',
        '..BBBBBBBB..',
        '..BBBBBBBB..',
        '............',
        '............',
        '............',
      ];
    } else if (sitting) {
      // Sitting at desk (back of head visible from above + shoulders)
      const wob = frame % 2;
      map = [
        '............',
        '....HHHH....',
        '...HHHHHH...',
        '...HFFFFH...',
        '...HFEEFH...',
        '...HFFFFH...',
        '...HHHHHH...',
        '..BBBBBBBB..',
        '..BBBBBBBB..',
        '.BBBABBABBB.',
        '.BBBBBBBBBB.',
        '.BB'+(wob?'B':'.')+'BBBB'+(wob?'.':'B')+'BB.',
        '.BBBBBBBBBB.',
        '............',
        '............',
        '............',
      ];
    } else {
      // Standing/idle (PARA pacing)
      const wob = frame % 2;
      map = [
        '....HHHH....',
        '...HHHHHH...',
        '...HFFFFH...',
        '...HFEEFH...',
        '...HFFFFH...',
        '...HHHHHH...',
        '..BBBBBBBB..',
        '.BBBBBBBBBB.',
        '.BBBBBBBBBB.',
        '.BBBBBBBBBB.',
        '..BBBBBBBB..',
        '..BB....BB..',
        '..BB....BB..',
        '..BB....BB..',
        '..AA....AA..',
        wob ? '.AAA....AAA.' : 'AAA......AAA',
      ];
    }

    const px = 2;
    const cells = [];
    for (let y = 0; y < map.length; y++) {
      for (let x = 0; x < map[y].length; x++) {
        const ch = map[y][x];
        if (ch === '.') continue;
        let bg;
        if (ch === 'H') bg = c.hair;
        else if (ch === 'F') bg = '#ffd6a5';
        else if (ch === 'B') bg = c.body;
        else if (ch === 'A') bg = c.accent;
        else if (ch === 'E') bg = '#0a0a0a';
        cells.push(
          <span key={`${x}-${y}`} style={{
            position: 'absolute', left: x*px, top: y*px, width: px, height: px, background: bg,
          }}/>
        );
      }
    }
    return <div style={{ position: 'relative', width: 12*px, height: 16*px, imageRendering: 'pixelated' }}>{cells}</div>;
  };

  // ─── Desk furniture sprite ────────────────────────────────────
  const Desk = ({ active }) => {
    const screenColor = active ? '#00ff88' : '#1a3344';
    return (
      <div style={{ position: 'relative', width: 28, height: 14 }}>
        {/* desk surface */}
        <div style={{ position: 'absolute', left: 0, top: 8, width: 28, height: 6, background: '#5a3a1f', borderTop: '2px solid #7a5a3a', borderBottom: '1px solid #2a1a0a' }}/>
        {/* monitor */}
        <div style={{ position: 'absolute', left: 8, top: 0, width: 12, height: 8, background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
          <div style={{ position: 'absolute', inset: 1, background: screenColor, opacity: 0.85 }}/>
          {/* screen lines */}
          <div style={{ position: 'absolute', left: 2, top: 2, width: 6, height: 1, background: '#fff', opacity: 0.5 }}/>
          <div style={{ position: 'absolute', left: 2, top: 4, width: 4, height: 1, background: '#fff', opacity: 0.4 }}/>
        </div>
        {/* keyboard */}
        <div style={{ position: 'absolute', left: 6, top: 9, width: 16, height: 2, background: '#aaa' }}/>
      </div>
    );
  };

  // ─── Decor sprites ─────────────────────────────────────────────
  const Plant = () => (
    <div style={{ position: 'relative', width: 12, height: 16 }}>
      <div style={{ position: 'absolute', left: 2, top: 8, width: 8, height: 6, background: '#5a3a1f', borderTop: '1px solid #7a5a3a' }}/>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 4, height: 6, background: '#3a8a3a' }}/>
      <div style={{ position: 'absolute', left: 4, top: -2, width: 4, height: 8, background: '#4aaa4a' }}/>
      <div style={{ position: 'absolute', left: 8, top: 0, width: 4, height: 6, background: '#3a8a3a' }}/>
    </div>
  );
  const Server = ({ blink }) => (
    <div style={{ position: 'relative', width: 14, height: 22, background: '#1a2a3a', border: '1px solid #2a4a5a' }}>
      {[0,1,2,3].map(i => (
        <div key={i} style={{ position: 'absolute', left: 2, top: 2 + i*5, width: 10, height: 3, background: '#0a1a2a', display: 'flex', gap: 1, padding: 1 }}>
          <span style={{ width: 1, height: 1, background: blink && i === (Math.floor(Date.now()/200) % 4) ? '#ff5555' : '#00ff88' }}/>
          <span style={{ width: 1, height: 1, background: '#00ff88' }}/>
          <span style={{ width: 1, height: 1, background: '#00b7ff' }}/>
        </div>
      ))}
    </div>
  );
  const Bunk = () => (
    <div style={{ position: 'relative', width: 36, height: 18 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#3a2a4a', border: '1px solid #5a3a6a' }}/>
      <div style={{ position: 'absolute', left: 2, top: 2, right: 2, bottom: 2, background: '#5a4a7a' }}/>
      <div style={{ position: 'absolute', left: 4, top: 4, width: 8, height: 6, background: '#fff', opacity: 0.7 }}/>{/* pillow */}
    </div>
  );
  const Printer = ({ active }) => (
    <div style={{ position: 'relative', width: 18, height: 14 }}>
      <div style={{ position: 'absolute', left: 0, top: 4, width: 18, height: 8, background: '#888' }}/>
      <div style={{ position: 'absolute', left: 2, top: 0, width: 14, height: 5, background: '#aaa' }}/>
      <div style={{ position: 'absolute', left: 3, top: 8, width: 12, height: 2, background: active ? '#00ff88' : '#444' }}/>
      {active && <div style={{ position: 'absolute', left: 4, top: -3, width: 10, height: 4, background: '#fff' }}/>}
    </div>
  );
  const Coffee = () => (
    <div style={{ position: 'relative', width: 10, height: 14 }}>
      <div style={{ position: 'absolute', left: 1, top: 4, width: 8, height: 10, background: '#222' }}/>
      <div style={{ position: 'absolute', left: 2, top: 0, width: 1, height: 4, background: '#fff', opacity: 0.6 }}/>
      <div style={{ position: 'absolute', left: 5, top: 0, width: 1, height: 4, background: '#fff', opacity: 0.6 }}/>
    </div>
  );

  // ─── Speech bubble ─────────────────────────────────────────────
  const Bubble = ({ text, color = '#fff' }) => (
    <div className="mono" style={{
      position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 4,
      background: color, color: '#0a0a14', padding: '3px 6px', fontSize: 9, letterSpacing: '0.05em',
      whiteSpace: 'nowrap', boxShadow: '2px 2px 0 rgba(0,0,0,0.5)',
      imageRendering: 'pixelated',
    }}>
      {text}
      <span style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `4px solid ${color}` }}/>
    </div>
  );

  // ─── Single workstation (desk + agent + bubble) ─────────────────────────
  const Workstation = ({ agent, x, y, state, bubble, bubbleColor }) => {
    const isWorking = state === 'working';
    const frame = (tick + (agent.id.charCodeAt(0) || 0)) % 2;
    const showBubble = bubble && (tick % 6 < 4);
    return (
      <div
        onClick={() => setSelected(agent)}
        style={{ position: 'absolute', left: x, top: y, cursor: 'pointer', transition: 'transform 0.2s' }}
        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.08)'}
        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
      >
        {/* nameplate */}
        <div className="mono" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: -10, fontSize: 8, color: 'var(--text-soft)', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>
          {agent.name.toUpperCase()}
        </div>
        {/* bubble */}
        {showBubble && <Bubble text={bubble} color={bubbleColor}/>}
        {/* sprite sitting behind/above desk */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ position: 'relative', height: 20, marginBottom: -6 }}>
            <Sprite id={agent.id} frame={frame} state={state === 'sleeping' ? 'sleeping' : 'working'}/>
          </div>
          <Desk active={isWorking}/>
          {/* chair */}
          <div style={{ width: 18, height: 4, background: '#2a1a0a', marginTop: 1 }}/>
        </div>
      </div>
    );
  };

  // ─── Walking sprite (for STANDBY pacing & QUEUE shuffle) ────────────────
  const Wanderer = ({ agent, baseX, baseY, range, bubble, bubbleColor }) => {
    const seed = agent.id.charCodeAt(0) || 0;
    const phase = (tick * 0.4 + seed) % (Math.PI * 2);
    const x = baseX + Math.sin(phase) * range;
    const y = baseY + Math.cos(phase * 0.7) * (range * 0.4);
    const frame = tick % 2;
    const showBubble = bubble && (tick % 8 < 5);
    return (
      <div onClick={() => setSelected(agent)} style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', cursor: 'pointer', transition: 'left 0.6s linear, top 0.6s linear' }}>
        <div className="mono" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: -10, fontSize: 8, color: 'var(--text-soft)', whiteSpace: 'nowrap' }}>
          {agent.name.toUpperCase()}
        </div>
        {showBubble && <Bubble text={bubble} color={bubbleColor}/>}
        <Sprite id={agent.id} frame={frame} state="standing"/>
      </div>
    );
  };

  // ─── Sleeper in bunk ────────────────────────────────────────
  const Sleeper = ({ agent, x, y }) => (
    <div onClick={() => setSelected(agent)} style={{ position: 'absolute', left: x, top: y, cursor: 'pointer' }}>
      <div className="mono" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: -10, fontSize: 8, color: 'var(--text-soft)' }}>
        {agent.name.toUpperCase()}
      </div>
      {/* Zzz */}
      {tick % 3 === 0 && (
        <div className="mono" style={{ position: 'absolute', left: '70%', top: -16, fontSize: 11, color: 'var(--violet)', textShadow: '0 0 6px var(--violet)' }}>z</div>
      )}
      {tick % 4 === 1 && (
        <div className="mono" style={{ position: 'absolute', left: '85%', top: -22, fontSize: 14, color: 'var(--violet)', textShadow: '0 0 6px var(--violet)' }}>Z</div>
      )}
      <Bunk/>
      <div style={{ position: 'absolute', left: 6, top: -3 }}>
        <Sprite id={agent.id} frame={0} state="sleeping"/>
      </div>
    </div>
  );

  // ─── Bubble copy per state (pulled from agent name + cycling tasks) ────
  const workBubbles = ['compiling…', 'running diff', 'tool: grep', 'streaming…', 'route: opus', 'thinking', 'tokens 4.2k', 'spawn child', 'eval(plan)'];
  const standbyBubbles = ['idle', 'awaiting', 'tea?', 'coffee', 'check #vault', 'reading rfc'];
  const queueBubbles = ['ttl 240s', 'queue 3/8', 'spawned', 'awaiting slot'];
  const pickBubble = (id, list) => list[(id.charCodeAt(0) + tick / 6 | 0) % list.length];

  // ─── Wing/room renderer ────────────────────────────────────
  const wallColor = '#1a2a3a';
  const floorByZone = {
    projects:  '#0a3a4a', // teal — work floor
    areas:     '#3a3a1a', // olive — meeting carpet
    resources: '#3a2a0a', // amber wood — break area
    archives:  '#2a1a3a', // violet — bunk room
  };

  const Room = ({ id, label, hint, color, glyph, children, w, h, agentCount }) => (
    <div style={{
      position: 'relative', width: w, height: h,
      background: floorByZone[id],
      border: `3px solid ${color}`, boxShadow: `0 0 0 1px #000, inset 0 0 30px rgba(0,0,0,0.4), 0 0 12px ${color}66`,
      imageRendering: 'pixelated',
    }}>
      {/* tiled floor */}
      <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${color}1a 1px, transparent 1px), linear-gradient(90deg, ${color}1a 1px, transparent 1px)`, backgroundSize: '24px 24px', opacity: 0.6 }}/>
      {/* room signage */}
      <div className="pixel" style={{
        position: 'absolute', top: 6, left: 8, padding: '4px 8px',
        background: '#0a0a14', color: color, border: `2px solid ${color}`,
        fontSize: 11, letterSpacing: '0.16em', textShadow: `0 0 6px ${color}`,
        zIndex: 5,
      }}>
        {glyph} {label}
      </div>
      <div className="mono" style={{ position: 'absolute', top: 8, right: 10, fontSize: 9, color, letterSpacing: '0.1em', zIndex: 5 }}>
        {agentCount} UNITS · {hint}
      </div>
      {/* corner pixels */}
      {[[0,0],[0,1],[1,0],[1,1]].map(([cx,cy]) => (
        <span key={`${cx}-${cy}`} style={{
          position: 'absolute',
          [cx === 0 ? 'left' : 'right']: -3,
          [cy === 0 ? 'top' : 'bottom']: -3,
          width: 6, height: 6, background: color, boxShadow: `0 0 4px ${color}`, zIndex: 6,
        }}/>
      ))}
      {children}
    </div>
  );

  // ─── PROJECTS WING (working agents at desks in 2 rows) ─────────────────
  const projectsAgents = placements.projects;
  const ProjectsWing = () => (
    <Room id="projects" label="PROJECTS" hint="WORKING" color="var(--neon)" glyph="▣" w={520} h={260} agentCount={projectsAgents.length}>
      {/* server rack */}
      <div style={{ position: 'absolute', right: 16, top: 36 }}>
        <Server blink/>
      </div>
      <div style={{ position: 'absolute', right: 36, top: 36 }}>
        <Server blink/>
      </div>
      {/* whiteboard */}
      <div style={{ position: 'absolute', left: 16, top: 36, width: 80, height: 40, background: '#fff', border: '2px solid #888' }}>
        <div className="mono" style={{ fontSize: 6, color: '#000', padding: 2, lineHeight: 1.3 }}>
          // SPRINT<br/>· route fix<br/>· tool retry<br/>· dream cycle
        </div>
      </div>
      {/* desks: row 1 */}
      {projectsAgents.slice(0, 4).map((a, i) => (
        <Workstation key={a.id} agent={a} x={120 + i*90} y={90} state="working" bubble={pickBubble(a.id, workBubbles)} bubbleColor="#00f5d4"/>
      ))}
      {/* desks: row 2 */}
      {projectsAgents.slice(4, 8).map((a, i) => (
        <Workstation key={a.id} agent={a} x={120 + i*90} y={190} state="working" bubble={pickBubble(a.id, workBubbles)} bubbleColor="#00f5d4"/>
      ))}
      {/* plants */}
      <div style={{ position: 'absolute', left: 8, bottom: 8 }}><Plant/></div>
      <div style={{ position: 'absolute', right: 8, bottom: 8 }}><Plant/></div>
    </Room>
  );

  // ─── AREAS WING (standby — editable sub-areas) ─────────────────────
  const areasAgents = placements.areas;
  // Auto-bucket unassigned agents into the first area
  const assignedSet = new Set(areas.flatMap(a => a.agentIds));
  const unassigned = areasAgents.filter(a => !assignedSet.has(a.id));
  const areasResolved = areas.map((area, idx) => ({
    ...area,
    agents: [
      ...areasAgents.filter(a => area.agentIds.includes(a.id)),
      ...(idx === 0 ? unassigned : []),
    ],
  }));

  const AreasWing = () => {
    const wingW = 400;
    const wingH = 260;
    const cols = areas.length <= 2 ? areas.length : 2;
    const rows = Math.ceil(areas.length / cols);
    const padX = 12, padY = 50, gap = 8;
    const podW = (wingW - padX*2 - gap*(cols-1)) / cols;
    const podH = (wingH - padY - 14 - gap*(rows-1)) / rows;

    return (
      <Room id="areas" label="AREAS" hint="STANDBY · EDITABLE" color="var(--neon-2)" glyph="◈" w={wingW} h={wingH} agentCount={areasAgents.length}>
        {/* Add-area button (only here) */}
        <button
          onClick={addArea}
          className="mono"
          style={{
            position: 'absolute', top: 6, right: 90, zIndex: 10,
            background: 'var(--neon-2)', color: '#000', border: 'none',
            padding: '3px 8px', fontSize: 9, letterSpacing: '0.12em', cursor: 'pointer',
            fontWeight: 700, boxShadow: '2px 2px 0 rgba(0,0,0,0.5)',
          }}
        >+ ADD AREA</button>

        {/* Sub-area pods */}
        {areasResolved.map((area, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = padX + col * (podW + gap);
          const y = padY + row * (podH + gap);
          const isEditing = editingArea === area.id;
          return (
            <div key={area.id} style={{
              position: 'absolute', left: x, top: y, width: podW, height: podH,
              background: 'rgba(0, 245, 212, 0.04)',
              border: '2px dashed var(--neon-2)',
              boxShadow: 'inset 0 0 12px rgba(0, 245, 212, 0.08)',
            }}>
              {/* Pod header w/ rename + delete */}
              <div style={{
                position: 'absolute', top: -1, left: -1, right: -1, height: 16,
                background: 'var(--neon-2)', display: 'flex', alignItems: 'center',
                padding: '0 4px', gap: 4,
              }}>
                {isEditing ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => renameArea(area.id, renameValue || area.name)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') renameArea(area.id, renameValue || area.name);
                      if (e.key === 'Escape') setEditingArea(null);
                    }}
                    className="mono"
                    style={{ flex: 1, background: '#000', color: 'var(--neon-2)', border: 'none', outline: 'none', fontSize: 9, padding: '1px 3px', letterSpacing: '0.08em' }}
                  />
                ) : (
                  <div
                    onClick={() => { setEditingArea(area.id); setRenameValue(area.name); }}
                    className="mono"
                    style={{ flex: 1, fontSize: 9, color: '#000', fontWeight: 700, letterSpacing: '0.1em', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title="click to rename"
                  >
                    ◈ {area.name.toUpperCase()}
                  </div>
                )}
                <span className="mono" style={{ fontSize: 8, color: '#000', opacity: 0.7 }}>{area.agents.length}</span>
                {areas.length > 1 && (
                  <button
                    onClick={() => removeArea(area.id)}
                    title="delete area"
                    style={{ background: 'transparent', border: 'none', color: '#000', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, fontWeight: 700 }}
                  >×</button>
                )}
              </div>

              {/* Tiny round table in pod */}
              <div style={{
                position: 'absolute', left: '50%', top: '55%', transform: 'translate(-50%, -50%)',
                width: Math.min(podW * 0.4, 50), height: Math.min(podH * 0.35, 30),
                borderRadius: '50%', background: '#5a3a1f', border: '2px solid #7a5a3a',
              }}/>

              {/* Agents pacing inside this pod */}
              {area.agents.map((a, j) => {
                const angle = (j / Math.max(area.agents.length, 1)) * Math.PI * 2;
                const r = Math.min(podW, podH) * 0.32;
                const cx = podW / 2 + Math.cos(angle) * r;
                const cy = podH / 2 + 6 + Math.sin(angle) * r * 0.7;
                const phase = (tick * 0.4 + j) % (Math.PI * 2);
                const wx = cx + Math.sin(phase) * 6;
                const wy = cy + Math.cos(phase * 0.7) * 4;
                const frame = tick % 2;
                const showBubble = tick % 8 < 5;
                return (
                  <div key={a.id} onClick={() => setSelected(a)} style={{
                    position: 'absolute', left: wx, top: wy, transform: 'translate(-50%, -50%)',
                    cursor: 'pointer', transition: 'left 0.6s linear, top 0.6s linear',
                  }}>
                    <div className="mono" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: -10, fontSize: 7, color: 'var(--text-soft)', whiteSpace: 'nowrap' }}>
                      {a.name.toUpperCase()}
                    </div>
                    {showBubble && <Bubble text={pickBubble(a.id, standbyBubbles)} color="#00b7ff"/>}
                    <Sprite id={a.id} frame={frame} state="standing"/>
                  </div>
                );
              })}

              {area.agents.length === 0 && (
                <div className="mono" style={{ position: 'absolute', left: '50%', top: '60%', transform: 'translate(-50%,-50%)', fontSize: 8, color: 'var(--muted)', letterSpacing: '0.1em' }}>
                  // empty
                </div>
              )}
            </div>
          );
        })}
      </Room>
    );
  };

  // ─── RESOURCES WING (queue — printer, coffee, temp agents shuffling) ──
  const resAgents = placements.resources;
  const ResourcesWing = () => (
    <Room id="resources" label="RESOURCES" hint="QUEUEING" color="var(--amber)" glyph="◇" w={400} h={200} agentCount={resAgents.length}>
      {/* printer */}
      <div style={{ position: 'absolute', left: 30, top: 50 }}>
        <Printer active={resAgents.length > 0}/>
        <div className="mono" style={{ fontSize: 7, color: '#fff', textAlign: 'center', marginTop: 2 }}>PRINTER</div>
      </div>
      {/* coffee station */}
      <div style={{ position: 'absolute', right: 30, top: 50 }}>
        <Coffee/>
        <div className="mono" style={{ fontSize: 7, color: '#fff', textAlign: 'center', marginTop: 2 }}>COFFEE</div>
      </div>
      {/* queue line */}
      {resAgents.slice(0, 6).map((a, i) => (
        <Wanderer
          key={a.id}
          agent={a}
          baseX={80 + i * 45}
          baseY={130}
          range={6}
          bubble={pickBubble(a.id, queueBubbles)}
          bubbleColor="#ffb86b"
        />
      ))}
      {resAgents.length === 0 && (
        <div className="mono" style={{ position: 'absolute', left: '50%', top: '60%', transform: 'translate(-50%,-50%)', fontSize: 10, color: 'var(--muted)' }}>
          // no temps spawned
        </div>
      )}
    </Room>
  );

  // ─── ARCHIVES WING (sleeping — bunks) ─────────────────────────────────
  const archAgents = placements.archives;
  const ArchivesWing = () => (
    <Room id="archives" label="ARCHIVES" hint="SLEEPING" color="var(--violet)" glyph="▢" w={400} h={200} agentCount={archAgents.length}>
      {/* bunks */}
      {archAgents.map((a, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        return <Sleeper key={a.id} agent={a} x={40 + col * 110} y={60 + row * 70}/>;
      })}
      {archAgents.length === 0 && (
        <div className="mono" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', fontSize: 10, color: 'var(--muted)' }}>
          // all agents awake
        </div>
      )}
      {/* moon decoration */}
      <div style={{ position: 'absolute', right: 16, top: 16, width: 16, height: 16, borderRadius: '50%', background: '#f5d76e', boxShadow: '0 0 12px #f5d76e88' }}/>
    </Room>
  );

  // ─── HALLWAY connector ─────────────────────────────────────────────
  const Hallway = ({ children, w, h }) => (
    <div style={{ position: 'relative', width: w, height: h, background: '#15151f', border: '2px dashed rgba(255,255,255,0.1)' }}>
      {/* walking dots */}
      {[0,1,2].map(i => (
        <div key={i} className="mono" style={{ position: 'absolute', left: `${10 + ((tick * 8 + i*40) % 80)}%`, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--text-soft)' }}>·</div>
      ))}
      {children}
    </div>
  );

  // ─── Detail card for selected agent ────────────────────
  const Detail = () => {
    if (!selected) return (
      <div className="mono muted" style={{ padding: 20, textAlign: 'center', fontSize: 11 }}>
        // click an agent in the office to inspect
      </div>
    );
    const a = selected;
    const c = colorFor(a.id);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ background: '#0a0a14', padding: 4, border: `1px solid ${c.body}` }}>
            <Sprite id={a.id} frame={tick%2} state="working"/>
          </div>
          <div>
            <div className="mono" style={{ fontSize: 14, color: '#fff', fontWeight: 700 }}>{a.name}</div>
            <div className="mono muted" style={{ fontSize: 10 }}>@{a.id} · {a.role}</div>
          </div>
          <span className="tag" style={{ marginLeft: 'auto', background: c.body, color: '#000', fontSize: 9 }}>{a.status.toUpperCase()}</span>
        </div>
        <div className="mono" style={{ fontSize: 10, lineHeight: 1.7, color: 'var(--text-soft)' }}>
          <div>PROVIDER · <span style={{ color: '#fff' }}>{a.provider} / {a.model}</span></div>
          <div>SCOPE · <span style={{ color: '#fff' }}>{a.scope}</span> · DEPTH {a.spawnDepth}</div>
          <div>TASKS · <span style={{ color: 'var(--neon)' }}>{a.tasks}</span> active</div>
          <div>TEMP · <span style={{ color: a.temp ? 'var(--amber)' : '#fff' }}>{a.temp ? 'yes (ttl bound)' : 'no'}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button className="nc-btn primary"><Icon name="chat" size={11}/> Chat</button>
          <button className="nc-btn"><Icon name="bolt" size={11}/> Wake</button>
          <button className="nc-btn"><Icon name="archive" size={11}/> Park</button>
        </div>
      </div>
    );
  };

  // ─── Live event ticker ──────────────────────────
  const baseEvents = [
    ['22:14', 'debugger-42 SPAWNED', 'archives→resources', 'var(--amber)'],
    ['22:11', 'coder ROUTED', 'areas→projects', 'var(--neon)'],
    ['22:09', 'planner WOKE', 'archives→areas', 'var(--neon-2)'],
    ['21:58', 'researcher PARKED', 'projects→areas', 'var(--neon-2)'],
    ['21:50', 'alfred BURST', 'areas→projects', 'var(--neon)'],
    ['21:30', 'archivist DREAM CYCLE', 'projects→archives', 'var(--violet)'],
    ['21:22', 'scribe-08 TTL EXPIRED', 'resources→archives', 'var(--violet)'],
  ];

  const totalAgents = AGENTS.length;

  return (
    <div>
      <PageHeader
        title="PARA · Agent Office"
        subtitle="// top-down floor plan · projects · areas · resources · archives"
        right={<>
          <span className="tag blue pixel" style={{ fontSize: 11, letterSpacing: '0.2em' }}>SIMULATING</span>
          <button className="nc-btn"><Icon name="refresh" size={12}/> Reset</button>
          <button className="nc-btn primary"><Icon name="bolt" size={12}/> Wake all</button>
        </>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 12 }}>
        {/* ─── OFFICE FLOORPLAN ─── */}
        <div className="nc-panel glow" style={{ padding: 16, position: 'relative', overflow: 'auto', background: '#0a0a14' }}>
          <div className="scan-line"/>
          {/* Building frame label */}
          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--line-soft)' }}>
            <div>
              <div className="pixel" style={{ fontSize: 14, color: 'var(--neon)', letterSpacing: '0.2em', textShadow: '0 0 8px var(--neon)' }}>NEUROCLAW HQ · FLOOR 01</div>
              <div className="mono muted" style={{ fontSize: 9, marginTop: 2 }}>{totalAgents} agents · 4 wings · live simulation</div>
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--neon-2)' }}>
              T+{String(tick).padStart(5, '0')} <span className="blink">▌</span>
            </div>
          </div>

          {/* Floor plan: top row PROJECTS + AREAS, bottom row RESOURCES + ARCHIVES */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <ProjectsWing/>
              <AreasWing/>
            </div>
            <Hallway w={932} h={26}>
              <div className="mono" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 8, color: 'var(--muted)', letterSpacing: '0.18em' }}>
                ── HALLWAY · MIGRATION ROUTE ──
              </div>
            </Hallway>
            <div style={{ display: 'flex', gap: 12 }}>
              <ResourcesWing/>
              <ArchivesWing/>
            </div>
          </div>

          {/* legend */}
          <div className="mono" style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--line-soft)', display: 'flex', gap: 18, fontSize: 9, color: 'var(--text-soft)', letterSpacing: '0.1em', flexWrap: 'wrap' }}>
            <span><span style={{ color: 'var(--neon)' }}>▣</span> PROJECTS · busy on tasks</span>
            <span><span style={{ color: 'var(--neon-2)' }}>◈</span> AREAS · live + standby</span>
            <span><span style={{ color: 'var(--amber)' }}>◇</span> RESOURCES · temp/queue</span>
            <span><span style={{ color: 'var(--violet)' }}>▢</span> ARCHIVES · sleeping</span>
            <span style={{ marginLeft: 'auto' }} className="muted">click an agent →</span>
          </div>
        </div>

        {/* ─── RIGHT PANEL: stats + detail + event log ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Section title="HEADCOUNT">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { l: 'PROJECTS', v: projectsAgents.length, c: 'var(--neon)', g: '▣' },
                { l: 'AREAS', v: areasAgents.length, c: 'var(--neon-2)', g: '◈' },
                { l: 'RESOURCES', v: resAgents.length, c: 'var(--amber)', g: '◇' },
                { l: 'ARCHIVES', v: archAgents.length, c: 'var(--violet)', g: '▢' },
              ].map((s, i) => (
                <div key={i} style={{ padding: 10, border: `1px solid ${s.c}55`, background: `linear-gradient(180deg, ${s.c}18, transparent)` }}>
                  <div className="pixel" style={{ fontSize: 10, color: s.c, letterSpacing: '0.2em' }}>{s.g} {s.l}</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: '#fff', textShadow: `0 0 8px ${s.c}` }}>{String(s.v).padStart(2, '0')}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="AGENT INSPECTOR">
            <Detail/>
          </Section>

          <Section title="AREAS · MANAGE">
            <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 8 }}>
              // assign standby agents to sub-areas
            </div>
            {areasResolved.map(area => (
              <div key={area.id} style={{ padding: 8, marginBottom: 6, border: '1px solid rgba(0,245,212,0.25)', background: 'rgba(0,245,212,0.04)' }}>
                <div className="mono" style={{ fontSize: 10, color: 'var(--neon-2)', letterSpacing: '0.1em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>◈ {area.name}</span>
                  <span style={{ color: 'var(--muted)' }}>{area.agents.length}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 6 }}>
                  {areasAgents.map(a => {
                    const inHere = area.agents.some(ag => ag.id === a.id);
                    return (
                      <button
                        key={a.id}
                        onClick={() => assignAgent(a.id, area.id)}
                        className="mono"
                        style={{
                          fontSize: 8, padding: '2px 5px', letterSpacing: '0.08em',
                          background: inHere ? 'var(--neon-2)' : 'transparent',
                          color: inHere ? '#000' : 'var(--text-soft)',
                          border: `1px solid ${inHere ? 'var(--neon-2)' : 'rgba(255,255,255,0.15)'}`,
                          cursor: 'pointer',
                        }}
                      >{a.name}</button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button onClick={addArea} className="nc-btn primary" style={{ width: '100%', marginTop: 4 }}>
              <Icon name="plus" size={11}/> New area
            </button>
          </Section>

          <Section title="EVENT LOG">
            <div className="mono" style={{ fontSize: 10, lineHeight: 1.7, maxHeight: 200, overflow: 'auto' }}>
              {baseEvents.map((e, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '38px 1fr', gap: 6, padding: '3px 0', borderBottom: '1px dashed rgba(255,255,255,0.05)' }}>
                  <span className="muted">{e[0]}</span>
                  <div>
                    <div style={{ color: '#fff' }}>{e[1]}</div>
                    <div style={{ color: e[3], fontSize: 9 }}>↳ {e[2]}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};

window.Para = Para;
