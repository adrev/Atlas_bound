// ========== Sidebar panels (Combat, Hero, Wiki, Notes, Chat, Players) ==========

// Combat panel --------------------------------------------------------------
const CombatPanel = ({ onOpenSheet }) => {
  const [active, setActive] = React.useState(0);
  return (
    <div style={{ padding: '0 16px 20px' }}>
      <button className="ornate-btn" style={{ width: '100%', marginTop: 16 }} onClick={()=>window.__toast?.('Combat ended')}>
        End Combat
      </button>

      <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0 }}>Round 1</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {INITIATIVE.map((c, i) => (
          <div key={i}
            onClick={()=>setActive(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', cursor: 'pointer',
              background: active === i ? 'linear-gradient(90deg, rgba(201,66,58,.15), rgba(224,180,79,.06))' : 'var(--bg-panel-raised)',
              border: active === i ? '1px solid var(--accent)' : '1px solid var(--border-line)',
              borderLeft: c.enemy ? '3px solid var(--danger)' : '3px solid var(--accent)',
              borderRadius: 3,
              position: 'relative',
            }}>
            <div style={{
              width: 32, height: 32, display: 'grid', placeItems: 'center',
              fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14,
              color: active === i ? 'var(--ink-900)' : 'var(--accent)',
              background: active === i ? 'var(--accent)' : 'transparent',
              border: '1px solid var(--accent)',
              borderRadius: 2,
            }}>{c.init}</div>
            <div style={{
              width: 34, height: 34, borderRadius: '50%', overflow: 'hidden',
              boxShadow: c.enemy ? '0 0 0 2px var(--danger)' : '0 0 0 2px var(--accent)',
            }}>
              <img src={c.avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600,
                color: c.enemy ? 'var(--danger)' : 'var(--text-primary)',
                textTransform: 'uppercase', letterSpacing: 1,
              }}>{c.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                <div style={{ flex: 1, height: 4, background: 'var(--ink-900)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${c.hp/c.hpMax*100}%`, height: '100%', background: 'linear-gradient(90deg, #5aa05a, #7dc77d)' }} />
                </div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)' }}>{c.hp}/{c.hpMax}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Action budget */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginTop: 20 }}>
        {[
          { label: 'Action', icon: 'swords', color: 'var(--danger)' },
          { label: 'Bonus', icon: 'bolt', color: 'var(--accent)' },
          { label: '30ft', icon: 'footprints', color: 'var(--rune-blue)', used: true },
          { label: 'Reaction', icon: 'shield', color: 'var(--rune-violet)' },
        ].map((a,i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%', margin: '0 auto',
              display: 'grid', placeItems: 'center',
              background: a.used ? 'transparent' : 'rgba(0,0,0,.4)',
              border: `2px solid ${a.color}`,
              color: a.color,
              opacity: a.used ? .5 : 1,
              position: 'relative',
            }}>
              <Icon name={a.icon} size={20} />
            </div>
            <div style={{
              marginTop: 6, fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1.5,
              color: a.used ? 'var(--text-muted)' : a.color, textTransform: 'uppercase'
            }}>{a.label}</div>
            {a.used && <div style={{ width: 20, height: 2, background: a.color, margin: '4px auto 0' }} />}
          </div>
        ))}
      </div>

      <button className="ornate-btn" style={{ width: '100%', marginTop: 20 }}>
        <Icon name="chevron-right" size={14} style={{ marginRight: 6 }} /> End Turn
      </button>
    </div>
  );
};

// Hero panel --------------------------------------------------------------
const HeroPanel = ({ onOpenSheet, onOpenInventory }) => (
  <div style={{ padding: '0 16px 16px' }}>
    {/* Header card */}
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, marginTop: 14,
      padding: 12, background: 'var(--bg-panel-raised)',
      border: '1px solid var(--border-line)', borderRadius: 3,
      position: 'relative',
    }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 2px var(--accent), 0 0 0 3px var(--bg-panel-raised)', flex: '0 0 56px' }}>
        <img src={HERO.avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 6px var(--success)' }} />
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: 1 }}>{HERO.name}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontStyle: 'italic', fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {HERO.race} {HERO.class} · Lv {HERO.level}
        </div>
      </div>
    </div>

    {/* Attitude tokens */}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginTop: 10 }}>
      {[['Friendly', 'var(--success)', true], ['Neutral', '#d4b541', false], ['Hostile', 'var(--danger)', false]].map(([l,c,a],i)=>(
        <button key={i} style={{
          padding: '6px 8px', borderRadius: 3, cursor: 'pointer',
          background: a ? `${c}22` : 'transparent',
          border: `1px solid ${a ? c : 'var(--border-line)'}`,
          color: a ? c : 'var(--text-secondary)',
          fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: a ? `0 0 6px ${c}` : 'none' }} />
          {l}
        </button>
      ))}
    </div>

    {/* AC/SPD/INIT */}
    <div style={{ display: 'flex', justifyContent: 'space-around', margin: '14px 0 10px',
      fontFamily: 'var(--font-display)', letterSpacing: 1, color: 'var(--text-secondary)', fontSize: 11 }}>
      <span>AC <b style={{ color: 'var(--text-primary)', fontSize: 14 }}>{HERO.ac}</b></span>
      <span>SPD <b style={{ color: 'var(--text-primary)', fontSize: 14 }}>{HERO.spd}FT</b></span>
      <span>INIT <b style={{ color: 'var(--accent)', fontSize: 14 }}>+{HERO.init}</b></span>
    </div>

    {/* HP bar with dmg/heal chips */}
    <HPBar />

    {/* Conditions */}
    <button style={{
      marginTop: 10, padding: '6px 12px', background: 'transparent',
      border: '1px dashed var(--border-line-strong)', color: 'var(--text-secondary)',
      fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase',
      cursor: 'pointer', borderRadius: 2,
    }}>+ Add condition</button>

    {/* Stats */}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 4, marginTop: 14 }}>
      {Object.entries(HERO.stats).map(([k,v])=>(
        <div key={k} style={{ textAlign: 'center', padding: '6px 0', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1, color: 'var(--accent)' }}>{k}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{v >= 0 ? '+' : ''}{v}</div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)' }}>{HERO.rawStats[k]}</div>
        </div>
      ))}
    </div>

    {/* Buttons */}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
      <button onClick={onOpenSheet} className="ornate-btn ghost" style={{ padding: '10px' }}>View Stats</button>
      <button onClick={onOpenInventory} className="ornate-btn ghost" style={{ padding: '10px' }}>Inventory</button>
    </div>

    {/* Attacks */}
    <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 16 }}>Attacks</div>
    {HERO.attacks.map((a,i)=>(
      <div key={i} style={{ padding: '8px 0', borderBottom: i < HERO.attacks.length-1 ? '1px dashed var(--border-line)' : 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-primary)', letterSpacing: 1, marginBottom: 6 }}>{a.name}</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
          <Chip color="danger">Melee {a.melee}</Chip>
          <Chip>Off-hand (BA)</Chip>
          <Chip>Throw {a.thrown}</Chip>
          <Chip variant="dmg">{a.dmg}</Chip>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {a.tags.map(t=><Chip key={t} variant="tag">{t}</Chip>)}
        </div>
      </div>
    ))}

    {/* Cantrips */}
    <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 12 }}>
      Cantrips <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({HERO.cantrips.length})</span>
    </div>
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {HERO.cantrips.map(c=>(
        <Chip key={c.name} variant="spell">
          {c.name}{c.dmg && <span style={{ marginLeft: 4, fontSize: 10, opacity: .7 }}>{c.dmg}</span>}
        </Chip>
      ))}
    </div>

    {/* Spells */}
    <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 12 }}>
      Spells <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({HERO.spells.length})</span>
    </div>
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {HERO.spells.map(s=>(
        <Chip key={s.name} variant="spell-l1">
          L{s.lvl} {s.name} <span style={{ opacity: .65, marginLeft: 4 }}>{s.slot}</span>
          {s.dmg && <span style={{ marginLeft: 4, opacity: .65 }}>{s.dmg}</span>}
        </Chip>
      ))}
    </div>

    {/* Footer actions */}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border-line)' }}>
      <button className="ornate-btn ghost" style={{ padding: 8, fontSize: 9 }}><Icon name="users" size={12} style={{ marginRight: 4 }}/>Characters</button>
      <button className="ornate-btn ghost" style={{ padding: 8, fontSize: 9 }}><Icon name="upload" size={12} style={{ marginRight: 4 }}/>Import</button>
      <button className="ornate-btn ghost" style={{ padding: 8, fontSize: 9 }}><Icon name="refresh" size={12} style={{ marginRight: 4 }}/>Sync</button>
    </div>
  </div>
);

// HP bar with dmg/heal inputs
const HPBar = () => {
  const [hp, setHp] = React.useState(HERO.hp);
  const [val, setVal] = React.useState('');
  const pct = hp / HERO.hpMax * 100;
  const color = pct > 60 ? 'linear-gradient(90deg, #5aa05a, #7dc77d)' : pct > 30 ? 'linear-gradient(90deg, #c49a2a, #e8bf3a)' : 'linear-gradient(90deg, #9d2a23, #c9423a)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)' }}>HP</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[-1, -5, -10].map(n => (
            <button key={n} onClick={()=>setHp(Math.max(0, hp+n))} style={{
              padding: '2px 7px', background: 'rgba(201,66,58,.15)', border: '1px solid var(--danger)',
              color: 'var(--danger)', fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, cursor: 'pointer', borderRadius: 2,
            }}>{n}</button>
          ))}
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: '0 6px', letterSpacing: 1 }}>
            {hp}/{HERO.hpMax}
          </span>
          {[+1, +5, +10].map(n => (
            <button key={n} onClick={()=>setHp(Math.min(HERO.hpMax, hp+n))} style={{
              padding: '2px 7px', background: 'rgba(90,160,90,.15)', border: '1px solid var(--success)',
              color: 'var(--success)', fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, cursor: 'pointer', borderRadius: 2,
            }}>+{n}</button>
          ))}
        </div>
      </div>
      <div style={{ height: 10, background: 'var(--ink-900)', borderRadius: 2, marginTop: 6, border: '1px solid var(--border-line)', overflow: 'hidden', position: 'relative' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .3s' }} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input value={val} onChange={e=>setVal(e.target.value)} placeholder="Custom" style={{
          flex: 1, padding: '6px 10px', background: 'var(--ink-900)', border: '1px solid var(--border-line)',
          color: 'var(--text-primary)', fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none'
        }} />
        <button onClick={()=>{ const n = parseInt(val)||0; setHp(Math.max(0,hp-n)); setVal(''); }} style={{
          padding: '6px 12px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)',
          fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 2, letterSpacing: 1,
        }}>Dmg</button>
        <button onClick={()=>{ const n = parseInt(val)||0; setHp(Math.min(HERO.hpMax,hp+n)); setVal(''); }} style={{
          padding: '6px 12px', background: 'transparent', border: '1px solid var(--success)', color: 'var(--success)',
          fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 2, letterSpacing: 1,
        }}>Heal</button>
      </div>
    </div>
  );
};

// Chip component
const Chip = ({ children, color, variant }) => {
  const base = {
    display: 'inline-flex', alignItems: 'center',
    padding: '3px 8px', fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 500,
    borderRadius: 2, whiteSpace: 'nowrap', letterSpacing: .3,
    border: '1px solid transparent',
  };
  const variants = {
    danger: { background: 'rgba(201,66,58,.15)', color: 'var(--danger)', borderColor: 'var(--danger)' },
    dmg: { background: 'var(--ink-900)', color: 'var(--accent)', borderColor: 'var(--border-line)' },
    tag: { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border-line)' },
    spell: { background: 'rgba(158,123,198,.12)', color: '#c9a9e8', borderColor: 'rgba(158,123,198,.4)' },
    'spell-l1': { background: 'rgba(201,66,58,.08)', color: '#e89289', borderColor: 'rgba(201,66,58,.3)' },
  };
  return <span style={{ ...base, ...(variants[variant] || (color === 'danger' ? variants.danger : {})) }}>{children}</span>;
};

// Wiki panel --------------------------------------------------------------
const WikiPanel = () => {
  const [filter, setFilter] = React.useState('Spells');
  const items = SPELLS_WIKI;
  return (
    <div style={{ padding: '16px' }}>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Icon name="search" size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }}/>
        <input placeholder="Search monsters, spells, items..." style={{
          width: '100%', padding: '8px 12px 8px 32px',
          background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line-strong)',
          color: 'var(--text-primary)', fontFamily: 'var(--font-body)', fontSize: 13,
          borderRadius: 3, outline: 'none',
        }}/>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {['All', 'Monsters', 'Spells', 'Items', 'Homebrew'].map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            padding: '4px 10px', borderRadius: 12,
            border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border-line)'}`,
            background: filter === f ? 'rgba(224,180,79,.12)' : 'transparent',
            color: filter === f ? 'var(--accent)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1, cursor: 'pointer', textTransform: 'uppercase',
          }}>{f}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((s,i)=>(
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, cursor: 'pointer', borderRadius: 2 }}
            onMouseEnter={e=>e.currentTarget.style.background='var(--bg-panel-raised)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: `radial-gradient(circle at 35% 35%, ${s.color}, #000 85%)`,
              boxShadow: `0 0 12px ${s.color}55, inset 0 0 8px rgba(0,0,0,.6)`,
              border: '1px solid var(--ink-900)',
              flex: '0 0 36px',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  padding: '1px 6px', background: 'rgba(106,169,209,.15)', color: '#6aa9d1',
                  border: '1px solid rgba(106,169,209,.4)',
                  fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1, borderRadius: 2,
                }}>SPELL</span>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: .5 }}>{s.name}</span>
              </div>
            </div>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>{s.lvl}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Notes panel --------------------------------------------------------------
const NotesPanel = () => {
  const [filter, setFilter] = React.useState('ALL');
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 14, marginBottom: 14, borderBottom: '1px solid var(--border-line)', paddingBottom: 10 }}>
        {['ALL', 'NPCS', 'LOCATIONS', 'QUESTS', 'RECAPS'].map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2,
            color: filter === f ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: filter === f ? '2px solid var(--accent)' : '2px solid transparent',
            padding: '4px 0',
          }}>{f}</button>
        ))}
      </div>
      <button className="ornate-btn" style={{ width: '100%' }}>
        <Icon name="plus" size={14} style={{ marginRight: 6 }}/>New Note
      </button>
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-body)', fontStyle: 'italic', fontSize: 13 }}>
        No notes yet. Scribe one to begin your chronicle.
      </div>
    </div>
  );
};

// Chat panel --------------------------------------------------------------
const ChatPanel = () => {
  const [mode, setMode] = React.useState('IC');
  const [msg, setMsg] = React.useState('');
  const [rolls, setRolls] = React.useState(ROLLS);
  const send = () => {
    if (!msg) return;
    // Parse /roll
    const m = msg.match(/\/roll\s+(\d+)?d(\d+)\s*([+-]\s*\d+)?/i);
    if (m) {
      const n = parseInt(m[1]||'1'), sides = parseInt(m[2]), bonus = m[3] ? parseInt(m[3].replace(/\s/g,'')) : 0;
      const rls = Array.from({length: n}, ()=>1+Math.floor(Math.random()*sides));
      const total = rls.reduce((a,b)=>a+b,0)+bonus;
      const formula = `${n}d${sides}${bonus?(bonus>=0?'+'+bonus:bonus):''}`;
      setRolls([...rolls, { type: 'ROLL', total, formula, rolls: rls, bonus, by: '.adrev', calc: bonus ? `${rls.reduce((a,b)=>a+b,0)} ${bonus>=0?'+':''}${bonus} = ${total}` : null }]);
    }
    setMsg('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rolls.map((r,i)=><RollCard key={i} roll={r}/>)}
        {LOG_EVENTS.map((e,i)=>(
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '10px 12px', background: 'var(--bg-panel-raised)',
            border: '1px solid var(--border-line)', borderRadius: 2,
            fontFamily: 'var(--font-body)', fontSize: 13,
          }}>
            <Icon name={e.kind === 'rest-short' ? 'moon' : 'sun'} size={14} style={{ color: e.kind==='rest-short' ? 'var(--rune-blue)' : 'var(--rune-violet)', marginTop: 2 }}/>
            <div>
              <div style={{ color: 'var(--text-primary)' }}>{e.text}</div>
              {e.sub && <div style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>{e.sub}</div>}
            </div>
          </div>
        ))}
      </div>
      {/* Input area */}
      <div style={{ borderTop: '1px solid var(--border-line-strong)', padding: 12 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center' }}>
          <button onClick={()=>setMode('IC')} style={{
            padding: '4px 10px', background: mode==='IC' ? 'rgba(224,180,79,.15)' : 'transparent',
            border: `1px solid ${mode==='IC' ? 'var(--accent)' : 'var(--border-line)'}`,
            color: mode==='IC' ? 'var(--accent)' : 'var(--text-muted)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer', textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 4,
          }}><Icon name="masks" size={11}/> IC</button>
          <button onClick={()=>setMode('OOC')} style={{
            padding: '4px 10px', background: mode==='OOC' ? 'rgba(224,180,79,.15)' : 'transparent',
            border: `1px solid ${mode==='OOC' ? 'var(--accent)' : 'var(--border-line)'}`,
            color: mode==='OOC' ? 'var(--accent)' : 'var(--text-muted)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer', textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 4,
          }}><Icon name="chat" size={11}/> OOC</button>
          <div style={{ flex: 1 }}/>
          <button style={{
            padding: '4px 10px', background: 'transparent', border: '1px solid var(--border-line)',
            color: 'var(--text-muted)', fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, cursor: 'pointer', borderRadius: 2, textTransform: 'uppercase',
          }}>Whisper...</button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={msg} onChange={e=>setMsg(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()}
            placeholder="Speak, or /roll 1d20..." style={{
              flex: 1, padding: '8px 12px', background: 'var(--ink-900)',
              border: '1px solid var(--border-line)', color: 'var(--text-primary)',
              fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
            }}/>
          <button onClick={send} style={{
            width: 38, background: 'linear-gradient(180deg, var(--gilt-400), var(--gilt-600))',
            border: '1px solid var(--gilt-700)', color: 'var(--ink-900)',
            cursor: 'pointer', borderRadius: 2, display: 'grid', placeItems: 'center',
          }}><Icon name="send" size={14}/></button>
        </div>
      </div>
    </div>
  );
};

const RollCard = ({ roll }) => (
  <div style={{
    position: 'relative', padding: '12px 14px 12px 18px',
    background: 'linear-gradient(90deg, rgba(224,180,79,.06), transparent 60%)',
    border: '1px solid var(--border-line)',
    borderLeft: '3px solid var(--accent)',
    borderRadius: 2,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <Icon name="d20" size={14} style={{ color: 'var(--accent)' }}/>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)', fontWeight: 600 }}>
        {roll.type}
      </span>
    </div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>
        {roll.total}
      </span>
      {roll.calc && <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-secondary)' }}>{roll.calc}</span>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)' }}>{roll.formula}</span>
      {roll.note && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontStyle: 'italic', color: 'var(--text-muted)' }}>{roll.note}</span>}
      {roll.rolls?.map((r,i)=>(
        <span key={i} style={{
          padding: '2px 8px', minWidth: 24, textAlign: 'center',
          background: r === 1 ? 'rgba(201,66,58,.2)' : 'var(--ink-900)',
          color: r === 1 ? 'var(--danger)' : 'var(--text-primary)',
          border: `1px solid ${r === 1 ? 'var(--danger)' : 'var(--border-line)'}`,
          fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, borderRadius: 2,
        }}>{r}</span>
      ))}
    </div>
    <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
      Rolled by {roll.by}
    </div>
  </div>
);

// Players panel --------------------------------------------------------------
const PlayersPanel = () => (
  <div style={{ padding: 16 }}>
    <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0 }}>Owner</div>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: 12,
      background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line-strong)', borderRadius: 3,
      position: 'relative',
    }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 2px var(--accent)' }}>
        <img src={HERO.avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: 1 }}>.adrev</span>
          <span style={{
            padding: '2px 7px', background: 'rgba(224,180,79,.15)', border: '1px solid var(--accent)',
            color: 'var(--accent)', fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1.5, borderRadius: 2,
            display: 'inline-flex', alignItems: 'center', gap: 3, textTransform: 'uppercase',
          }}><Icon name="crown" size={10}/> Owner</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, color: 'var(--success)', fontSize: 11, fontFamily: 'var(--font-ui)' }}>
          <Icon name="wifi" size={11}/> Online
        </div>
      </div>
    </div>
    <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 20 }}>
      Adventurers <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>(0)</span>
    </div>
    <div style={{
      padding: '24px 16px', textAlign: 'center', fontFamily: 'var(--font-body)',
      fontStyle: 'italic', fontSize: 13, color: 'var(--text-muted)',
      border: '1px dashed var(--border-line)', borderRadius: 3, marginTop: 10,
    }}>
      Share the room seal with thy fellow adventurers to summon them to the table.
    </div>
    <button className="ornate-btn ghost" style={{ width: '100%', marginTop: 12 }}>
      <Icon name="copy" size={12} style={{ marginRight: 6 }}/>Copy Invite Link
    </button>
  </div>
);

Object.assign(window, { CombatPanel, HeroPanel, WikiPanel, NotesPanel, ChatPanel, PlayersPanel, Chip, RollCard });
