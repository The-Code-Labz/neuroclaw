/* NeuroLab · Unified Office Floor
   Replaces page-para.jsx. Agents are autonomous chibi sprites living in
   role-seeded rooms. Hive events drive travel; idle behaviors fill the gaps. */

// ─── Floor geometry (logical units) ────────────────────────────────────────
const FLOOR_W = 1100;
const FLOOR_H = 490;
const CORR_Y  = 195;   // top of horizontal corridor
const CORR_H  = 55;    // corridor height
const CORR_MID = CORR_Y + CORR_H / 2; // y-center of corridor

// Default rooms. x/y/w/h in logical floor units.
const DEFAULT_ROOMS = [
  { id: 'research',    name: 'Research',    glyph: '◈', color: '#00f5d4', x: 5,   y: 5,   w: 330, h: 185, roles: ['knowledge','researcher'] },
  { id: 'command',     name: 'Command',     glyph: '★', color: '#f5d76e', x: 370, y: 5,   w: 360, h: 245, roles: ['orchestrator'] },
  { id: 'engineering', name: 'Engineering', glyph: '▣', color: '#69f0ae', x: 765, y: 5,   w: 330, h: 185, roles: ['engineering','coder','developer'] },
  { id: 'strategy',    name: 'Strategy',    glyph: '✦', color: '#b388ff', x: 5,   y: 285, w: 330, h: 200, roles: ['strategy','planner','assistant'] },
  { id: 'memory',      name: 'Memory',      glyph: '⊞', color: '#ff9fdb', x: 765, y: 285, w: 330, h: 200, roles: ['memory','archivist','vault'] },
];

// Sprite color palettes keyed by agent id (fallback if no match)
const PAL = {
  alfred:        { head: '#f5d76e', body: '#1a3357', hair: '#3a2a1a' },
  researcher:    { head: '#e8c5ff', body: '#3a1a4a', hair: '#2a1a3a' },
  coder:         { head: '#aee6ff', body: '#0d2b4a', hair: '#1a1a2a' },
  planner:       { head: '#ffd4a8', body: '#4a2a0a', hair: '#3a1f0a' },
  archivist:     { head: '#b8ffdb', body: '#0a3a1a', hair: '#1a2a1a' },
};
const palFor = id => PAL[id] || { head: '#c0ccd8', body: '#1a2a3a', hair: '#222' };

// Agent keyword → room id mapping for auto-seeding
const ROLE_ROOM_MAP = [
  { keywords: ['orchestrator'],           roomId: 'command'     },
  { keywords: ['knowledge','research'],   roomId: 'research'    },
  { keywords: ['code','coder','engineer','bash'], roomId: 'engineering' },
  { keywords: ['plan','strategy','schedule'],    roomId: 'strategy'    },
  { keywords: ['memory','archive','vault'],       roomId: 'memory'      },
];

function seedAgentRoom(agent) {
  const haystack = [agent.role, agent.name, ...(agent.caps ?? agent.capabilities ?? [])].join(' ').toLowerCase();
  for (const { keywords, roomId } of ROLE_ROOM_MAP) {
    if (keywords.some(k => haystack.includes(k))) return roomId;
  }
  return 'command'; // fallback: unassigned agents float in command
}

// ─── Utility: room door position (where agents exit to corridor) ────────────
function roomDoor(room) {
  if (room.y < CORR_Y) {
    return { x: room.x + room.w / 2, y: room.y + room.h }; // bottom door
  }
  return { x: room.x + room.w / 2, y: room.y }; // top door
}

// Walk path as array of {x,y} waypoints through corridor
function walkPath(fromRoom, toRoom) {
  if (fromRoom.id === toRoom.id) return [];
  const a = roomDoor(fromRoom);
  const b = roomDoor(toRoom);
  return [
    a,
    { x: a.x, y: CORR_MID },
    { x: b.x, y: CORR_MID },
    b,
    { x: toRoom.x + toRoom.w / 2, y: toRoom.y + toRoom.h / 2 + 20 },
  ];
}

// ─── ChibiSprite ─────────────────────────────────────────────────────────────
const ChibiSprite = ({ agentId, state = 'idle', frame = 0, ghost = false }) => {
  const c = palFor(agentId);
  const px = 3;
  let rows;
  if (state === 'sleeping') {
    rows = ['....HHHH....','...HFFFFH...','...HF..FH...','...HFFFFH...','..BBBBBBBB..','..BAAAAAAB..','..BBBBBBBB..','............'];
  } else if (state === 'working') {
    const bob = frame % 2;
    rows = ['....HHHH....','...HHHHHH...','...HFFFFH...','...HFEEFH...','...HFFFFH...','...HHHHHH...', bob ? '.BB.BBBB.BB.' : '.BBBBBBBBBB.','............'];
  } else {
    const sway = frame % 2;
    rows = ['....HHHH....','...HHHHHH...','...HFFFFH...','...HFEEFH...','...HFFFFH...','..BBBBBBBB..', '.BBBBBBBBBB.','.BBBBBBBBBB.','..AA....AA..',sway ? '.AAA....AAA.' : 'AAA......AAA'];
  }
  const cells = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const bg = ch === 'H' ? c.hair : ch === 'F' ? '#ffd6a5' : ch === 'E' ? '#0a0a14' : ch === 'B' ? c.body : ch === 'A' ? c.hair : '#888';
      cells.push(<div key={`${x}-${y}`} style={{ position: 'absolute', left: x * px, top: y * px, width: px, height: px, background: bg, opacity: ghost ? 0.35 : 1 }}/>);
    });
  });
  const w = 12 * px, h = rows.length * px;
  return (
    <div style={{ position: 'relative', width: w, height: h, outline: ghost ? `1px dashed ${c.body}` : 'none' }}>
      {cells}
    </div>
  );
};

// ─── AgentDesk ────────────────────────────────────────────────────────────────
const AgentDesk = ({ agent, areaColor, spriteState, frame, ghost = false, bubble, onSelect }) => (
  <div
    onClick={() => !ghost && onSelect && onSelect(agent.id)}
    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, cursor: ghost ? 'default' : 'pointer', position: 'relative' }}
  >
    {bubble && !ghost && (
      <div className="mono" style={{
        position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
        marginBottom: 3, background: areaColor, color: '#0a0a14',
        padding: '2px 5px', fontSize: 7, letterSpacing: '.05em', whiteSpace: 'nowrap',
        boxShadow: '2px 2px 0 rgba(0,0,0,0.5)', zIndex: 10,
      }}>
        {bubble}
        <span style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderTop: `3px solid ${areaColor}` }}/>
      </div>
    )}
    <div className="mono" style={{ fontSize: 6, color: ghost ? 'rgba(255,255,255,0.4)' : '#fff', letterSpacing: '.08em', opacity: ghost ? 0.6 : 0.85, whiteSpace: 'nowrap' }}>
      {ghost ? `${agent.name} ↗` : agent.name.toUpperCase()}
    </div>
    <ChibiSprite agentId={agent.id} state={spriteState} frame={frame} ghost={ghost}/>
    <div style={{ position: 'relative', width: 38, height: 7, background: '#3a2a10', borderTop: `2px solid ${areaColor}88` }}>
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 7, width: 14, height: 10, background: '#111', border: `1px solid ${areaColor}55` }}>
        <div style={{ position: 'absolute', inset: 1, background: spriteState === 'working' ? areaColor : '#1a3344', opacity: 0.85 }}/>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 10 }}>
      <div style={{ width: 6, height: 4, background: '#2a2a2a' }}/>
      <div style={{ width: 6, height: 4, background: '#2a2a2a' }}/>
    </div>
  </div>
);

// ─── RoomDiv ──────────────────────────────────────────────────────────────────
const RoomDiv = ({ room, agents, agentRooms, agentBehavior = {}, tick, selectedId, onSelectAgent }) => {
  const roomAgents = agents.filter(a => agentRooms[a.id] === room.id && !agentBehavior[a.id]?.away);
  const visitingAgents = agents.filter(a => agentBehavior[a.id]?.visitingRoom === room.id);
  const allDisplayed = [...roomAgents, ...visitingAgents.map(a => ({ ...a, _ghost: true }))];
  const floorBg = `color-mix(in oklch, ${room.color} 10%, #07070f)`;

  const deskPositions = (count) => {
    const cols = Math.min(count, Math.max(1, Math.floor((room.w - 60) / 65)));
    const rows = Math.ceil(count / cols);
    return Array.from({ length: count }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const padX = 55, padY = 48;
      const innerW = room.w - padX * 2;
      const innerH = room.h - padY - 20;
      return {
        x: padX + (cols === 1 ? innerW / 2 : (innerW / (cols - 1 || 1)) * col),
        y: padY + (rows === 1 ? innerH / 2 : (innerH / (rows - 1 || 1)) * row),
      };
    });
  };

  const positions = deskPositions(allDisplayed.length);

  const spriteStateFor = (agent) => {
    if (agent._ghost) return 'idle';
    const s = agent.status;
    if (s === 'busy' || s === 'live') return 'working';
    if (s === 'idle') return 'sleeping';
    return 'idle';
  };

  return (
    <div style={{
      position: 'absolute', left: room.x, top: room.y, width: room.w, height: room.h,
      background: floorBg, border: `2px solid ${room.color}`,
      boxShadow: `0 0 0 1px #000, 0 0 16px ${room.color}33`, overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: `linear-gradient(${room.color}0f 1px,transparent 1px),linear-gradient(90deg,${room.color}0f 1px,transparent 1px)`,
        backgroundSize: '28px 28px',
      }}/>
      <div style={{ position: 'absolute', top: 6, left: 8, display: 'flex', alignItems: 'center', gap: 5, zIndex: 2 }}>
        <span className="pixel" style={{ fontSize: 12, color: room.color, textShadow: `0 0 6px ${room.color}` }}>{room.glyph}</span>
        <span className="pixel" style={{ fontSize: 10, color: room.color, letterSpacing: '.15em', textShadow: `0 0 5px ${room.color}` }}>{room.name.toUpperCase()}</span>
      </div>
      <div className="mono" style={{ position: 'absolute', top: 7, right: 8, fontSize: 8, color: room.color, opacity: 0.55 }}>{roomAgents.length} AGENTS</div>
      {allDisplayed.map((agent, i) => (
        <div key={agent.id + (agent._ghost ? '-ghost' : '')} style={{
          position: 'absolute',
          left: positions[i]?.x ?? 80,
          top: positions[i]?.y ?? 80,
          transform: 'translateX(-50%)',
          zIndex: agent._ghost ? 1 : 2,
        }}>
          <AgentDesk
            agent={agent}
            areaColor={room.color}
            spriteState={spriteStateFor(agent)}
            frame={(tick + (agent.id.charCodeAt(0) || 0)) % 4}
            ghost={!!agent._ghost}
            bubble={agentBehavior[agent.id]?.bubbleText || null}
            onSelect={onSelectAgent}
          />
        </div>
      ))}
      {allDisplayed.length === 0 && (
        <div className="mono" style={{ position: 'absolute', left: '50%', top: '60%', transform: 'translate(-50%,-50%)', fontSize: 9, color: 'rgba(255,255,255,0.2)', textAlign: 'center', letterSpacing: '.12em' }}>// empty room</div>
      )}
      {[[0,0],[0,1],[1,0],[1,1]].map(([cx,cy]) => (
        <span key={`${cx}-${cy}`} style={{
          position: 'absolute', [cx===0?'left':'right']: -2, [cy===0?'top':'bottom']: -2,
          width: 5, height: 5, background: room.color, boxShadow: `0 0 4px ${room.color}`, zIndex: 6,
        }}/>
      ))}
    </div>
  );
};

// ─── ParticleBeams ────────────────────────────────────────────────────────────
const ParticleBeams = ({ beams = [], rooms, tick }) => {
  const roomCenter = (id) => {
    const r = rooms.find(x => x.id === id);
    if (!r) return { x: 0, y: 0 };
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  return (
    <svg style={{ position: 'absolute', inset: 0, width: FLOOR_W, height: FLOOR_H, pointerEvents: 'none', zIndex: 15 }}>
      {beams.map(beam => {
        const from = roomCenter(beam.fromRoomId);
        const to   = roomCenter(beam.toRoomId);
        const numParticles = 4;
        const particles = Array.from({ length: numParticles }, (_, i) => {
          const progress = ((tick * 0.07 + i / numParticles) % 1);
          return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, r: i % 2 === 0 ? 3 : 2 };
        });
        return (
          <g key={beam.id}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={beam.color} strokeWidth="1" strokeDasharray="5 5" opacity="0.3"/>
            {particles.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={beam.color} opacity={0.85}/>
            ))}
          </g>
        );
      })}
    </svg>
  );
};

// ─── FloorCanvas ──────────────────────────────────────────────────────────────
const FloorCanvas = ({ rooms, agents, agentRooms, agentBehavior = {}, beams = [], hiveActivity = {}, tick, selectedId, onSelectAgent }) => (
  <div className="nc-panel glow" style={{ padding: 0, background: '#060610', overflow: 'hidden', position: 'relative' }}>
    <div className="scan-line"/>
    <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div className="pixel" style={{ fontSize: 12, color: 'var(--accent)', letterSpacing: '.2em', textShadow: '0 0 8px var(--accent)' }}>NEUROCLAW HQ · LAB FLOOR</div>
      <div className="mono muted" style={{ fontSize: 9 }}>T+{String(tick).padStart(5,'0')} <span className="blink">▌</span></div>
    </div>
    <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ position: 'relative', width: FLOOR_W, height: FLOOR_H, background: '#07070f', flexShrink: 0 }}>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'linear-gradient(rgba(0,183,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,183,255,0.03) 1px,transparent 1px)', backgroundSize: '40px 40px' }}/>
        <div style={{ position: 'absolute', left: 0, right: 0, top: CORR_Y, height: CORR_H, background: 'rgba(0,183,255,0.025)', borderTop: '1px dashed rgba(0,183,255,0.15)', borderBottom: '1px dashed rgba(0,183,255,0.15)', display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
          <span className="mono" style={{ fontSize: 7, color: 'rgba(0,183,255,0.2)', letterSpacing: '.15em' }}>// MAIN CORRIDOR</span>
        </div>
        {rooms.map(room => (
          <RoomDiv key={room.id} room={room} agents={agents} agentRooms={agentRooms} agentBehavior={agentBehavior} tick={tick} selectedId={selectedId} onSelectAgent={onSelectAgent}/>
        ))}
        {/* Walking sprites rendered on floor during corridor transit */}
        {agents.map(agent => {
          const b = agentBehavior[agent.id];
          if (!b?.away || !b.pos) return null;
          const homeRoom = rooms.find(r => r.id === b.homeRoomId);
          const color = homeRoom?.color || '#00f5d4';
          return (
            <div key={`walk-${agent.id}`} style={{ position: 'absolute', left: b.pos.x - 18, top: b.pos.y - 28, zIndex: 20, transition: 'left 0.14s linear, top 0.14s linear', pointerEvents: 'none' }}>
              <div className="mono" style={{ fontSize: 6, color, textAlign: 'center', marginBottom: 1, letterSpacing: '.06em', whiteSpace: 'nowrap' }}>{agent.name.toUpperCase()}</div>
              <ChibiSprite agentId={agent.id} state="idle" frame={(tick + agent.id.charCodeAt(0)) % 2}/>
            </div>
          );
        })}
        <ParticleBeams beams={beams} rooms={rooms} tick={tick}/>
      </div>
    </div>
    <HiveBar rooms={rooms} agents={agents} agentRooms={agentRooms} hiveActivity={hiveActivity}/>
  </div>
);

// ─── HiveBar ──────────────────────────────────────────────────────────────────
const HiveBar = ({ rooms, agents, agentRooms, hiveActivity = {} }) => (
  <div style={{ height: 22, background: '#0a0a14', borderTop: '1px solid rgba(0,183,255,0.12)', display: 'flex', alignItems: 'center', paddingLeft: 10, gap: 10 }}>
    <span className="mono" style={{ fontSize: 7, color: 'rgba(0,183,255,0.4)', letterSpacing: '.12em', whiteSpace: 'nowrap' }}>⬡ HIVE</span>
    <div style={{ flex: 1, height: 8, background: 'rgba(0,183,255,0.05)', display: 'flex', overflow: 'hidden', gap: 1 }}>
      {rooms.map((r, i) => {
        const activity = hiveActivity[r.id] || 0;
        const agentCount = agents.filter(a => agentRooms[a.id] === r.id).length;
        const baseWidth = (agentCount + 1) / (agents.length + rooms.length);
        return (
          <div key={r.id} title={r.name} style={{
            flex: baseWidth, height: '100%',
            background: r.color,
            opacity: 0.2 + activity * 0.7,
            transition: 'opacity 0.4s ease',
            boxShadow: activity > 0.5 ? `0 0 6px ${r.color}` : 'none',
          }}/>
        );
      })}
    </div>
    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00f5d4', opacity: 0.85 }}/>
    <span className="mono" style={{ fontSize: 7, color: 'rgba(0,183,255,0.35)', marginRight: 8 }}>LIVE</span>
  </div>
);

// ─── RightPanel ───────────────────────────────────────────────────────────────
const COLOR_OPTIONS = ['#00f5d4','#00b7ff','#8b5cf6','#ffb86b','#ff5f7e','#69f0ae','#f5d76e','#b388ff','#ff9fdb'];
const GLYPH_OPTIONS = ['◈','$','+','▣','✦','◇','♥','➤','★','⊞','⬡'];

const RightPanel = ({ rooms, agents, agentRooms, selectedId, agentBehavior = {}, onUpdateRoom, onRemoveRoom, onAssignAgent, onAddRoom }) => {
  const selectedAgent = selectedId ? agents.find(a => a.id === selectedId) : null;
  const beh = selectedId ? agentBehavior[selectedId] : null;
  const homeRoom = selectedAgent ? rooms.find(r => r.id === agentRooms[selectedAgent.id]) : null;
  const visitRoom = beh?.visitingRoom ? rooms.find(r => r.id === beh.visitingRoom) : null;
  const CORE_ROOM_IDS = ['command','research','engineering','strategy','memory'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 280 }}>
      <Section title="AGENT INSPECTOR">
        {!selectedAgent ? (
          <div className="mono muted" style={{ fontSize: 9, padding: '10px 0' }}>// click an agent to inspect</div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ background: '#0a0a14', padding: 4, border: `1px solid ${homeRoom?.color || '#333'}` }}>
                <ChibiSprite agentId={selectedAgent.id} state="idle" frame={0}/>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 12, color: '#fff', fontWeight: 700 }}>{selectedAgent.name}</div>
                <div className="mono muted" style={{ fontSize: 9 }}>@{selectedAgent.id} · {selectedAgent.role}</div>
              </div>
            </div>
            <div className="mono" style={{ fontSize: 10, lineHeight: 1.8, color: 'var(--text-soft)' }}>
              <div>STATUS · <span style={{ color: '#fff' }}>{selectedAgent.status}</span></div>
              <div>HOME · <span style={{ color: homeRoom?.color || 'var(--muted)' }}>{homeRoom?.name || 'unassigned'}</span></div>
              {visitRoom && <div>VISITING · <span style={{ color: visitRoom.color }}>{visitRoom.name}</span></div>}
              <div>BEHAVIOR · <span style={{ color: 'var(--accent)' }}>{beh?.state || 'desk'}</span></div>
              <div>MODEL · <span style={{ color: '#fff' }}>{selectedAgent.model}</span></div>
            </div>
          </div>
        )}
      </Section>
      <Section title="ROOM MANAGER">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 440, overflowY: 'auto', paddingRight: 2 }}>
          {rooms.map(room => (
            <div key={room.id} style={{ padding: 8, border: `1px solid ${room.color}55`, background: `${room.color}0a` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <select value={room.glyph} onChange={e => onUpdateRoom(room.id, { glyph: e.target.value })} className="mono"
                  style={{ background: '#0a0a14', color: room.color, border: `1px solid ${room.color}55`, fontSize: 13, width: 34, padding: '1px 2px' }}>
                  {GLYPH_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <input value={room.name} onChange={e => onUpdateRoom(room.id, { name: e.target.value })} className="mono"
                  style={{ flex: 1, background: 'transparent', color: '#fff', border: 'none', borderBottom: `1px solid ${room.color}44`, outline: 'none', fontSize: 11 }}/>
                {!CORE_ROOM_IDS.includes(room.id) && (
                  <button onClick={() => { if (confirm(`Delete "${room.name}"?`)) onRemoveRoom(room.id); }}
                    style={{ background: 'transparent', border: 'none', color: room.color, fontSize: 14, cursor: 'pointer' }}>×</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 5 }}>
                {COLOR_OPTIONS.map(col => (
                  <button key={col} onClick={() => onUpdateRoom(room.id, { color: col })}
                    style={{ width: 16, height: 16, background: col, border: room.color === col ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)', cursor: 'pointer', padding: 0 }}/>
                ))}
              </div>
              <div className="mono" style={{ fontSize: 7, color: 'var(--muted)', letterSpacing: '.1em', marginBottom: 3 }}>AGENTS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {agents.map(a => {
                  const here = agentRooms[a.id] === room.id;
                  return (
                    <button key={a.id} onClick={() => onAssignAgent(a.id, room.id)} className="mono"
                      style={{ fontSize: 7, padding: '2px 4px', background: here ? room.color : 'transparent', color: here ? '#000' : 'var(--text-soft)', border: `1px solid ${here ? room.color : 'rgba(255,255,255,0.1)'}`, cursor: 'pointer' }}>
                      {a.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <button className="nc-btn primary" onClick={onAddRoom} style={{ width: '100%', fontSize: 10 }}>
            <Icon name="plus" size={10}/> Add Room
          </button>
        </div>
      </Section>
    </div>
  );
};

// ─── Main NeuroLab component ──────────────────────────────────────────────────
const NeuroLab = () => {
  const { AGENTS = [] } = window.NC_DATA;
  const [rooms, setRooms] = React.useState(() => DEFAULT_ROOMS.map(r => ({ ...r })));
  const [tick, setTick] = React.useState(0);
  const [selectedId, setSelectedId] = React.useState(null);
  const [agentBehavior, setAgentBehavior] = React.useState({});
  const [beams, setBeams] = React.useState([]);
  const [hiveActivity, setHiveActivity] = React.useState({});
  const [agentRooms, setAgentRooms] = React.useState(() => {
    const map = {};
    AGENTS.forEach(a => { map[a.id] = seedAgentRoom(a); });
    return map;
  });

  const behaviorRef = React.useRef({});
  const travelQueue = React.useRef([]);
  const addBeamRef = React.useRef(null);

  const addBeam = React.useCallback((fromRoomId, toRoomId, color) => {
    const id = `${Date.now()}-${Math.random()}`;
    setBeams(bs => [...bs, { id, fromRoomId, toRoomId, color, t: 0 }]);
    setTimeout(() => setBeams(bs => bs.filter(b => b.id !== id)), 2500);
  }, []);
  addBeamRef.current = addBeam;

  const updateRoom = (id, patch) => setRooms(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  const addRoom = () => {
    const id = `room-${Date.now()}`;
    setRooms(rs => [...rs, { id, name: 'New Room', glyph: '◇', color: '#00b7ff', x: 370, y: 285, w: 360, h: 200, roles: [] }]);
  };
  const removeRoom = id => {
    setRooms(rs => rs.filter(r => r.id !== id));
    setAgentRooms(m => {
      const next = { ...m };
      Object.keys(next).forEach(aid => { if (next[aid] === id) next[aid] = 'command'; });
      return next;
    });
  };
  const assignAgent = (agentId, roomId) => setAgentRooms(m => ({ ...m, [agentId]: roomId }));

  // Tick interval (animation + behavior engine)
  React.useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 150);
    return () => clearInterval(id);
  }, []);

  // Initialize behavior state for each agent
  React.useEffect(() => {
    const beh = {};
    AGENTS.forEach(a => {
      beh[a.id] = {
        state: 'desk',
        homeRoomId: agentRooms[a.id] || 'command',
        visitingRoom: null,
        away: false,
        wanderTimer: Math.floor(Math.random() * 60 + 20),
        bubbleText: null,
        bubbleTimer: 0,
        waypointIndex: 0,
        waypoints: [],
        pos: { x: 0, y: 0 },
        visitTimer: 0,
      };
    });
    behaviorRef.current = beh;
  }, [AGENTS.length]);

  // Behavior engine
  React.useEffect(() => {
    const IDLE_BUBBLES   = ['thinking…', 'tea?', 'reading', 'syncing', 'hmm…'];
    const WORK_BUBBLES   = ['compiling…', 'tool: grep', 'streaming', 'route: opus', 'thinking…', 'spawn child'];
    const roomById = id => rooms.find(r => r.id === id);

    const tick = () => {
      const beh = behaviorRef.current;
      let changed = false;

      // Drain travel queue
      while (travelQueue.current.length > 0) {
        const { agentId, targetRoomId } = travelQueue.current.shift();
        const b = beh[agentId];
        if (!b || b.state !== 'desk') continue;
        const homeRoom = roomById(b.homeRoomId);
        const destRoom = roomById(targetRoomId);
        if (!homeRoom || !destRoom || homeRoom.id === destRoom.id) continue;
        b.state = 'walking';
        b.waypoints = walkPath(homeRoom, destRoom);
        b.waypointIndex = 0;
        b.visitingRoom = targetRoomId;
        b.away = true;
        if (addBeamRef.current) addBeamRef.current(b.homeRoomId, targetRoomId, homeRoom.color);
        changed = true;
      }

      const advanceWaypoints = (b, speed = 8) => {
        if (b.waypointIndex >= b.waypoints.length) return true; // arrived
        const target = b.waypoints[b.waypointIndex];
        const dx = target.x - b.pos.x;
        const dy = target.y - b.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= speed) {
          b.pos = { ...target };
          b.waypointIndex++;
        } else {
          b.pos = { x: b.pos.x + (dx / dist) * speed, y: b.pos.y + (dy / dist) * speed };
        }
        return b.waypointIndex >= b.waypoints.length;
      };

      Object.entries(beh).forEach(([agentId, b]) => {
        if (b.state === 'desk') {
          b.wanderTimer--;
          if (b.wanderTimer <= 0) {
            if (Math.random() < 0.30) {
              const wanderRooms = rooms.filter(r => r.id !== b.homeRoomId);
              const dest = wanderRooms[Math.floor(Math.random() * wanderRooms.length)];
              if (dest) {
                const homeRoom = roomById(b.homeRoomId);
                if (homeRoom) {
                  b.state = 'wandering';
                  b.waypoints = walkPath(homeRoom, dest);
                  b.waypointIndex = 0;
                  b.pos = roomDoor(homeRoom);
                  b.visitingRoom = dest.id;
                  b.away = true;
                  if (addBeamRef.current) addBeamRef.current(b.homeRoomId, dest.id, homeRoom.color);
                  changed = true;
                }
              }
            }
            b.wanderTimer = Math.floor(Math.random() * 80 + 40);
          }
          if (Math.random() < 0.04) {
            const agent = AGENTS.find(a => a.id === agentId);
            const isWorking = agent?.status === 'busy' || agent?.status === 'live';
            b.bubbleText = isWorking
              ? WORK_BUBBLES[Math.floor(Math.random() * WORK_BUBBLES.length)]
              : IDLE_BUBBLES[Math.floor(Math.random() * IDLE_BUBBLES.length)];
            b.bubbleTimer = 18;
            changed = true;
          }
        } else if (b.state === 'walking' || b.state === 'wandering') {
          const arrived = advanceWaypoints(b);
          if (arrived) {
            b.away = false;
            b.state = 'visiting';
            b.visitTimer = Math.floor(Math.random() * 47 + 33);
          }
          changed = true;
        } else if (b.state === 'visiting') {
          b.visitTimer--;
          if (b.visitTimer <= 0) {
            const homeRoom = roomById(b.homeRoomId);
            const visitRoom = roomById(b.visitingRoom);
            if (homeRoom && visitRoom) {
              b.state = 'returning';
              b.waypoints = walkPath(visitRoom, homeRoom);
              b.waypointIndex = 0;
              b.pos = roomDoor(visitRoom);
              b.away = true;
              changed = true;
            } else {
              b.state = 'desk'; b.visitingRoom = null; b.away = false;
            }
          }
        } else if (b.state === 'returning') {
          const arrived = advanceWaypoints(b);
          if (arrived) {
            b.state = 'desk'; b.visitingRoom = null; b.away = false;
            b.pos = { x: 0, y: 0 };
            b.wanderTimer = Math.floor(Math.random() * 60 + 40);
          }
          changed = true;
        }

        if (b.bubbleTimer > 0) {
          b.bubbleTimer--;
          if (b.bubbleTimer === 0) { b.bubbleText = null; changed = true; }
        }
      });

      if (changed) setAgentBehavior({ ...beh });
    };

    const id = setInterval(tick, 150);
    return () => clearInterval(id);
  }, [rooms, agentRooms, AGENTS.length]);

  // Hive event polling
  React.useEffect(() => {
    const lastHiveId = { current: null };
    const recentCount = { current: 0 };
    let recentTimer = null;

    const handleEvents = (events) => {
      if (!events?.length) return;
      const newest = events[0];
      if (newest.id === lastHiveId.current) return;
      const newEvents = lastHiveId.current ? events.filter(e => e.id !== lastHiveId.current).slice(0, 5) : events.slice(0, 3);
      lastHiveId.current = newest.id;

      const activity = {};
      newEvents.forEach(ev => {
        const agentId = ev.agent;
        const destMap = { auto_route: 'command', route_fallback: 'command', task_created: 'strategy', task_updated: 'strategy', mcp_agent_call_ok: 'engineering' };
        const destRoomId = destMap[ev.action] || null;
        if (destRoomId) activity[destRoomId] = Math.min(1, (activity[destRoomId] || 0) + 0.35);
        const beh = behaviorRef.current[agentId];
        if (beh && beh.state === 'desk' && destRoomId && destRoomId !== beh.homeRoomId) {
          travelQueue.current.push({ agentId, targetRoomId: destRoomId });
        }
      });
      if (Object.keys(activity).length) {
        setHiveActivity(prev => {
          const next = { ...prev };
          Object.entries(activity).forEach(([k, v]) => { next[k] = Math.min(1, (next[k] || 0) + v); });
          return next;
        });
        setTimeout(() => setHiveActivity(prev => {
          const next = {};
          Object.entries(prev).forEach(([k, v]) => { if (v > 0.05) next[k] = v * 0.7; });
          return next;
        }), 2000);
      }

      recentCount.current += newEvents.length;
      clearTimeout(recentTimer);
      clearTimeout(recentTimer);
      recentTimer = setTimeout(() => { recentCount.current = 0; }, 30000);
      if (recentCount.current >= 3) {
        recentCount.current = 0;
        Object.entries(behaviorRef.current).forEach(([agentId, b]) => {
          if (b.state === 'desk' && b.homeRoomId !== 'command') {
            travelQueue.current.push({ agentId, targetRoomId: 'command' });
          }
        });
      }
    };

    const poll = () => {
      window.NC_API?.get('/api/hive?limit=20').then(data => handleEvents(Array.isArray(data) ? data : [])).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { clearInterval(id); clearTimeout(recentTimer); };
  }, [rooms]);

  return (
    <div>
      <PageHeader
        title="NeuroLab"
        subtitle="// hive mind office · agents live and collaborate here"
        right={<>
          <span className="tag blue pixel" style={{ fontSize: 11 }}>{rooms.length} ROOMS</span>
          <button className="nc-btn primary" onClick={addRoom}><Icon name="plus" size={12}/> Room</button>
        </>}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 290px', gap: 12 }}>
        <FloorCanvas
          rooms={rooms} agents={AGENTS} agentRooms={agentRooms}
          agentBehavior={agentBehavior} beams={beams} hiveActivity={hiveActivity}
          tick={tick} selectedId={selectedId} onSelectAgent={setSelectedId}
        />
        <RightPanel
          rooms={rooms} agents={AGENTS} agentRooms={agentRooms}
          selectedId={selectedId} agentBehavior={agentBehavior}
          onUpdateRoom={updateRoom} onRemoveRoom={removeRoom}
          onAssignAgent={assignAgent} onAddRoom={addRoom}
        />
      </div>
    </div>
  );
};

window.NeuroLab = NeuroLab;
