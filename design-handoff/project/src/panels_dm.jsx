// ========== DM Tools panels ==========

const ToolsPanel = ({ onOpenMaps, onOpenCreatures }) => {
  const [sub, setSub] = React.useState('maps'); // maps, creatures, encounters, settings, handouts, music
  const tools = [
    { id: 'maps', label: 'Maps', icon: 'map' },
    { id: 'creatures', label: 'Creatures', icon: 'swords' },
    { id: 'encounters', label: 'Encounters', icon: 'd6' },
    { id: 'settings', label: 'Settings', icon: 'gear' },
    { id: 'handouts', label: 'Handouts', icon: 'parchment' },
    { id: 'music', label: 'Music', icon: 'music' },
  ];
  return (
    <div style={{ padding: 16 }}>
      <div className="big-title" style={{ padding: '0 0 12px' }}>
        <Icon name="masks" size={22}/> DM Tools
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
        {tools.map(t=>(
          <button key={t.id} onClick={()=>{
            setSub(t.id);
            if (t.id === 'creatures') onOpenCreatures?.();
          }} style={{
            padding: '14px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            background: sub === t.id ? 'linear-gradient(180deg, rgba(224,180,79,.10), transparent)' : 'var(--bg-panel-raised)',
            border: sub === t.id ? '1px solid var(--accent)' : '1px solid var(--border-line)',
            borderRadius: 3, cursor: 'pointer',
            color: sub === t.id ? 'var(--accent)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase',
            transition: 'all .15s',
          }}>
            <Icon name={t.icon} size={26}/>
            {t.label}
          </button>
        ))}
      </div>

      <FlourishDivider/>

      {sub === 'maps' && (
        <div>
          <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <Icon name="masks" size={14} style={{ marginRight: 4 }}/>Scenes & Maps
          </div>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-secondary)', fontStyle: 'italic', marginTop: 0 }}>
            Manage map layers, preview scenes, or add a new map to the campaign.
          </p>
          <button className="ornate-btn" style={{ width: '100%', marginTop: 10 }} onClick={onOpenMaps}>
            Open Map Library
          </button>
        </div>
      )}

      {sub === 'settings' && <SettingsSection/>}
      {sub === 'handouts' && <HandoutsSection/>}
      {sub === 'music' && <MusicSection/>}
      {sub === 'encounters' && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          No encounters drafted. Scribe a new foe...
        </div>
      )}
    </div>
  );
};

const SettingsSection = () => (
  <div>
    <div className="big-title" style={{ padding: '0 0 8px' }}>Session Privacy</div>
    <p style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', marginTop: 0 }}>
      Private sessions require either a password or a DM-only invite seal.
    </p>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
      <button className="ornate-btn ghost" style={{ padding: 10 }}>Public</button>
      <button className="ornate-btn" style={{ padding: 10 }}>Private</button>
    </div>
    <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)', marginTop: 16, marginBottom: 6, textTransform: 'uppercase' }}>Invite Link</div>
    <div style={{ display: 'flex', gap: 4 }}>
      <input readOnly value="https://kbrt.ai/join/suGTpGKPskr6XJvwsqzO" style={{
        flex: 1, padding: '8px 10px', background: 'var(--ink-900)', border: '1px solid var(--border-line)',
        color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', fontSize: 11, borderRadius: 2,
      }}/>
      <button className="ornate-btn ghost" style={{ padding: '6px 12px' }}>Copy</button>
    </div>
    <p style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
      Any bearer of this link may join without the password.
    </p>
    <button className="ornate-btn ghost" style={{ width: '100%', padding: 10, marginTop: 6 }}>Regenerate Invite Link</button>

    <div style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 2, color: 'var(--accent)', marginTop: 16, marginBottom: 6, textTransform: 'uppercase' }}>Password</div>
    <div style={{ display: 'flex', gap: 4 }}>
      <input placeholder="New password, 4+ chars" style={{
        flex: 1, padding: '8px 10px', background: 'var(--ink-900)', border: '1px solid var(--border-line)',
        color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', fontSize: 12, borderRadius: 2, outline: 'none',
      }}/>
      <button className="ornate-btn ghost" style={{ padding: '6px 14px' }}>Set</button>
    </div>
    <button className="ornate-btn ghost" style={{ width: '100%', padding: 10, marginTop: 6 }}>Remove Password</button>

    <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--danger)' }}>
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 0 }}>
        Deleting the session removes every map, token, and note. Transfer ownership instead if you wish to step away.
      </p>
      <button style={{
        width: '100%', padding: 10,
        background: 'linear-gradient(180deg, var(--blood-400), var(--blood-600))',
        border: '1px solid #3a0c08', color: '#fff', cursor: 'pointer', borderRadius: 2,
        fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', fontWeight: 700,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.2)',
      }}>Delete Session</button>
    </div>
  </div>
);

const HandoutsSection = () => (
  <div>
    <div style={{
      background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line-strong)', borderRadius: 3,
      padding: 14, position: 'relative',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)', textTransform: 'uppercase' }}>Send Handout</span>
        <Icon name="x" size={14} style={{ color: 'var(--text-muted)', cursor: 'pointer' }}/>
      </div>
      <input placeholder="Handout title..." style={{
        width: '100%', padding: '8px 10px', marginBottom: 8, background: 'var(--ink-900)',
        border: '1px solid var(--border-line)', color: 'var(--text-primary)',
        fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
      }}/>
      <textarea placeholder="Content (optional)..." rows={4} style={{
        width: '100%', padding: '8px 10px', marginBottom: 8, background: 'var(--ink-900)',
        border: '1px solid var(--border-line)', color: 'var(--text-primary)', resize: 'vertical',
        fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
      }}/>
      <input placeholder="Image URL (optional)..." style={{
        width: '100%', padding: '8px 10px', marginBottom: 10, background: 'var(--ink-900)',
        border: '1px solid var(--border-line)', color: 'var(--text-primary)',
        fontFamily: 'var(--font-body)', fontSize: 13, borderRadius: 2, outline: 'none',
      }}/>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 16, height: 16, background: 'var(--accent)', border: '1px solid var(--gilt-700)', display: 'grid', placeItems: 'center', color: '#000', fontWeight: 900, fontSize: 12 }}>✓</span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-secondary)' }}>Send to all players</span>
      </label>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontStyle: 'italic', color: 'var(--text-muted)', marginBottom: 8 }}>No players connected</div>
      <button className="ornate-btn" style={{ width: '100%' }}><Icon name="send" size={12} style={{ marginRight: 6 }}/>Send</button>
    </div>
  </div>
);

const MusicSection = () => {
  const [playing, setPlaying] = React.useState(true);
  const [selected, setSelected] = React.useState('Combat');
  return (
    <div>
      <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0 }}>Themes</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
        {MUSIC_THEMES.map(t=>(
          <button key={t.name} onClick={()=>setSelected(t.name)} style={{
            padding: '14px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            background: selected === t.name ? 'linear-gradient(180deg, rgba(224,180,79,.10), transparent)' : 'var(--bg-panel-raised)',
            border: selected === t.name ? '1px solid var(--accent)' : '1px solid var(--border-line)',
            borderRadius: 3, cursor: 'pointer', color: selected === t.name ? 'var(--accent)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase',
          }}>
            <Icon name={t.icon} size={20}/> {t.name}
          </button>
        ))}
      </div>

      <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 20 }}>Now Playing</div>
      <div style={{
        background: 'var(--bg-panel-raised)', border: '1px solid var(--border-line-strong)',
        borderRadius: 3, padding: 14,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="x" size={14} style={{ color: 'var(--text-muted)' }}/>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text-primary)', letterSpacing: 1 }}>Combat I</span>
          </div>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>0:11 / 1:49</span>
        </div>
        <div style={{ position: 'relative', height: 6, background: 'var(--ink-900)', borderRadius: 3, marginBottom: 10 }}>
          <div style={{ width: '10%', height: '100%', background: 'var(--accent)', borderRadius: 3 }}/>
          <div style={{ position: 'absolute', left: '10%', top: '50%', transform: 'translate(-50%,-50%)', width: 12, height: 12, borderRadius: '50%', background: 'var(--rune-blue)', boxShadow: '0 0 8px var(--rune-blue)' }}/>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="icon-btn" style={{ width: 30, height: 30 }}><Icon name="skip-back" size={14}/></button>
          <button onClick={()=>setPlaying(!playing)} className="icon-btn" style={{ width: 30, height: 30 }}>
            <Icon name={playing ? 'pause' : 'play'} size={14}/>
          </button>
          <button className="icon-btn" style={{ width: 30, height: 30 }}><Icon name="skip-forward" size={14}/></button>
          <button className="icon-btn" style={{ width: 30, height: 30 }}><Icon name="stop" size={14}/></button>
          <button className="icon-btn" style={{ width: 30, height: 30 }}><Icon name="shuffle" size={14}/></button>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="volume" size={14} style={{ color: 'var(--accent)' }}/>
            <div style={{ flex: 1, height: 4, background: 'var(--ink-900)', borderRadius: 2 }}>
              <div style={{ width: '80%', height: '100%', background: 'var(--accent)' }}/>
            </div>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)' }}>80%</span>
          </div>
        </div>
      </div>

      <div className="section-title" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 16 }}>Playlist</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {PLAYLIST.map((p,i)=>(
          <div key={p} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
            background: i === 0 ? 'linear-gradient(90deg, rgba(224,180,79,.10), transparent)' : 'transparent',
            borderLeft: i === 0 ? '2px solid var(--accent)' : '2px solid transparent',
            cursor: 'pointer',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: i === 0 ? 'var(--accent)' : 'transparent',
              border: `1px solid ${i === 0 ? 'var(--accent)' : 'var(--border-line)'}`,
              boxShadow: i === 0 ? '0 0 6px var(--accent)' : 'none',
            }}/>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: i === 0 ? 'var(--accent)' : 'var(--text-secondary)', letterSpacing: 1 }}>{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, { ToolsPanel });
