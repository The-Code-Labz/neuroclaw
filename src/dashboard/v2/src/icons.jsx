/* Inline SVG icon set - terminal/cybernetic feel */
const Icon = ({ name, size = 16, className = '', style = {} }) => {
  const s = { width: size, height: size, ...style };
  const p = {
    className: 'ico ' + className, style: s,
    viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg',
  };
  switch(name) {
    case 'overview': return <svg {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>;
    case 'chat': return <svg {...p}><path d="M21 12a8 8 0 1 1-3.6-6.7L21 4l-1 4.2A8 8 0 0 1 21 12Z"/><path d="M8 11h8M8 15h5"/></svg>;
    case 'agents': return <svg {...p}><circle cx="12" cy="8" r="3.2"/><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/><path d="M3 4l2 2M21 4l-2 2"/></svg>;
    case 'para': return <svg {...p}><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/><circle cx="7" cy="7" r="1.4" fill="currentColor"/><circle cx="17" cy="7" r="1.4" fill="currentColor"/><circle cx="7" cy="17" r="1.4" fill="currentColor"/><circle cx="17" cy="17" r="1.4" fill="currentColor"/></svg>;
    case 'tasks': return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 9h3M7 13h6M7 17h4"/><path d="M14 9l1.5 1.5L18 8"/></svg>;
    case 'sessions': return <svg {...p}><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/></svg>;
    case 'memory': return <svg {...p}><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V4a3 3 0 0 0-3 0Z"/><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0"/></svg>;
    case 'vault': return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="14" cy="12" r="3"/><path d="M14 9v1M14 14v1M11 12h1M16 12h1"/><path d="M5 7h3M5 17h3"/></svg>;
    case 'dream': return <svg {...p}><path d="M21 13a8.5 8.5 0 0 1-10-10 8 8 0 1 0 10 10Z"/><path d="M16 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z" fill="currentColor" opacity=".4"/></svg>;
    case 'hive': return <svg {...p}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M12 3v18M4 7.5l16 9M20 7.5l-16 9"/></svg>;
    case 'comms': return <svg {...p}><path d="M4 4h7l2 3h7v13H4z"/><path d="M8 13h8M8 16h5"/></svg>;
    case 'mcp': return <svg {...p}><rect x="3" y="6" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><circle cx="7" cy="9" r="0.6" fill="currentColor"/><circle cx="7" cy="17" r="0.6" fill="currentColor"/></svg>;
    case 'skills': return <svg {...p}><path d="M12 3l2.6 5.3 5.9.8-4.3 4.2 1 5.9L12 16.5 6.8 19.2l1-5.9-4.3-4.2 5.9-.8L12 3Z"/><path d="M9 13l2 2 4-4" /></svg>;
    case 'providers': return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>;
    case 'analytics': return <svg {...p}><path d="M4 19V5M4 19h16"/><path d="M8 15v-4M12 15V8M16 15v-2"/></svg>;
    case 'logs': return <svg {...p}><path d="M4 4h12l4 4v12H4z"/><path d="M16 4v4h4"/><path d="M7 12h10M7 15h10M7 18h6"/></svg>;
    case 'settings': return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.3-1.3L13.7 3h-3.4l-.6 2.4A7 7 0 0 0 7.4 6.7L5.1 5.8l-2 3.4 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.3l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.3 1.3l.6 2.4h3.4l.6-2.4a7 7 0 0 0 2.3-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z"/></svg>;
    case 'discord': return <svg {...p}><path d="M5 7c2-1 4-1.5 7-1.5S17 6 19 7l1 11c-2 1-4 1.5-5 1.5l-1-2c-1 .5-2 .5-2 .5s-1 0-2-.5l-1 2c-1 0-3-.5-5-1.5L5 7Z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>;
    case 'voice': return <svg {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>;
    case 'send': return <svg {...p}><path d="M3 12L21 4l-4 17-5-7-9-2Z"/></svg>;
    case 'plus': return <svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
    case 'arrow-left': return <svg {...p}><path d="M19 12H5M12 19l-7-7 7-7"/></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>;
    case 'bolt': return <svg {...p}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z"/></svg>;
    case 'shield': return <svg {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z"/></svg>;
    case 'play': return <svg {...p}><path d="M6 4l14 8-14 8V4Z"/></svg>;
    case 'pause': return <svg {...p}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>;
    case 'refresh': return <svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>;
    case 'cmd': return <svg {...p}><path d="M9 9h6v6H9z"/><path d="M9 9V7a2 2 0 0 0-2-2 2 2 0 0 0-2 2 2 2 0 0 0 2 2h2ZM9 15v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2h2ZM15 9V7a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2ZM15 15v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2 2 2 0 0 0-2-2h-2Z"/></svg>;
    case 'eye': return <svg {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>;
    case 'eyeoff': return <svg {...p}><path d="M3 3l18 18"/><path d="M10.7 6.2a10 10 0 0 1 1.3-.2c6 0 10 6 10 6a17 17 0 0 1-3 3.5"/><path d="M6.3 6.3A17 17 0 0 0 2 12s4 6 10 6c1.5 0 2.9-.4 4.1-1"/></svg>;
    case 'crown': return <svg {...p}><path d="M3 7l4 4 5-7 5 7 4-4-2 12H5L3 7Z"/></svg>;
    case 'star': return <svg {...p}><path d="M12 3l2.5 6 6.5.5-5 4.5 1.5 6.5L12 17l-5.5 3.5L8 14 3 9.5 9.5 9 12 3Z"/></svg>;
    case 'chevron': return <svg {...p}><path d="M9 6l6 6-6 6"/></svg>;
    case 'caret-down': return <svg {...p}><path d="M6 9l6 6 6-6"/></svg>;
    case 'close': return <svg {...p}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case 'menu': return <svg {...p}><path d="M3 6h18M3 12h18M3 18h18"/></svg>;
    case 'terminal': return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M6 9l3 3-3 3M12 15h6"/></svg>;
    case 'logo': return (
      <svg {...p} viewBox="0 0 32 32">
        <defs>
          <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#00b7ff"/>
            <stop offset="1" stopColor="#00f5d4"/>
          </linearGradient>
        </defs>
        <path d="M4 6 L16 2 L28 6 L28 18 C28 24 22 28 16 30 C10 28 4 24 4 18 Z" fill="none" stroke="url(#lg1)" strokeWidth="1.4"/>
        <path d="M10 12 L16 8 L22 12 L22 18 L16 22 L10 18 Z" fill="none" stroke="#00b7ff" strokeWidth="1.2"/>
        <circle cx="16" cy="15" r="1.6" fill="#00f5d4"/>
        <path d="M11 15h-3M24 15h-3M16 8V5M16 22v3" stroke="#00b7ff" strokeWidth="1.2"/>
      </svg>
    );
    case 'circle-dot': return <svg {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>;
    case 'arrow-right': return <svg {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>;
    case 'pin': return <svg {...p}><path d="M12 2l3 5 5 1-4 4 1 6-5-3-5 3 1-6-4-4 5-1 3-5Z"/></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9"/></svg>;
  }
};

window.Icon = Icon;
