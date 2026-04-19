// ========== Modals: Map Browser, Upload, Character Sheet ==========

const MapBrowserModal = ({ onClose, onOpenUpload }) => {
  const [cat, setCat] = React.useState('All');
  const cats = ['All', 'Combat / Encounters', 'Dungeon / Lairs', 'Social / City', 'Rest / Camp'];
  const maps = cat === 'All' ? MAPS : MAPS.filter(m => m.category === cat.split(' ')[0]);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ width: 820, maxWidth: '90vw' }} onClick={e=>e.stopPropagation()}>
        <CornerFiligree className="corner tl"/>
        <CornerFiligree className="corner tr"/>
        <div className="modal-head">
          <div className="modal-title">Map Library</div>
          <button className="ornate-btn" onClick={onOpenUpload}><Icon name="plus" size={12} style={{ marginRight: 6 }}/>Upload Custom</button>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <p style={{ padding: '0 20px', fontFamily: 'var(--font-body)', fontStyle: 'italic', color: 'var(--text-secondary)', margin: '12px 0 0' }}>
          Select a pre-built map or upload your own.
        </p>
        <div className="modal-body">
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 8 }}>Recent Maps (1)</div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: 10, marginBottom: 16,
            background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 3,
          }}>
            <img src={MAPS[0].img} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 2 }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-primary)', letterSpacing: 1 }}>{MAPS[0].name}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>{MAPS[0].grid} grid</div>
            </div>
            <button className="ornate-btn ghost" style={{ padding: '6px 14px' }}>Load</button>
          </div>

          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 8 }}>Pre-Built Maps</div>
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <Icon name="search" size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }}/>
            <input placeholder="Search by name or description..." style={{
              width: '100%', padding: '8px 12px 8px 32px', background: 'var(--bg-panel-raised)',
              border: '1px solid var(--border-line)', color: 'var(--text-primary)',
              fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
            }}/>
            <span style={{ position: 'absolute', right: 10, top: 10, fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>62 maps</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {cats.map(c=>(
              <button key={c} onClick={()=>setCat(c)} style={{
                padding: '5px 12px', borderRadius: 14,
                border: `1px solid ${cat === c ? 'var(--accent)' : 'var(--border-line)'}`,
                background: cat === c ? 'rgba(224,180,79,.12)' : 'transparent',
                color: cat === c ? 'var(--accent)' : 'var(--text-secondary)',
                fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1, cursor: 'pointer', textTransform: 'uppercase',
              }}>{c}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            {maps.map((m,i)=>(
              <div key={i} style={{
                background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)',
                borderRadius: 3, overflow: 'hidden', cursor: 'pointer', transition: 'all .15s',
              }}
                onMouseEnter={e=>{ e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={e=>{ e.currentTarget.style.borderColor = 'var(--border-line)'; e.currentTarget.style.transform = 'none'; }}>
                <img src={m.img} style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}/>
                <div style={{ padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)', letterSpacing: .5 }}>{m.name}</span>
                    <span style={{
                      padding: '1px 6px', background: 'rgba(201,66,58,.15)', color: 'var(--danger)',
                      border: '1px solid var(--danger)', fontFamily: 'var(--font-display)', fontSize: 8, letterSpacing: 1, borderRadius: 2, textTransform: 'uppercase',
                    }}>{m.category}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontStyle: 'italic', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const UploadModal = ({ onClose }) => (
  <div className="modal-scrim" onClick={onClose}>
    <div className="modal" style={{ width: 460 }} onClick={e=>e.stopPropagation()}>
      <div className="modal-head">
        <div className="modal-title">Upload Custom Map</div>
        <button className="icon-btn" onClick={onClose}><Icon name="x" size={16}/></button>
      </div>
      <div className="modal-body">
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 6 }}>Map Image</div>
        <div style={{
          display: 'flex', gap: 8, padding: 10, background: 'var(--ink-900)',
          border: '1px dashed var(--border-line-strong)', borderRadius: 2, alignItems: 'center',
        }}>
          <button className="ornate-btn ghost" style={{ padding: '6px 12px' }}>Choose File</button>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No file chosen</span>
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>JPG, PNG, or WebP up to 20 MB</div>

        <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', marginTop: 16, marginBottom: 6 }}>Map Name</div>
        <input placeholder="Enter map name..." style={{
          width: '100%', padding: '8px 10px', background: 'var(--ink-900)',
          border: '1px solid var(--border-line)', color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
        }}/>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="ornate-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ornate-btn">Create Map</button>
        </div>
      </div>
    </div>
  </div>
);

const CreatureBrowserModal = ({ onClose }) => {
  const types = ['All', 'Aberration', 'Beast', 'Celestial', 'Construct', 'Dragon', 'Elemental', 'Fey', 'Fiend', 'Giant', 'Humanoid', 'Monstrosity', 'Ooze', 'Plant', 'Undead'];
  const [type, setType] = React.useState('All');
  const [cr, setCr] = React.useState('All CR');
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ width: 540, maxHeight: '85vh' }} onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Bestiary</div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <Icon name="search" size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }}/>
            <input placeholder="Search 3,200+ creatures..." style={{
              width: '100%', padding: '8px 12px 8px 32px', background: 'var(--bg-panel-raised)',
              border: '1px solid var(--border-line)', color: 'var(--text-primary)',
              fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
            }}/>
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
            {types.map(t=>(
              <button key={t} onClick={()=>setType(t)} style={{
                padding: '3px 10px', borderRadius: 12,
                border: `1px solid ${type === t ? 'var(--accent)' : 'var(--border-line)'}`,
                background: type === t ? 'rgba(224,180,79,.12)' : 'transparent',
                color: type === t ? 'var(--accent)' : 'var(--text-secondary)',
                fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1, cursor: 'pointer', textTransform: 'uppercase',
              }}>{t}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {['All CR', 'CR 0-1', 'CR 2-5', 'CR 6-10', 'CR 11+'].map(c=>(
              <button key={c} onClick={()=>setCr(c)} style={{
                padding: '3px 10px', borderRadius: 12,
                border: `1px solid ${cr === c ? 'var(--accent)' : 'var(--border-line)'}`,
                background: cr === c ? 'rgba(224,180,79,.12)' : 'transparent',
                color: cr === c ? 'var(--accent)' : 'var(--text-secondary)',
                fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1, cursor: 'pointer', textTransform: 'uppercase',
              }}>{c}</button>
            ))}
          </div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 8 }}>{CREATURES.length} creatures</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {CREATURES.map((c,i)=>(
              <div key={i} style={{
                display: 'flex', alignItems: 'stretch',
                background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 3,
                overflow: 'hidden',
              }}>
                <img src={c.avatar} style={{ width: 56, objectFit: 'cover' }}/>
                <div style={{ flex: 1, padding: '8px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: 1 }}>{c.name}</div>
                    <div style={{ display: 'flex', gap: 10, fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>
                      <span>HP <b style={{ color: 'var(--text-primary)', fontSize: 13 }}>{c.hp}</b></span>
                      <span>AC <b style={{ color: 'var(--text-primary)', fontSize: 13 }}>{c.ac}</b></span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <Chip variant="tag">{c.type}</Chip>
                    <Chip variant="dmg">CR {c.cr}</Chip>
                    <span style={{
                      padding: '1px 6px', background: 'rgba(90,160,90,.15)', border: '1px solid var(--success)',
                      color: 'var(--success)', fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: .5, borderRadius: 2,
                    }}>Lv {c.lvl}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button className="ornate-btn ghost" style={{ padding: '4px 10px', fontSize: 9, flex: 1 }}>View Full Stats</button>
                    <button className="ornate-btn" style={{ padding: '4px 10px', fontSize: 9, flex: 1 }}>Add to Map</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============ Full character sheet modal (tome spread) ============
const CharacterSheetModal = ({ onClose, initialTab = 'INVENTORY' }) => {
  const [tab, setTab] = React.useState(initialTab);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ width: 1080, maxWidth: '95vw', height: '90vh' }} onClick={e=>e.stopPropagation()}>
        <CornerFiligree className="corner tl"/>
        <CornerFiligree className="corner tr"/>
        <CornerFiligree className="corner bl"/>
        <CornerFiligree className="corner br"/>
        <div style={{ display: 'flex', height: '100%' }}>
          <SheetLeftColumn/>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border-line-strong)' }}>
            <SheetHeader onClose={onClose}/>
            <SheetStats/>
            <SheetTabs tab={tab} setTab={setTab}/>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
              {tab === 'ACTIONS' && <ActionsTab/>}
              {tab === 'SPELLS' && <SpellsTab/>}
              {tab === 'INVENTORY' && <InventoryTab/>}
              {tab === 'FEATURES & TRAITS' && <TraitsTab/>}
              {tab === 'BACKGROUND' && <BackgroundTab/>}
              {tab === 'NOTES' && <NotesTab/>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const SheetLeftColumn = () => (
  <div style={{ width: 220, flex: '0 0 220px', padding: 16, overflowY: 'auto' }}>
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 8 }}>Saving Throws</div>
    {Object.keys(HERO.saves).map(k=>(
      <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px dashed var(--border-line)' }}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: HERO.savesProf[k] ? 'var(--accent)' : 'transparent',
          border: `1.5px solid ${HERO.savesProf[k] ? 'var(--accent)' : 'var(--border-line-strong)'}`,
        }}/>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 1, color: 'var(--text-primary)', flex: 1 }}>{k}</span>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--accent)', fontSize: 13 }}>{HERO.saves[k] >= 0 ? '+' : ''}{HERO.saves[k]}</span>
      </div>
    ))}
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', margin: '16px 0 8px' }}>Skills</div>
    {HERO.skills.map((s,i)=>(
      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%',
          background: s[4] ? 'var(--accent)' : s[3] ? 'rgba(224,180,79,.5)' : 'transparent',
          border: `1.5px solid ${s[3] ? 'var(--accent)' : 'var(--border-line-strong)'}`,
        }}/>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{s[0]}</span>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>{s[1]}</span>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--accent)', fontWeight: 600, minWidth: 22, textAlign: 'right' }}>{s[2] >= 0 ? '+' : ''}{s[2]}</span>
      </div>
    ))}
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', margin: '16px 0 8px' }}>Passive Scores</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4 }}>
      {Object.entries(HERO.passive).map(([k,v])=>(
        <div key={k} style={{
          padding: '6px 4px', background: 'var(--bg-panel-raised)',
          border: '1px solid var(--border-line)', borderRadius: 2, textAlign: 'center',
        }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{v}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 8, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>{k.slice(0,6)}</div>
        </div>
      ))}
    </div>
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase', margin: '16px 0 6px' }}>Senses</div>
    <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>{HERO.senses}</div>
  </div>
);

const SheetHeader = ({ onClose }) => (
  <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16, borderBottom: '1px solid var(--border-line)' }}>
    <div style={{ width: 72, height: 72, borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 2px var(--accent), 0 0 0 3px var(--bg-panel-raised), 0 0 18px rgba(224,180,79,.35)' }}>
      <img src={HERO.avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
    </div>
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 700, color: 'var(--accent)', letterSpacing: 2 }}>{HERO.name}</div>
      <div style={{ fontFamily: 'var(--font-body)', fontStyle: 'italic', fontSize: 14, color: 'var(--text-secondary)' }}>{HERO.race} {HERO.class} {HERO.level}</div>
    </div>
    <button className="ornate-btn ghost" style={{ padding: '8px 14px' }}><Icon name="moon" size={12} style={{ marginRight: 6 }}/>Short Rest</button>
    <button className="ornate-btn ghost" style={{ padding: '8px 14px' }}><Icon name="sun" size={12} style={{ marginRight: 6 }}/>Long Rest</button>
    <button className="icon-btn" onClick={onClose}><Icon name="x" size={18}/></button>
  </div>
);

const SheetStats = () => (
  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-line)' }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8,1fr)', gap: 6 }}>
      {Object.entries(HERO.stats).map(([k,v])=>(
        <div key={k} style={{
          padding: '10px 4px', textAlign: 'center',
          background: 'var(--bg-panel-raised)', border: '1px solid var(--danger)', borderRadius: 3,
        }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--danger)' }}>{k}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: '2px 0' }}>{v >= 0 ? '+' : ''}{v}</div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)' }}>{HERO.rawStats[k]}</div>
        </div>
      ))}
      <div style={{ padding: '10px 4px', textAlign: 'center', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line-strong)', borderRadius: 3 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--text-muted)' }}>PROF</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>+{HERO.prof}</div>
      </div>
      <div style={{ padding: '10px 4px', textAlign: 'center', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line-strong)', borderRadius: 3 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--text-muted)' }}>SPEED</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{HERO.spd}</div>
      </div>
    </div>
    {/* HP + small chips */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
      <Icon name="heart" size={18} style={{ color: 'var(--danger)' }}/>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--text-secondary)' }}>HP</span>
      <div style={{ flex: 1, height: 12, background: 'var(--ink-900)', border: '1px solid var(--border-line)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${HERO.hp/HERO.hpMax*100}%`, height: '100%', background: 'linear-gradient(90deg,#5aa05a,#7dc77d)' }}/>
      </div>
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{HERO.hp} / {HERO.hpMax}</span>
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <div style={{ padding: '6px 12px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1.5, color: 'var(--text-muted)' }}>INITIATIVE</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>+{HERO.init}</div>
      </div>
      <div style={{ padding: '6px 12px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1.5, color: 'var(--text-muted)' }}>AC</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{HERO.ac}</div>
      </div>
      {HERO.resist.map(r=>(
        <span key={r} style={{
          padding: '4px 10px', background: 'rgba(106,169,209,.12)', border: '1px solid var(--rune-blue)',
          color: 'var(--rune-blue)', fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 1, borderRadius: 2,
          display: 'inline-flex', alignItems: 'center',
        }}>Resist: {r}</span>
      ))}
    </div>
  </div>
);

const SheetTabs = ({ tab, setTab }) => {
  const tabs = ['ACTIONS', 'SPELLS', 'INVENTORY', 'FEATURES & TRAITS', 'BACKGROUND', 'NOTES'];
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border-line)' }}>
      {tabs.map(t=>(
        <button key={t} onClick={()=>setTab(t)} style={{
          flex: 1, padding: '12px 4px', background: 'transparent', border: 'none',
          fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
          color: tab === t ? 'var(--danger)' : 'var(--text-muted)',
          borderBottom: tab === t ? '2px solid var(--danger)' : '2px solid transparent',
          cursor: 'pointer', transition: 'color .15s',
        }}>{t}</button>
      ))}
    </div>
  );
};

const InventoryTab = () => {
  const [sub, setSub] = React.useState('ALL');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {['ALL', 'EQUIPMENT', 'BACKPACK', 'ATTUNEMENT'].map(s=>(
          <button key={s} onClick={()=>setSub(s)} style={{
            padding: '6px 14px', background: sub === s ? 'rgba(201,66,58,.15)' : 'transparent',
            border: `1px solid ${sub === s ? 'var(--danger)' : 'var(--border-line)'}`,
            color: sub === s ? 'var(--danger)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, cursor: 'pointer', borderRadius: 2,
          }}>{s}</button>
        ))}
      </div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        Weight: <b style={{ color: 'var(--text-secondary)' }}>87.5 lb</b> · Currency: <b style={{ color: 'var(--accent)' }}>27 GP</b> <span style={{ color: 'var(--text-muted)' }}>(0pp, 27gp, 0ep, 0sp, 0cp)</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {HERO.inventory.map(it=>(
          <div key={it.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
            background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2,
          }}>
            {it.equipped ? (
              <span style={{
                width: 18, height: 18, display: 'grid', placeItems: 'center',
                background: 'var(--danger)', color: '#fff',
                fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, borderRadius: 2,
              }}>E</span>
            ) : (
              <span style={{ width: 18, height: 18, border: '1.5px solid var(--border-line-strong)', borderRadius: 2 }}/>
            )}
            <span style={{
              width: 30, height: 30, borderRadius: '50%',
              background: `radial-gradient(circle at 35% 35%, ${it.color}, #000 80%)`,
              color: 'var(--parch-100)', display: 'grid', placeItems: 'center',
              fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12,
              border: '1px solid var(--border-line-strong)',
            }}>{it.letter}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)', letterSpacing: .5 }}>{it.name}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: it.type.includes('weapon') ? 'var(--danger)' : 'var(--text-muted)', fontStyle: 'italic' }}>{it.type}</div>
            </div>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>x{it.qty}</span>
            <Icon name="chevron-down" size={14} style={{ color: 'var(--text-muted)' }}/>
          </div>
        ))}
      </div>
    </div>
  );
};

const ActionsTab = () => {
  const [sub, setSub] = React.useState('ALL');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {['ALL', 'ATTACK', 'ACTION', 'BONUS ACTION', 'REACTION', 'OTHER', 'LIMITED USE'].map(s=>(
          <button key={s} onClick={()=>setSub(s)} style={{
            padding: '6px 12px', background: sub === s ? 'rgba(201,66,58,.15)' : 'transparent',
            border: `1px solid ${sub === s ? 'var(--danger)' : 'var(--border-line)'}`,
            color: sub === s ? 'var(--danger)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, cursor: 'pointer', borderRadius: 2,
          }}>{s}</button>
        ))}
      </div>
      <div className="section-title" style={{ padding: '0 0 6px' }}>Weapons</div>
      {HERO.attacks.map((a,i)=>(
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6,
          background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2,
        }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-primary)', letterSpacing: 1, minWidth: 70 }}>{a.name}</span>
          <Chip variant="spell">DEX (FINESSE)</Chip>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>{a.tags.map(t=><Chip key={t} variant="tag">{t}</Chip>)}</div>
          <div style={{ flex: 1 }}/>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>5 ft.</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>+4</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)' }}>1d4+2</span>
          <button style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer' }}>ATK</button>
          <button style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer' }}>DMG</button>
        </div>
      ))}
      <div className="section-title" style={{ padding: '12px 0 6px' }}>Spell Attacks</div>
      {[
        { name: 'Vicious Mockery', kind: 'Enchantment cantrip', range: '60 ft', info: 'DC 13 WIS', dmg: '1d6 psychic', btn: 'DMG' },
        { name: 'Poison Spray', kind: 'Necromancy cantrip', range: '30 ft', info: '+5', dmg: '1d12 poison', btn: 'ATK+DMG' },
      ].map((s,i)=>(
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6,
          background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2,
        }}>
          <div style={{ minWidth: 140 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-primary)' }}>{s.name}</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>{s.kind}</div>
          </div>
          <div style={{ flex: 1 }}/>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>{s.range}</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--accent)' }}>{s.info}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)' }}>{s.dmg}</span>
          <button style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer' }}>{s.btn}</button>
        </div>
      ))}
      <div className="section-title" style={{ padding: '12px 0 6px' }}>Class Abilities</div>
      <div style={{ padding: 10, background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2, marginBottom: 6 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)' }}>Darkvision <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>Tiefling</span></div>
      </div>
      <div style={{ padding: 10, background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)' }}>Otherworldly Presence <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>Tiefling</span></div>
      </div>
    </div>
  );
};

const SpellsTab = () => (
  <div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr) auto auto', gap: 10, marginBottom: 14, alignItems: 'center' }}>
      <div style={{ padding: '10px 14px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)' }}>MODIFIER</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>+3</div>
      </div>
      <div style={{ padding: '10px 14px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)' }}>SPELL ATTACK</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>+5</div>
      </div>
      <div style={{ padding: '10px 14px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)' }}>SAVE DC</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>13</div>
      </div>
      <button className="ornate-btn ghost" style={{ padding: '8px 12px' }}>DM Override Off</button>
      <button className="ornate-btn" style={{ padding: '8px 14px' }}><Icon name="plus" size={12} style={{ marginRight: 4 }}/>Add Spell</button>
    </div>
    <input placeholder="Search spells..." style={{
      width: '100%', padding: '8px 12px', background: 'var(--bg-panel-raised)',
      border: '1px solid var(--border-line)', color: 'var(--text-primary)',
      fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none', marginBottom: 14,
    }}/>
    <div className="section-title" style={{ padding: '0 0 6px', justifyContent: 'space-between' }}>
      <span>Cantrips</span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>At Will</span>
    </div>
    {HERO.cantrips.map((c,i)=>(
      <div key={i} style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 4,
        background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2,
      }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: `radial-gradient(circle at 35% 35%, ${SPELLS_WIKI[i%SPELLS_WIKI.length].color}, #000 80%)`, boxShadow: `0 0 10px ${SPELLS_WIKI[i%SPELLS_WIKI.length].color}44` }}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)' }}>{c.name}</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>{c.school} {c.info && ` · ${c.info}`}{c.dmg && ` · ${c.dmg}`}</div>
        </div>
        <button style={{ padding: '4px 14px', background: 'rgba(158,123,198,.15)', border: '1px solid rgba(158,123,198,.5)', color: '#c9a9e8', fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer' }}>CAST</button>
      </div>
    ))}
    <div style={{ display: 'flex', gap: 6, margin: '14px 0 10px' }}>
      <button style={{ padding: '6px 14px', background: 'rgba(201,66,58,.15)', border: '1px solid var(--danger)', color: 'var(--danger)', fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer' }}>ALL</button>
      <button style={{ padding: '6px 14px', background: 'transparent', border: '1px solid var(--border-line)', color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 1.5, borderRadius: 2, cursor: 'pointer' }}>1ST</button>
    </div>
  </div>
);

const TraitsTab = () => {
  const [sub, setSub] = React.useState('ALL');
  const [open, setOpen] = React.useState(0);
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {['ALL', 'CLASS FEATURES', 'SPECIES TRAITS', 'FEATS'].map(s=>(
          <button key={s} onClick={()=>setSub(s)} style={{
            padding: '6px 12px', background: sub === s ? 'rgba(201,66,58,.15)' : 'transparent',
            border: `1px solid ${sub === s ? 'var(--danger)' : 'var(--border-line)'}`,
            color: sub === s ? 'var(--danger)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, cursor: 'pointer', borderRadius: 2,
          }}>{s}</button>
        ))}
      </div>
      {HERO.traits.map((t,i)=>(
        <div key={i} onClick={()=>setOpen(open === i ? -1 : i)} style={{
          padding: '10px 14px', marginBottom: 4, cursor: 'pointer',
          background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2,
          display: 'flex', alignItems: 'center',
        }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)', letterSpacing: .5, flex: 1 }}>
            {t.name} <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', fontWeight: 400 }}>{t.source}</span>
          </span>
          <Icon name={open === i ? 'chevron-down' : 'chevron-right'} size={14} style={{ color: 'var(--text-muted)' }}/>
        </div>
      ))}
    </div>
  );
};

const BackgroundTab = () => (
  <div>
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: 2, color: 'var(--danger)', textTransform: 'uppercase' }}>Background: {HERO.background.name}</div>
    <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 8 }} className="drop-cap">
      {HERO.background.desc}
    </p>
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: 2, color: 'var(--danger)', textTransform: 'uppercase', marginTop: 20 }}>Characteristics</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
      <div style={{ padding: '10px 14px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)' }}>ALIGNMENT</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-primary)', marginTop: 2 }}>{HERO.background.alignment}</div>
      </div>
      <div style={{ padding: '10px 14px', background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line)', borderRadius: 2 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)' }}>SIZE</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-primary)', marginTop: 2 }}>{HERO.background.size}</div>
      </div>
    </div>
  </div>
);

const NotesTab = () => (
  <div>
    {['Organizations', 'Allies', 'Enemies', 'Backstory'].map(k=>(
      <div key={k} style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--danger)', textTransform: 'uppercase', marginBottom: 4 }}>{k}</div>
        <textarea placeholder={`${k}...`} rows={3} style={{
          width: '100%', padding: 10, background: 'var(--bg-panel-raised)',
          border: '1px solid var(--border-line)', color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none', resize: 'vertical',
        }}/>
      </div>
    ))}
  </div>
);

Object.assign(window, { MapBrowserModal, UploadModal, CreatureBrowserModal, CharacterSheetModal });
