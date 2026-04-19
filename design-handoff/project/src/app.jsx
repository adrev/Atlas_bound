// ========== Main app ==========

const { useState, useEffect, useRef } = React;

const TWEAKS = /*EDITMODE-BEGIN*/{
  "theme": "tome",
  "mapBg": 0,
  "sealVisible": true,
  "dropCap": true,
  "ornaments": "filigree",
  "sidebarSide": "right"
}/*EDITMODE-END*/;

// Top-down battlemap SVGs rendered as data URLs
const makeBattleMap = (variant) => {
  const maps = {
    forest: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800' preserveAspectRatio='xMidYMid slice'>
      <defs>
        <radialGradient id='g' cx='50%' cy='50%' r='70%'><stop offset='0%' stop-color='%23405828'/><stop offset='100%' stop-color='%231a2410'/></radialGradient>
        <pattern id='moss' width='40' height='40' patternUnits='userSpaceOnUse'><circle cx='10' cy='10' r='1' fill='%23546a34'/><circle cx='30' cy='25' r='1.5' fill='%234a5f2c'/><circle cx='18' cy='32' r='1' fill='%235a7040'/></pattern>
      </defs>
      <rect width='1200' height='800' fill='url(%23g)'/>
      <rect width='1200' height='800' fill='url(%23moss)' opacity='0.7'/>
      <path d='M0 380 Q300 340 450 400 T800 420 Q950 430 1200 400 L1200 480 Q950 510 800 490 T450 480 Q300 420 0 460 Z' fill='%236b5535' opacity='0.7'/>
      <path d='M0 400 Q300 360 450 420 T800 440 Q950 450 1200 420' stroke='%238a6c44' stroke-width='3' fill='none' opacity='0.6'/>
      <g opacity='0.85'>
        ${Array.from({length:40}, (_,i) => {
          const x = 50 + (i*31 % 1100) + (i*17 % 60);
          const y = 50 + (i*47 % 700);
          const r = 18 + (i*7 % 24);
          const c = ['%231e3014','%23254018','%232e4a1c','%23203612'][i%4];
          return `<circle cx='${x}' cy='${y}' r='${r}' fill='${c}'/><circle cx='${x+r*.3}' cy='${y-r*.3}' r='${r*.6}' fill='%23395d24' opacity='0.5'/>`;
        }).join('')}
      </g>
      <g stroke='%23000' stroke-width='0.3' fill='none' opacity='0.15'>
        ${Array.from({length:25}, (_,i) => `<line x1='${i*48}' y1='0' x2='${i*48}' y2='800'/>`).join('')}
        ${Array.from({length:17}, (_,i) => `<line x1='0' y1='${i*48}' x2='1200' y2='${i*48}'/>`).join('')}
      </g>
    </svg>`,
    dungeon: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800' preserveAspectRatio='xMidYMid slice'>
      <defs>
        <pattern id='stone' width='80' height='80' patternUnits='userSpaceOnUse'>
          <rect width='80' height='80' fill='%23403530'/>
          <rect x='0' y='0' width='38' height='38' fill='%234a3d36' stroke='%23201810' stroke-width='1'/>
          <rect x='42' y='0' width='38' height='38' fill='%23453831' stroke='%23201810' stroke-width='1'/>
          <rect x='0' y='42' width='38' height='38' fill='%234e4039' stroke='%23201810' stroke-width='1'/>
          <rect x='42' y='42' width='38' height='38' fill='%23433630' stroke='%23201810' stroke-width='1'/>
        </pattern>
      </defs>
      <rect width='1200' height='800' fill='%23140e0a'/>
      <rect x='120' y='100' width='960' height='600' fill='url(%23stone)'/>
      <rect x='200' y='180' width='280' height='200' fill='%23201612' stroke='%236b4a0f' stroke-width='2'/>
      <rect x='520' y='180' width='200' height='140' fill='%23201612' stroke='%236b4a0f' stroke-width='2'/>
      <rect x='760' y='180' width='240' height='260' fill='%23201612' stroke='%236b4a0f' stroke-width='2'/>
      <circle cx='340' cy='280' r='60' fill='%231a1108' stroke='%23c79632' stroke-width='2' opacity='0.5'/>
      <g fill='%23e0b44f' opacity='0.7'>
        <circle cx='200' cy='180' r='4'/><circle cx='480' cy='180' r='4'/><circle cx='720' cy='180' r='4'/><circle cx='1000' cy='440' r='4'/>
      </g>
      <g stroke='%23000' stroke-width='0.3' fill='none' opacity='0.25'>
        ${Array.from({length:25}, (_,i) => `<line x1='${i*48}' y1='0' x2='${i*48}' y2='800'/>`).join('')}
        ${Array.from({length:17}, (_,i) => `<line x1='0' y1='${i*48}' x2='1200' y2='${i*48}'/>`).join('')}
      </g>
    </svg>`,
    tavern: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800' preserveAspectRatio='xMidYMid slice'>
      <rect width='1200' height='800' fill='%232a1e10'/>
      <rect x='60' y='60' width='1080' height='680' fill='%234a3420' stroke='%236b4a20' stroke-width='4'/>
      <g fill='%235a3f24'>
        ${Array.from({length:80}, (_,i) => `<rect x='${60 + (i%10)*108}' y='${60 + Math.floor(i/10)*85}' width='106' height='83' stroke='%23301e10' stroke-width='1.5' fill='%23${(0x50 + (i*7)%40).toString(16)}3520'/>`).join('')}
      </g>
      <rect x='80' y='100' width='300' height='60' fill='%238a6a3a' stroke='%23402818' stroke-width='2'/>
      <circle cx='400' cy='400' r='50' fill='%236b4a20' stroke='%23402818' stroke-width='2'/>
      <circle cx='600' cy='500' r='50' fill='%236b4a20' stroke='%23402818' stroke-width='2'/>
      <circle cx='800' cy='350' r='50' fill='%236b4a20' stroke='%23402818' stroke-width='2'/>
      <rect x='1000' y='400' width='80' height='240' fill='%23301e10' stroke='%23c9423a' stroke-width='2'/>
      <circle cx='1040' cy='480' r='20' fill='%23c9423a' opacity='0.6'/>
      <g stroke='%23000' stroke-width='0.3' fill='none' opacity='0.25'>
        ${Array.from({length:25}, (_,i) => `<line x1='${i*48}' y1='0' x2='${i*48}' y2='800'/>`).join('')}
        ${Array.from({length:17}, (_,i) => `<line x1='0' y1='${i*48}' x2='1200' y2='${i*48}'/>`).join('')}
      </g>
    </svg>`,
    river: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800' preserveAspectRatio='xMidYMid slice'>
      <rect width='1200' height='800' fill='%23405828'/>
      <path d='M0 300 Q200 280 400 340 Q600 400 800 360 Q1000 320 1200 380 L1200 500 Q1000 460 800 500 Q600 540 400 480 Q200 420 0 460 Z' fill='%234a6a8a'/>
      <path d='M0 320 Q200 300 400 360 Q600 420 800 380 Q1000 340 1200 400' stroke='%236a9acc' stroke-width='2' fill='none' opacity='0.6'/>
      <rect x='520' y='340' width='160' height='80' fill='%238a6c44' stroke='%23402818' stroke-width='2'/>
      <g fill='%23402818'>
        <rect x='530' y='345' width='20' height='70'/><rect x='560' y='345' width='20' height='70'/><rect x='590' y='345' width='20' height='70'/><rect x='620' y='345' width='20' height='70'/><rect x='650' y='345' width='20' height='70'/>
      </g>
      <g opacity='0.85'>
        ${Array.from({length:30}, (_,i) => {
          const x = 50 + (i*37 % 1100);
          const y = (i<15 ? 50 + (i*11 % 200) : 560 + (i*13 % 200));
          const r = 16 + (i*5 % 20);
          return `<circle cx='${x}' cy='${y}' r='${r}' fill='%231e3014'/><circle cx='${x+r*.3}' cy='${y-r*.3}' r='${r*.6}' fill='%23395d24' opacity='0.5'/>`;
        }).join('')}
      </g>
      <g stroke='%23000' stroke-width='0.3' fill='none' opacity='0.2'>
        ${Array.from({length:25}, (_,i) => `<line x1='${i*48}' y1='0' x2='${i*48}' y2='800'/>`).join('')}
        ${Array.from({length:17}, (_,i) => `<line x1='0' y1='${i*48}' x2='1200' y2='${i*48}'/>`).join('')}
      </g>
    </svg>`,
  };
  return `data:image/svg+xml;utf8,${maps[variant]}`;
};

const MAP_IMAGES = [
  makeBattleMap('forest'),
  makeBattleMap('dungeon'),
  makeBattleMap('tavern'),
  makeBattleMap('river'),
];

// Top-down creature tokens as SVG
const makeToken = (kind) => {
  const tokens = {
    vulture: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
      <circle cx='50' cy='50' r='48' fill='%232a1a10'/>
      <path d='M50 20 L35 55 L25 65 L35 60 L40 75 L50 70 L60 75 L65 60 L75 65 L65 55 Z' fill='%235a3a2a'/>
      <ellipse cx='50' cy='45' rx='8' ry='6' fill='%23e8d4a8'/>
      <path d='M50 35 L45 28 L50 25 L55 28 Z' fill='%23d4a050'/>
      <circle cx='46' cy='43' r='1.5' fill='%23000'/><circle cx='54' cy='43' r='1.5' fill='%23000'/>
    </svg>`,
    zoog: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
      <circle cx='50' cy='50' r='48' fill='%23402018'/>
      <ellipse cx='50' cy='52' rx='26' ry='22' fill='%237a3a4a'/>
      <circle cx='42' cy='45' r='4' fill='%23e0d040'/><circle cx='58' cy='45' r='4' fill='%23e0d040'/>
      <circle cx='42' cy='45' r='1.5' fill='%23000'/><circle cx='58' cy='45' r='1.5' fill='%23000'/>
      <path d='M35 60 Q50 68 65 60' stroke='%23200808' stroke-width='2' fill='none'/>
      <path d='M35 35 L25 25 M65 35 L75 25' stroke='%239d5a6a' stroke-width='3' stroke-linecap='round'/>
    </svg>`,
    shrub: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
      <circle cx='50' cy='50' r='48' fill='%231a2410'/>
      <circle cx='50' cy='52' r='28' fill='%23395d24'/>
      <circle cx='38' cy='42' r='12' fill='%234a7030'/>
      <circle cx='62' cy='44' r='14' fill='%235a8038'/>
      <circle cx='50' cy='60' r='10' fill='%233a5020'/>
      <circle cx='45' cy='48' r='2' fill='%23e0d040'/><circle cx='58' cy='50' r='2' fill='%23e0d040'/>
      <circle cx='45' cy='48' r='0.8' fill='%23000'/><circle cx='58' cy='50' r='0.8' fill='%23000'/>
    </svg>`,
    hero: `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
      <circle cx='50' cy='50' r='48' fill='%23201810'/>
      <circle cx='50' cy='45' r='18' fill='%23c49484'/>
      <path d='M32 55 Q50 80 68 55 L70 70 Q50 85 30 70 Z' fill='%238a1e1a'/>
      <path d='M42 38 Q50 30 58 38 L60 32 L50 28 L40 32 Z' fill='%23402818'/>
      <circle cx='44' cy='46' r='1.5' fill='%23000'/><circle cx='56' cy='46' r='1.5' fill='%23000'/>
      <path d='M44 38 L38 30 M56 38 L62 30' stroke='%239d2a23' stroke-width='2.5' stroke-linecap='round'/>
    </svg>`,
  };
  return `data:image/svg+xml;utf8,${tokens[kind]}`;
};

// Reusable corner filigree ornament
const CornerFiligree = ({ className }) => (
  <svg className={className} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M0 8 Q6 8 10 14 Q14 20 14 28 Q14 34 10 38 Q6 42 0 42"/>
    <path d="M8 0 Q8 6 14 10 Q20 14 28 14 Q34 14 38 10 Q42 6 42 0"/>
    <circle cx="18" cy="18" r="2.5"/>
    <path d="M18 18 Q24 24 30 24 Q36 24 36 18"/>
    <path d="M18 18 Q24 24 24 30 Q24 36 18 36"/>
    <path d="M4 4 Q10 10 18 18"/>
  </svg>
);

const FlourishDivider = () => (
  <div className="divider-ornate">
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
  </div>
);

Object.assign(window, { CornerFiligree, FlourishDivider });

// ========================================================================
// Top bar
// ========================================================================
const TopBar = ({ onToggleTweaks }) => (
  <div className="topbar">
    <div className="sigil">K</div>
    <div className="wordmark">KBRT<em>.AI</em></div>
    <div style={{ width: 1, height: 24, background: 'var(--border-line-strong)', margin: '0 6px' }}/>
    <div className="room-chip">
      <Icon name="shield" size={12}/>
      <span>Room</span>
      <span className="code">SUGTPG</span>
    </div>
    <div className="room-chip">
      <Icon name="users" size={12}/>
      <span>1 PLAYER</span>
    </div>
    <div className="spacer"/>
    <button className="pill-btn" onClick={()=>window.__toast?.('Summoning adventurers...')}>
      <Icon name="users" size={11} style={{ marginRight: 6, verticalAlign: 'middle' }}/>Invite
    </button>
    <button className="pill-btn danger">End Session</button>
    <div style={{ width: 1, height: 24, background: 'var(--border-line-strong)', margin: '0 6px' }}/>
    <div className="user-chip">
      <div className="avatar">A</div>
      <div>
        <div className="name">.adrev</div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--success)', letterSpacing: 1 }}>● DM</div>
      </div>
    </div>
    <button className="icon-btn" onClick={onToggleTweaks} title="Tweaks">
      <Icon name="gear" size={16}/>
    </button>
  </div>
);

// ========================================================================
// Party portrait rack (top-left of map)
// ========================================================================
const PartyRack = ({ activeIdx, onClick }) => (
  <div className="party-rack">
    {INITIATIVE.map((c, i) => (
      <div key={i}
        className={`portrait ${i === activeIdx ? 'active' : ''}`}
        style={{ '--hp': `${c.hp/c.hpMax*100}%` }}
        onClick={()=>onClick(i)}>
        <img src={c.avatar}/>
      </div>
    ))}
  </div>
);

// ========================================================================
// Map stage
// ========================================================================
const MapStage = ({ mapIdx, showSeal }) => (
  <div className="stage">
    <div className="map-frame">
      <CornerFiligree className="corner tl"/>
      <CornerFiligree className="corner tr"/>
      <CornerFiligree className="corner bl"/>
      <CornerFiligree className="corner br"/>
      <img className="map-bg" src={MAP_IMAGES[mapIdx % MAP_IMAGES.length]}/>

      {/* Fog-of-war subtle grid overlay */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: .18, pointerEvents: 'none' }}>
        <defs>
          <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#e0b44f" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
      </svg>

      {/* Tokens on map */}
      <div style={{ position: 'absolute', left: '26%', top: '38%', zIndex: 6 }}>
        <TokenMarker avatar={makeToken('hero')} hp="14/14" color="var(--accent)"/>
      </div>
      <div style={{ position: 'absolute', left: '54%', top: '44%', zIndex: 6 }}>
        <TokenMarker avatar={makeToken('vulture')} hp="10/10" color="var(--danger)" label="Vulture"/>
      </div>
      <div style={{ position: 'absolute', left: '44%', top: '62%', zIndex: 6 }}>
        <TokenMarker avatar={makeToken('zoog')} hp="10/10" color="var(--success)" label="Zoog"/>
      </div>
      <div style={{ position: 'absolute', left: '68%', top: '56%', zIndex: 6 }}>
        <TokenMarker avatar={makeToken('shrub')} hp="10/10" color="var(--success)" label="Shrub"/>
      </div>

      <PartyRack activeIdx={1} onClick={()=>{}}/>

      {/* Floating seal in lower-right of map */}
      {showSeal && (
        <div style={{ position: 'absolute', right: 20, bottom: 20, zIndex: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ textAlign: 'right', fontFamily: 'var(--font-body)', fontStyle: 'italic', color: 'var(--parch-200)', fontSize: 12, textShadow: '0 1px 4px rgba(0,0,0,.8)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)' }}>ACT I · SCENE II</div>
            <div>The Forked Forest Path</div>
          </div>
          <div className="seal">K</div>
        </div>
      )}

      {/* Map zoom/controls */}
      <div style={{ position: 'absolute', right: 16, top: 16, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button className="icon-btn" style={{ background: 'rgba(10,6,4,.8)', border: '1px solid var(--border-line-strong)' }}><Icon name="plus" size={14}/></button>
        <button className="icon-btn" style={{ background: 'rgba(10,6,4,.8)', border: '1px solid var(--border-line-strong)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/></svg>
        </button>
        <button className="icon-btn" style={{ background: 'rgba(10,6,4,.8)', border: '1px solid var(--border-line-strong)' }}><Icon name="search" size={14}/></button>
      </div>
    </div>
  </div>
);

const TokenMarker = ({ avatar, hp, color, label }) => (
  <div style={{ position: 'relative' }}>
    <div style={{
      width: 56, height: 56, borderRadius: '50%', overflow: 'hidden',
      boxShadow: `0 0 0 2px ${color}, 0 0 0 4px rgba(0,0,0,.6), 0 4px 12px rgba(0,0,0,.7)`,
      cursor: 'pointer', transition: 'transform .15s',
    }} onMouseEnter={e=>e.currentTarget.style.transform='scale(1.08)'}
       onMouseLeave={e=>e.currentTarget.style.transform='none'}>
      <img src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
    </div>
    {label && (
      <div style={{
        position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)',
        padding: '2px 8px', background: 'rgba(10,6,4,.88)',
        border: `1px solid ${color}`, borderRadius: 2,
        fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1.5,
        color, whiteSpace: 'nowrap', textTransform: 'uppercase',
      }}>{label}</div>
    )}
    <div style={{
      position: 'absolute', bottom: -6, left: '50%', transform: 'translateX(-50%)',
      padding: '1px 8px', background: 'rgba(10,6,4,.88)',
      border: '1px solid var(--border-line-strong)', borderRadius: 8,
      fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-primary)',
    }}>{hp}</div>
  </div>
);

// ========================================================================
// Sidebar
// ========================================================================
const Sidebar = ({ tab, setTab, collapsed, onOpenSheet, onOpenInventory, onOpenMaps, onOpenCreatures }) => {
  const tabs = [
    { id: 'tools', icon: 'map', label: 'DM' },
    { id: 'combat', icon: 'swords', label: 'Combat', badge: 'LIVE' },
    { id: 'hero', icon: 'heart', label: 'Hero' },
    { id: 'wiki', icon: 'tome', label: 'Wiki' },
    { id: 'notes', icon: 'scroll', label: 'Notes' },
    { id: 'chat', icon: 'chat', label: 'Chat' },
    { id: 'players', icon: 'users', label: 'Players' },
  ];
  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={()=>setTab(t.id)}>
            <Icon name={t.icon} size={18}/>
            <span>{t.label}</span>
            {t.badge && <span className="badge" style={{ fontSize: 7, letterSpacing: .5 }}>•</span>}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {tab === 'combat' && <CombatPanel onOpenSheet={onOpenSheet}/>}
        {tab === 'hero' && <HeroPanel onOpenSheet={onOpenSheet} onOpenInventory={onOpenInventory}/>}
        {tab === 'wiki' && <WikiPanel/>}
        {tab === 'notes' && <NotesPanel/>}
        {tab === 'chat' && <ChatPanel/>}
        {tab === 'players' && <PlayersPanel/>}
        {tab === 'tools' && <ToolsPanel onOpenMaps={onOpenMaps} onOpenCreatures={onOpenCreatures}/>}
      </div>
    </div>
  );
};

// ========================================================================
// Hotbar (bottom)
// ========================================================================
const Hotbar = ({ onToggleSidebar, sidebarCollapsed, onRollDie }) => (
  <div className="hotbar">
    <button className="icon-btn" onClick={onToggleSidebar} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
      <Icon name={sidebarCollapsed ? 'chevron-left' : 'chevron-right'} size={16}/>
    </button>

    <button className="action-btn"><Icon name="swords"/>Attack</button>
    <button className="action-btn"><Icon name="bolt"/>Cast</button>
    <button className="action-btn"><Icon name="footprints"/>Move</button>
    <button className="action-btn"><Icon name="shield"/>Dodge</button>
    <button className="action-btn"><Icon name="hide"/>Hide</button>
    <button className="action-btn"><Icon name="hand"/>Shove</button>

    <div style={{ width: 1, height: 32, background: 'var(--border-line)', margin: '0 6px' }}/>

    <button className="action-btn rest"><Icon name="moon"/>Short Rest</button>
    <button className="action-btn rest long"><Icon name="sun"/>Long Rest</button>

    <div className="dice-rack">
      {['d4','d6','d8','d10','d12','d20','d100'].map(d => (
        <button key={d} className={`die-btn ${d==='d20'?'active':''}`} onClick={()=>onRollDie(d)} title={`Roll ${d}`}>
          <Icon name={d}/>
          <span>{d.slice(1)}</span>
        </button>
      ))}
    </div>

    <div className="mod-counter">
      <span style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1 }}>MOD</span>
      <span>+0</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button style={{ width: 14, height: 14, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: 8 }}>▲</button>
        <button style={{ width: 14, height: 14, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: 8 }}>▼</button>
      </div>
    </div>

    <button className="action-btn" style={{ marginLeft: 6 }}>
      <Icon name="x"/>ADV
    </button>
    <button className="action-btn">
      <Icon name="x"/>DIS
    </button>
  </div>
);

// ========================================================================
// Tweaks panel
// ========================================================================
const TweaksPanel = ({ state, set, open, onClose }) => {
  const themes = [
    { id: 'tome', name: 'Tome', bg: 'linear-gradient(135deg,#0a0604,#2a1a0c)', accent: '#e0b44f' },
    { id: 'parchment', name: 'Parch', bg: 'linear-gradient(135deg,#f3e3bc,#c9a063)', accent: '#8a1e1a' },
    { id: 'noir', name: 'Noir', bg: 'linear-gradient(135deg,#0e0c0c,#3a1a18)', accent: '#c9423a' },
    { id: 'grove', name: 'Grove', bg: 'linear-gradient(135deg,#0a1109,#2a4020)', accent: '#d48a3d' },
    { id: 'codex', name: 'Codex', bg: 'linear-gradient(135deg,#06061a,#1a1a4a)', accent: '#9d7dff' },
  ];
  return (
    <div className={`tweaks ${open ? 'open' : ''}`}>
      <div className="tweaks-head">
        <span>Tweaks</span>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={onClose}><Icon name="x" size={12}/></button>
      </div>
      <div className="tweaks-body">
        <div className="tweak-group">
          <label>Theme</label>
          <div className="theme-grid">
            {themes.map(t => (
              <div key={t.id}
                className={`theme-swatch ${state.theme === t.id ? 'active' : ''}`}
                style={{ background: t.bg }}
                onClick={()=>set('theme', t.id)}>
                <div style={{ position: 'absolute', top: 4, right: 4, width: 10, height: 10, borderRadius: '50%', background: t.accent, boxShadow: `0 0 6px ${t.accent}` }}/>
                <div className="name">{t.name}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="tweak-group">
          <label>Map Scene</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
            {MAP_IMAGES.map((m,i) => (
              <div key={i}
                onClick={()=>set('mapBg', i)}
                style={{
                  height: 40, backgroundImage: `url(${m})`, backgroundSize: 'cover', backgroundPosition: 'center',
                  border: state.mapBg === i ? '2px solid var(--accent)' : '2px solid transparent',
                  borderRadius: 2, cursor: 'pointer',
                }}/>
            ))}
          </div>
        </div>
        <div className="tweak-group">
          <label>Ornaments</label>
          <div className="ornament-row">
            {['filigree', 'minimal', 'heavy'].map(o=>(
              <button key={o} className={state.ornaments === o ? 'active' : ''} onClick={()=>set('ornaments', o)}>{o}</button>
            ))}
          </div>
        </div>
        <div className="tweak-group">
          <label>Show Wax Seal</label>
          <div className="ornament-row">
            <button className={state.sealVisible ? 'active' : ''} onClick={()=>set('sealVisible', true)}>On</button>
            <button className={!state.sealVisible ? 'active' : ''} onClick={()=>set('sealVisible', false)}>Off</button>
          </div>
        </div>
        <div className="tweak-group">
          <label>Sidebar Side</label>
          <div className="ornament-row">
            <button className={state.sidebarSide === 'right' ? 'active' : ''} onClick={()=>set('sidebarSide', 'right')}>Right</button>
            <button className={state.sidebarSide === 'left' ? 'active' : ''} onClick={()=>set('sidebarSide', 'left')}>Left</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ========================================================================
// App root
// ========================================================================
const App = () => {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(window.KBRT_STATE_KEY)) || {}; } catch { return {}; } })();

  const [tab, setTab] = useState(saved.tab || 'hero');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modal, setModal] = useState(saved.modal || null);
  const [sheetTab, setSheetTab] = useState('INVENTORY');
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [state, setState] = useState({ ...TWEAKS, ...(saved.tweaks || {}) });
  const [toast, setToastMsg] = useState(null);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // Persist
  useEffect(() => {
    localStorage.setItem(window.KBRT_STATE_KEY, JSON.stringify({ tab, modal, tweaks: state }));
  }, [tab, modal, state]);

  // Toast
  useEffect(() => {
    window.__toast = (m) => { setToastMsg(m); setTimeout(()=>setToastMsg(null), 2000); };
  }, []);

  // Edit mode integration
  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data;
      if (!d || !d.type) return;
      if (d.type === '__activate_edit_mode') { setEditMode(true); setTweaksOpen(true); }
      if (d.type === '__deactivate_edit_mode') { setEditMode(false); setTweaksOpen(false); }
    };
    window.addEventListener('message', onMsg);
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const setTweak = (k, v) => {
    setState(s => {
      const next = { ...s, [k]: v };
      try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*'); } catch {}
      return next;
    });
  };

  const rollDie = (d) => {
    const sides = parseInt(d.slice(1));
    const n = 1 + Math.floor(Math.random() * sides);
    window.__toast?.(`${d.toUpperCase()} → ${n}`);
  };

  return (
    <>
      <TopBar onToggleTweaks={()=>setTweaksOpen(!tweaksOpen)}/>
      <div className="main" style={{ flexDirection: state.sidebarSide === 'left' ? 'row-reverse' : 'row' }}>
        <MapStage mapIdx={state.mapBg} showSeal={state.sealVisible}/>
        <Sidebar
          tab={tab} setTab={setTab}
          collapsed={sidebarCollapsed}
          onOpenSheet={()=>{ setSheetTab('ACTIONS'); setModal('sheet'); }}
          onOpenInventory={()=>{ setSheetTab('INVENTORY'); setModal('sheet'); }}
          onOpenMaps={()=>setModal('maps')}
          onOpenCreatures={()=>setModal('creatures')}
        />
      </div>
      <Hotbar
        onToggleSidebar={()=>setSidebarCollapsed(c=>!c)}
        sidebarCollapsed={sidebarCollapsed}
        onRollDie={rollDie}
      />

      {/* Modals */}
      {modal === 'maps' && <MapBrowserModal onClose={()=>setModal(null)} onOpenUpload={()=>setModal('upload')}/>}
      {modal === 'upload' && <UploadModal onClose={()=>setModal('maps')}/>}
      {modal === 'creatures' && <CreatureBrowserModal onClose={()=>setModal(null)}/>}
      {modal === 'sheet' && <CharacterSheetModal onClose={()=>setModal(null)} initialTab={sheetTab}/>}

      <TweaksPanel state={state} set={setTweak} open={tweaksOpen} onClose={()=>setTweaksOpen(false)}/>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
};

ReactDOM.createRoot(document.getElementById('app')).render(<App/>);
