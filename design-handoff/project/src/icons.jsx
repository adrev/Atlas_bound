// ========== Icon library (inline SVG, stroke-based) ==========
const Icon = ({ name, size = 16, ...rest }) => {
  const s = size;
  const common = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', ...rest };
  switch (name) {
    case 'swords': return <svg {...common}><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/><path d="M9.5 17.5 21 6V3h-3L6.5 14.5"/><path d="M11 19l-6-6"/><path d="M8 16l-4 4"/><path d="M5 21l-2-2"/></svg>;
    case 'book': return <svg {...common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>;
    case 'tome': return <svg {...common}><path d="M12 3v18"/><path d="M4 4h16v16H4z"/><path d="M4 4c2 2 6 2 8 0 2 2 6 2 8 0"/><path d="M4 20c2-2 6-2 8 0 2-2 6-2 8 0"/></svg>;
    case 'scroll': return <svg {...common}><path d="M8 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6"/><path d="M4 6h4"/><path d="M8 4v14a2 2 0 0 0 2 2"/><path d="M12 9h6M12 13h6"/></svg>;
    case 'chat': return <svg {...common}><path d="M21 12c0 4.4-4 8-9 8-1.5 0-2.9-.3-4.1-.9L3 20l1.3-4C3.5 14.8 3 13.4 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"/></svg>;
    case 'users': return <svg {...common}><circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M15 20c0-2.2 1.8-4 4-4s2 0 3 1"/></svg>;
    case 'gear': return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
    case 'map': return <svg {...common}><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>;
    case 'dragon': return <svg {...common}><path d="M4 12c2-4 5-5 8-5s6 1 8 3"/><path d="M12 7c0 3 2 5 5 5"/><path d="M17 12c-1 3-4 5-9 5-2 0-4-1-4-3 0-1 1-2 2-2"/><circle cx="17" cy="8" r=".5" fill="currentColor"/></svg>;
    case 'd20': return <svg {...common}><polygon points="12,2 22,8 22,16 12,22 2,16 2,8"/><polygon points="12,2 22,8 12,12 2,8"/><polygon points="12,12 22,8 22,16 12,22"/><polygon points="12,12 2,8 2,16 12,22"/></svg>;
    case 'd4': return <svg {...common}><polygon points="12,3 21,20 3,20"/><path d="M12 3v17M3 20l18 0"/></svg>;
    case 'd6': return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="16" cy="16" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>;
    case 'd8': return <svg {...common}><polygon points="12,2 22,12 12,22 2,12"/><path d="M2 12h20M12 2v20"/></svg>;
    case 'd10': return <svg {...common}><polygon points="12,2 20,9 16,22 8,22 4,9"/></svg>;
    case 'd12': return <svg {...common}><polygon points="12,2 19,6 22,14 16,21 8,21 2,14 5,6"/></svg>;
    case 'd100': return <svg {...common}><circle cx="12" cy="12" r="9"/><text x="12" y="15" textAnchor="middle" fontFamily="serif" fontSize="7" fill="currentColor" stroke="none">100</text></svg>;
    case 'x': return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case 'send': return <svg {...common}><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>;
    case 'search': return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>;
    case 'chevron-down': return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>;
    case 'chevron-right': return <svg {...common}><path d="m9 6 6 6-6 6"/></svg>;
    case 'chevron-left': return <svg {...common}><path d="m15 6-6 6 6 6"/></svg>;
    case 'moon': return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>;
    case 'sun': return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.7.7M17.7 17.7l.7.7M5.6 18.4l.7-.7M17.7 6.3l.7-.7"/></svg>;
    case 'boots': return <svg {...common}><path d="M8 3v10H4l1 8h14v-5c-3 0-5-1-5-4V3z"/><path d="M4 17h14"/></svg>;
    case 'shield': return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case 'bolt': return <svg {...common}><path d="M13 2 3 14h8l-1 8 10-12h-8z"/></svg>;
    case 'heart': return <svg {...common}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>;
    case 'flame': return <svg {...common}><path d="M12 3c2 4 6 6 6 11a6 6 0 1 1-12 0c0-3 2-4 2-7 2 1 3 2 4 4z"/></svg>;
    case 'hand': return <svg {...common}><path d="M18 11V5a2 2 0 0 0-4 0v6"/><path d="M14 10V3a2 2 0 0 0-4 0v7"/><path d="M10 9V4a2 2 0 0 0-4 0v10"/><path d="M18 8a2 2 0 1 1 4 0v5c0 4-3 8-8 8s-8-4-8-8v-1"/></svg>;
    case 'grapple': return <svg {...common}><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/><path d="m9 9 6 6"/><path d="M4 14l3-3M20 10l-3 3"/></svg>;
    case 'hide': return <svg {...common}><path d="M3 12s3-7 9-7 9 7 9 7-3 7-9 7-9-7-9-7z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>;
    case 'footprints': return <svg {...common}><path d="M4 16c0 2 1 3 2.5 3S9 18 9 16c0-1-.5-2 .5-3.5S11 10 11 8s-1.5-3-3-3-3 1.5-3 3c0 2 .5 2.5-.5 4S4 14 4 16z"/><path d="M15 20c0 1 .5 2 2 2s2-1 2-2c0-1-.5-1.5.5-3s1-2 1-3.5-1-2.5-2.5-2.5S15 12.5 15 14c0 2 .5 2 .5 3.5S15 19 15 20z"/></svg>;
    case 'arrow-in': return <svg {...common}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>;
    case 'arrow-out': return <svg {...common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>;
    case 'note': return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h4"/></svg>;
    case 'masks': return <svg {...common}><path d="M7 3c-2 0-4 2-4 5 0 4 4 8 4 8s4-4 4-8c0-3-2-5-4-5z"/><circle cx="5.8" cy="7.5" r=".6" fill="currentColor"/><circle cx="8.2" cy="7.5" r=".6" fill="currentColor"/><path d="M17 8c-2 0-4 2-4 5 0 4 4 8 4 8s4-4 4-8c0-3-2-5-4-5z"/><circle cx="15.8" cy="12.5" r=".6" fill="currentColor"/><circle cx="18.2" cy="12.5" r=".6" fill="currentColor"/></svg>;
    case 'music': return <svg {...common}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>;
    case 'image': return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>;
    case 'parchment': return <svg {...common}><path d="M6 3c-2 0-3 2-3 4s1 3 3 3H5v11h14V3z"/><path d="M9 8h8M9 12h8M9 16h5"/></svg>;
    case 'play': return <svg {...common}><polygon points="6,3 20,12 6,21"/></svg>;
    case 'pause': return <svg {...common}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>;
    case 'skip-back': return <svg {...common}><polygon points="19,4 9,12 19,20"/><line x1="5" y1="5" x2="5" y2="19"/></svg>;
    case 'skip-forward': return <svg {...common}><polygon points="5,4 15,12 5,20"/><line x1="19" y1="5" x2="19" y2="19"/></svg>;
    case 'stop': return <svg {...common}><rect x="5" y="5" width="14" height="14"/></svg>;
    case 'shuffle': return <svg {...common}><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6M4 4l5 5"/></svg>;
    case 'volume': return <svg {...common}><polygon points="3,10 3,14 7,14 12,19 12,5 7,10"/><path d="M16 8a4 4 0 0 1 0 8M19 5a8 8 0 0 1 0 14"/></svg>;
    case 'wifi': return <svg {...common}><path d="M2 8a15 15 0 0 1 20 0"/><path d="M5 11a11 11 0 0 1 14 0"/><path d="M8 14a7 7 0 0 1 8 0"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>;
    case 'crown': return <svg {...common}><path d="M3 7l3 10h12l3-10-5 4-4-6-4 6-5-4z"/></svg>;
    case 'cup': return <svg {...common}><path d="M4 5h14v6a5 5 0 0 1-10 0h-4z"/><path d="M18 7h2a2 2 0 0 1 0 4h-2"/><path d="M4 19h14"/></svg>;
    case 'tree': return <svg {...common}><path d="M12 3 5 14h4l-3 5h12l-3-5h4z"/><path d="M12 19v3"/></svg>;
    case 'orb': return <svg {...common}><circle cx="12" cy="12" r="8"/><circle cx="10" cy="10" r="2" fill="currentColor" opacity=".4"/></svg>;
    case 'skull': return <svg {...common}><path d="M12 3c-5 0-8 3-8 8 0 3 1 4 3 6v3h10v-3c2-2 3-3 3-6 0-5-3-8-8-8z"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/></svg>;
    case 'flower': return <svg {...common}><circle cx="12" cy="12" r="2"/><path d="M12 3a3 3 0 0 0 0 6 3 3 0 0 0 0-6z"/><path d="M12 15a3 3 0 0 0 0 6 3 3 0 0 0 0-6z"/><path d="M3 12a3 3 0 0 0 6 0 3 3 0 0 0-6 0z"/><path d="M15 12a3 3 0 0 0 6 0 3 3 0 0 0-6 0z"/></svg>;
    case 'cloud-storm': return <svg {...common}><path d="M17 15a4 4 0 0 0 0-8 6 6 0 0 0-11 2 4 4 0 0 0 1 8h10z"/><path d="M13 13l-2 4h3l-2 4"/></svg>;
    case 'candle': return <svg {...common}><path d="M12 2v4M10 14h4v6h-4z"/><path d="M10 14c-2-1-3-3-3-5s2-3 5-3 5 1 5 3-1 4-3 5"/></svg>;
    case 'sidebar-close': return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>;
    case 'sidebar-open': return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m17 9-3 3 3 3"/></svg>;
    case 'diamond': return <svg {...common}><polygon points="12,3 22,12 12,21 2,12"/></svg>;
    case 'copy': return <svg {...common}><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
    case 'upload': return <svg {...common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>;
    case 'download': return <svg {...common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>;
    case 'refresh': return <svg {...common}><path d="M3 12a9 9 0 0 1 15-7l3 3"/><path d="M21 3v6h-6"/><path d="M21 12a9 9 0 0 1-15 7l-3-3"/><path d="M3 21v-6h6"/></svg>;
    case 'sparkle': return <svg {...common}><path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5"/></svg>;
    case 'eye': return <svg {...common}><path d="M3 12s3-7 9-7 9 7 9 7-3 7-9 7-9-7-9-7z"/><circle cx="12" cy="12" r="3"/></svg>;
    case 'quill': return <svg {...common}><path d="M21 3 10 14l-3 7 7-3L21 3z"/><path d="M12 12 7 17"/></svg>;
    default: return <svg {...common}><circle cx="12" cy="12" r="9"/></svg>;
  }
};

// Ornamental corner piece (filigree)
const CornerFiligree = ({ className = '' }) => (
  <svg className={className} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M2 2h24" />
    <path d="M2 2v24" />
    <path d="M2 10c5 0 8-3 8-8" />
    <path d="M14 2c0 5 3 8 8 8" opacity=".5" />
    <path d="M2 14c5 0 8 3 8 8" opacity=".5" />
    <circle cx="4" cy="4" r="1.2" fill="currentColor" />
    <path d="M10 10c3 0 5 2 5 5" opacity=".7" />
  </svg>
);

// Flourish divider
const FlourishDivider = ({ className = '' }) => (
  <div className={`divider-ornate ${className}`}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3"><polygon points="12,4 20,12 12,20 4,12"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>
  </div>
);

Object.assign(window, { Icon, CornerFiligree, FlourishDivider });
