/* 2-Bit Agent Visualization · PARA zones */

const Para = () => {
  const { AGENTS } = window.NC_DATA;
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => { const i = setInterval(() => setTick(t => t+1), 800); return () => clearInterval(i); }, []);

  // Map agents to PARA zones based on state
  // PROJECTS = working (busy/active task), AREAS = live/standby, RESOURCES = queueing, ARCHIVES = sleeping/idle/expired
  const zones = [
    { id: 'projects',  label: 'PROJECTS',  hint: 'WORKING', color: 'var(--neon)',     glyph: '▣', filter: a => a.status === 'busy' || (a.tasks > 3 && a.status === 'live') },
    { id: 'areas',     label: 'AREAS',     hint: 'STANDBY', color: 'var(--neon-2)',   glyph: '◈', filter: a => a.status === 'live' && a.tasks <= 3 },
    { id: 'resources', label: 'RESOURCES', hint: 'QUEUEING',color: 'var(--amber)',    glyph: '◇', filter: a => a.temp },
    { id: 'archives',  label: 'ARCHIVES',  hint: 'SLEEPING',color: 'var(--violet)',   glyph: '▢', filter: a => a.status === 'idle' },
  ];

  const placed = AGENTS.map(a => {
    const zone = zones.find(z => z.filter(a)) || zones[1];
    return { agent: a, zone: zone.id };
  });

  // Avatar pixel art (8x8) - 2-bit (4 grays/colors)
  const PIXEL_AVATARS = {
    alfred:    ['..XXXX..','.XOOOOX.','XOXOOXOX','XOOOOOOX','XOOXXOOX','XOXXXXOX','.XOOOOX.','..XXXX..'],
    coder:     ['XXXXXXXX','X......X','X.O..O.X','X......X','X.XXXX.X','X.O..O.X','X......X','XXXXXXXX'],
    researcher:['..XXXX..','.X....X.','X..OO..X','X..OO..X','X......X','.X.XX.X.','..X..X..','...XX...'],
    planner:   ['XXXXXXXX','XOXOXOXO','XXOXOXOX','XOXOXOXO','XXOXOXOX','XOXOXOXO','XXOXOXOX','XXXXXXXX'],
    archivist: ['.XXXXXX.','XOOOOOOX','XOXXXXOX','XOOXXOOX','XOXXXXOX','XOOXXOOX','XOXXXXOX','.XXXXXX.'],
    'debugger-42':['..X..X..','.XOOOOX.','X.XOOX.X','XOOOOOOX','X.XOOX.X','.XOOOOX.','..X..X..','...XX...'],
    'scribe-08':['XX....XX','X.O..O.X','..OOOO..','.OOXXOO.','.OOXXOO.','..OOOO..','X.O..O.X','XX....XX'],
  };

  const renderAvatar = (id, accent, big = false) => {
    const grid = PIXEL_AVATARS[id] || PIXEL_AVATARS.coder;
    const px = big ? 6 : 3;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(8, ${px}px)`, gap: 1, padding: 2, background: 'rgba(0,8,20,0.6)', border: `1px solid ${accent}`, boxShadow: `0 0 8px ${accent}` }}>
        {grid.flatMap((row, r) => row.split('').map((c, i) => (
          <span key={`${r}-${i}`} style={{
            width: px, height: px,
            background: c === 'X' ? accent : c === 'O' ? '#0b1a2e' : 'transparent',
            boxShadow: c === 'X' ? `0 0 1px ${accent}` : 'none'
          }}/>
        )))}
      </div>
    );
  };

  const ZoneCard = ({ zone, agents }) => {
    const positions = agents.map((p, i) => {
      const seed = (p.agent.id.charCodeAt(0) + i*7 + tick) % 100;
      const x = 12 + ((seed * 13) % 70);
      const y = 14 + (((seed * 7) + i*23) % 60);
      const wob = Math.sin((tick + i)*0.5)*3;
      return { p, x, y: y + wob };
    });
    return (
      <div className="nc-panel glow" style={{ padding: 0, position: 'relative', overflow: 'hidden', minHeight: 320, display: 'flex', flexDirection: 'column' }}>
        <div className="scan-line"/>
        {/* Zone header */}
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${zone.color}55`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: `linear-gradient(90deg, ${zone.color}18, transparent)` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pixel" style={{ fontSize: 22, color: zone.color, textShadow: `0 0 8px ${zone.color}`, lineHeight: 1 }}>{zone.glyph}</span>
            <div>
              <div className="mono" style={{ fontSize: 13, color: '#fff', letterSpacing: '0.16em', fontWeight: 700 }}>{zone.label}</div>
              <div className="pixel" style={{ fontSize: 13, color: zone.color, letterSpacing: '0.2em' }}>// {zone.hint}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: zone.color, textShadow: `0 0 8px ${zone.color}`, lineHeight: 1 }}>{String(agents.length).padStart(2, '0')}</div>
            <div className="label-tiny" style={{ fontSize: 8 }}>UNITS</div>
          </div>
        </div>

        {/* Zone arena */}
        <div style={{ flex: 1, position: 'relative', background: `radial-gradient(ellipse at 50% 50%, ${zone.color}10, transparent 70%)`, minHeight: 240 }}>
          {/* Pixel-art ground grid */}
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${zone.color}22 1px, transparent 1px), linear-gradient(90deg, ${zone.color}22 1px, transparent 1px)`, backgroundSize: '16px 16px', opacity: 0.5 }}/>
          {/* Pixel border tickmarks */}
          <div style={{ position: 'absolute', inset: 8, border: `1px dashed ${zone.color}55`, pointerEvents: 'none' }}>
            {['◤','◥','◣','◢'].map((g, i) => {
              const s = { position: 'absolute', color: zone.color, fontFamily: 'var(--mono)', fontSize: 10, textShadow: `0 0 4px ${zone.color}` };
              if (i === 0) Object.assign(s, { top: -7, left: -7 });
              if (i === 1) Object.assign(s, { top: -7, right: -7 });
              if (i === 2) Object.assign(s, { bottom: -7, left: -7 });
              if (i === 3) Object.assign(s, { bottom: -7, right: -7 });
              return <span key={i} style={s}>{g}</span>;
            })}
          </div>

          {/* Agents */}
          {positions.map(({ p, x, y }, i) => {
            const a = p.agent;
            const accent = a.temp ? 'var(--violet)' : zone.color;
            const action = zone.id === 'projects' ? 'EXEC' : zone.id === 'areas' ? 'IDLE' : zone.id === 'resources' ? 'QUEUE' : 'SLEEP';
            const isWorking = zone.id === 'projects';
            const isSleeping = zone.id === 'archives';
            return (
              <div key={a.id} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)', textAlign: 'center', transition: 'left 0.7s ease, top 0.7s ease' }}>
                {/* Status bubble above */}
                <div className="pixel" style={{ fontSize: 10, color: accent, marginBottom: 2, letterSpacing: '0.16em', textShadow: `0 0 4px ${accent}`, opacity: isWorking ? (tick % 2 ? 1 : 0.4) : 0.85 }}>
                  {isSleeping ? 'Zzz' : isWorking ? `[${action}]` : action}
                </div>
                {renderAvatar(a.id, accent)}
                <div className="mono" style={{ fontSize: 9, color: 'var(--text-soft)', marginTop: 4, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
                  {a.name.toUpperCase()}
                </div>
                {/* Activity bar */}
                <div style={{ width: 26, height: 2, margin: '3px auto 0', background: 'rgba(255,255,255,0.08)' }}>
                  <div style={{ height: '100%', width: `${isWorking ? 60 + ((tick*9)%40) : isSleeping ? 6 : 30}%`, background: accent, boxShadow: `0 0 4px ${accent}`, transition: 'width 0.6s' }}/>
                </div>
              </div>
            );
          })}

          {agents.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="pixel" style={{ fontSize: 14, color: 'var(--muted)', letterSpacing: '0.2em' }}>// EMPTY ZONE</span>
            </div>
          )}
        </div>

        {/* Footer stat strip */}
        <div className="mono" style={{ padding: '8px 14px', borderTop: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--muted)', letterSpacing: '0.12em' }}>
          <span>LOAD <span style={{ color: zone.color }}>{Math.min(99, agents.length*22 + (tick%5))}%</span></span>
          <span>HEAT <span style={{ color: zone.color }}>{zone.id === 'projects' ? 'HIGH' : zone.id === 'areas' ? 'WARM' : zone.id === 'resources' ? 'AMB' : 'COLD'}</span></span>
          <span>TICK <span className="blink" style={{ color: zone.color }}>{String(tick).padStart(4, '0')}</span></span>
        </div>
      </div>
    );
  };

  const stateRow = ['busy','live','queueing','idle'].map((s, i) => ({
    state: s, count: [
      AGENTS.filter(a => a.status === 'busy').length,
      AGENTS.filter(a => a.status === 'live' && !a.temp).length,
      AGENTS.filter(a => a.temp).length,
      AGENTS.filter(a => a.status === 'idle').length,
    ][i],
  }));

  return (
    <div>
      <PageHeader
        title="PARA · 2-Bit Map"
        subtitle="// agent topology by zone · projects · areas · resources · archives"
        right={<>
          <span className="tag blue pixel" style={{ fontSize: 11, letterSpacing: '0.2em' }}>2-BIT MODE</span>
          <button className="nc-btn"><Icon name="refresh" size={12}/> Sync</button>
          <button className="nc-btn primary"><Icon name="bolt" size={12}/> Wake all</button>
        </>}
      />

      {/* Legend / state strip */}
      <div className="nc-panel glow" style={{ padding: 12, marginBottom: 12, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { lbl: 'PROJECTS · WORKING', c: 'var(--neon)',    g: '▣', d: 'busy on a task' },
          { lbl: 'AREAS · STANDBY',    c: 'var(--neon-2)',  g: '◈', d: 'live · awaiting input' },
          { lbl: 'RESOURCES · QUEUE',  c: 'var(--amber)',   g: '◇', d: 'temp · spawned · ttl' },
          { lbl: 'ARCHIVES · SLEEP',   c: 'var(--violet)',  g: '▢', d: 'idle · cold · paged out' },
        ].map((z, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="pixel" style={{ fontSize: 22, color: z.c, textShadow: `0 0 8px ${z.c}` }}>{z.g}</span>
            <div>
              <div className="mono" style={{ fontSize: 11, color: '#fff', letterSpacing: '0.12em' }}>{z.lbl}</div>
              <div className="mono muted" style={{ fontSize: 10 }}>{z.d}</div>
            </div>
          </div>
        ))}
      </div>

      {/* The 4 PARA zones */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 12 }}>
        {zones.map(z => (
          <ZoneCard key={z.id} zone={z} agents={placed.filter(p => p.zone === z.id).map(p => p)}/>
        ))}
      </div>

      {/* Migration log + transitions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
        <Section title="ZONE MIGRATIONS · LAST 24H">
          <div className="mono" style={{ fontSize: 11, lineHeight: 1.8 }}>
            {[
              ['22:14:05', 'debugger-42', 'archives', 'resources', 'spawn'],
              ['22:11:30', 'coder',       'areas',    'projects',  'task assign'],
              ['22:09:11', 'planner',     'archives', 'areas',     'wake'],
              ['21:58:02', 'researcher',  'projects', 'areas',     'task done'],
              ['21:50:11', 'alfred',      'areas',    'projects',  'route burst'],
              ['21:30:00', 'archivist',   'projects', 'archives',  'idle timeout'],
            ].map((r, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 110px 1fr 100px', gap: 10, padding: '6px 0', borderBottom: '1px dashed rgba(0,183,255,0.06)', alignItems: 'center' }}>
                <span className="muted">{r[0]}</span>
                <span className="neonc">@{r[1]}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="pixel" style={{ color: 'var(--violet)', fontSize: 13 }}>{r[2]}</span>
                  <Icon name="arrow-right" size={12} className="muted"/>
                  <span className="pixel" style={{ color: 'var(--neon)', fontSize: 13 }}>{r[3]}</span>
                </span>
                <span className="tag muted" style={{ fontSize: 9, justifySelf: 'end' }}>{r[4]}</span>
              </div>
            ))}
          </div>
        </Section>
        <Section title="STATE COUNTERS">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {[
              { l: 'WORKING',  v: stateRow[0].count, c: 'var(--neon)' },
              { l: 'STANDBY',  v: stateRow[1].count, c: 'var(--neon-2)' },
              { l: 'QUEUE',    v: stateRow[2].count, c: 'var(--amber)' },
              { l: 'SLEEPING', v: stateRow[3].count, c: 'var(--violet)' },
            ].map((s, i) => (
              <div key={i} style={{ padding: 14, border: `1px solid ${s.c}55`, borderRadius: 2, background: `linear-gradient(180deg, ${s.c}18, transparent)`, position: 'relative' }}>
                <div className="pixel" style={{ fontSize: 13, color: s.c, letterSpacing: '0.2em' }}>{s.l}</div>
                <div className="mono" style={{ fontSize: 32, fontWeight: 700, color: '#fff', textShadow: `0 0 10px ${s.c}` }}>{String(s.v).padStart(2, '0')}</div>
                <div style={{ height: 4, marginTop: 6, background: 'rgba(255,255,255,0.05)' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, s.v*20)}%`, background: s.c, boxShadow: `0 0 6px ${s.c}` }}/>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
};

window.Para = Para;
