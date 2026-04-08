import { useState, useEffect, useCallback } from 'react';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { emitTokenAdd } from '../../socket/emitters';

const RARITY_COLORS: Record<string, string> = {
  common: '#9d9d9d', uncommon: '#1eff00', rare: '#0070dd',
  'very rare': '#a335ee', legendary: '#ff8000', artifact: '#e6cc80',
};

interface LootEntry {
  id: string;
  character_id: string;
  item_slug: string | null;
  custom_item_id: string | null;
  item_name: string;
  item_rarity: string;
  quantity: number;
  sort_order: number;
  equipped: boolean;
}

interface SearchResult {
  slug: string;
  name: string;
  type?: string;
  rarity?: string;
}

interface LootEditorProps {
  characterId: string;
  tokenName?: string;
  onClose?: () => void;
}

export function LootEditor({ characterId, tokenName, onClose }: LootEditorProps) {
  const [loot, setLoot] = useState<LootEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customRarity, setCustomRarity] = useState('common');
  const [customType, setCustomType] = useState('gear');
  const [customDamage, setCustomDamage] = useState('');
  const [customDamageType, setCustomDamageType] = useState('');
  const [customProperties, setCustomProperties] = useState<string[]>([]);
  const [customRange, setCustomRange] = useState('');
  const [customWeight, setCustomWeight] = useState('');
  const [customCost, setCustomCost] = useState('');
  const [customAC, setCustomAC] = useState('');
  const [customACType, setCustomACType] = useState('flat');
  const [customStealthDis, setCustomStealthDis] = useState(false);
  const [customStrReq, setCustomStrReq] = useState('');
  const [customMagicBonus, setCustomMagicBonus] = useState('0');
  const [customDesc, setCustomDesc] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const resetCustomForm = () => {
    setCustomName(''); setCustomDesc(''); setCustomDamage(''); setCustomDamageType('');
    setCustomProperties([]); setCustomRange(''); setCustomWeight(''); setCustomCost('');
    setCustomAC(''); setCustomACType('flat'); setCustomStealthDis(false); setCustomStrReq('');
    setCustomMagicBonus('0'); setShowCustom(false);
  };

  const fetchLoot = useCallback(() => {
    fetch(`/api/characters/${characterId}/loot`)
      .then(r => r.ok ? r.json() : [])
      .then(setLoot)
      .catch(() => {});
  }, [characterId]);

  useEffect(() => { fetchLoot(); }, [fetchLoot]);

  useEffect(() => {
    if (searchQuery.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    const timeout = setTimeout(() => {
      fetch(`/api/compendium/search?q=${encodeURIComponent(searchQuery)}&category=items&limit=8`)
        .then(r => r.ok ? r.json() : { results: [] })
        .then(data => { setSearchResults(data.results || []); setSearching(false); })
        .catch(() => { setSearching(false); });
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchQuery]);

  const notifyLootChange = () => window.dispatchEvent(new Event('loot-updated'));
  const sessionId = useSessionStore((s) => s.sessionId);

  // Add a compendium item to loot
  const addItem = async (name: string, slug?: string, rarity?: string) => {
    await fetch(`/api/characters/${characterId}/loot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemName: name, itemSlug: slug || null, itemRarity: rarity || 'common', quantity: 1 }),
    });
    fetchLoot();
    notifyLootChange();
    setSearchQuery('');
    setSearchResults([]);
  };

  // Create a custom item in the DB, then add to loot
  const addCustomItem = async () => {
    if (!customName.trim()) return;
    try {
      // 1. Save to custom_items table
      const resp = await fetch('/api/custom/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId || 'default',
          name: customName.trim(),
          type: customType,
          rarity: customRarity,
          description: customDesc,
          weight: parseFloat(customWeight) || 0,
          valueGp: parseFloat(customCost) || 0,
          damage: customDamage,
          damageType: customDamageType,
          properties: customProperties,
          range: customRange || '',
          ac: parseInt(customAC) || 0,
          acType: customACType || '',
          magicBonus: parseInt(customMagicBonus) || 0,
          requiresAttunement: false,
        }),
      });
      const data = await resp.json();
      const customItemId = data?.id || null;

      // 2. Add to loot with custom_item_id reference
      await fetch(`/api/characters/${characterId}/loot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: customName.trim(),
          customItemId,
          itemRarity: customRarity,
          quantity: 1,
        }),
      });

      fetchLoot();
      notifyLootChange();
      resetCustomForm();
    } catch { /* ignore */ }
  };

  const removeItem = async (entryId: string) => {
    await fetch(`/api/characters/${characterId}/loot/${entryId}`, { method: 'DELETE' });
    fetchLoot();
    notifyLootChange();
  };

  const updateQuantity = async (entryId: string, quantity: number) => {
    if (quantity <= 0) { removeItem(entryId); return; }
    await fetch(`/api/characters/${characterId}/loot/${entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
    fetchLoot();
    notifyLootChange();
  };

  const dropItem = async (entry: LootEntry) => {
    try {
      const mapState = useMapStore.getState();
      const currentMap = mapState.currentMap;
      if (!currentMap) { alert('No map loaded'); return; }
      const tokens = mapState.tokens;
      const creatureToken = Object.values(tokens).find((t: any) => t.characterId === characterId);
      const dropX = creatureToken ? (creatureToken as any).x + 70 : currentMap.width / 2;
      const dropY = creatureToken ? (creatureToken as any).y : currentMap.height / 2;

      // Remove 1 from loot
      if (entry.quantity > 1) {
        await fetch(`/api/characters/${characterId}/loot/${entry.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: entry.quantity - 1 }),
        });
      } else {
        await fetch(`/api/characters/${characterId}/loot/${entry.id}`, { method: 'DELETE' });
      }

      // Create loot bag character
      const charResp = await fetch('/api/characters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'npc', name: entry.item_name, race: 'loot', class: 'bag', level: 1, hitPoints: 0, maxHitPoints: 1, armorClass: 0 }),
      });
      if (!charResp.ok) { console.error('Failed to create loot char'); return; }
      const charData = await charResp.json();
      if (!charData?.id) return;

      // Add item to the new loot bag
      await fetch(`/api/characters/${charData.id}/loot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemName: entry.item_name, itemSlug: entry.item_slug || null, itemRarity: entry.item_rarity || 'common', quantity: 1 }),
      });

      // Spawn token via socket
      const imgUrl = entry.item_slug ? `/uploads/items/${entry.item_slug}.png` : '/uploads/items/default-item.svg';
      console.log('[DROP] Spawning token:', entry.item_name, 'at', dropX, dropY);
      emitTokenAdd({
        mapId: currentMap.id, characterId: charData.id, name: entry.item_name,
        x: dropX, y: dropY, size: 0.5, imageUrl: imgUrl, color: '#d4a843',
        layer: 'token', visible: true, hasLight: false, lightRadius: 0, lightDimRadius: 0, lightColor: '#ffcc44',
        conditions: [], ownerUserId: null,
      });

      fetchLoot();
      notifyLootChange();
    } catch (err) { console.error('Drop failed:', err); }
  };

  const toggleEquipped = async (entryId: string, currentlyEquipped: boolean) => {
    await fetch(`/api/characters/${characterId}/loot/${entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equipped: !currentlyEquipped }),
    });
    fetchLoot();
    notifyLootChange();
  };

  return (
    <div style={S.overlay}>
      {/* Backdrop */}
      <div onClick={onClose} style={S.backdrop} />

      {/* Slide-in panel */}
      <div style={S.panel}>
        {/* Header */}
        <div style={S.header}>
          <div style={S.headerIcon}>
            <img src={`/uploads/tokens/${(tokenName || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.png`}
              alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
              onError={e => { (e.currentTarget).style.display = 'none'; (e.currentTarget.parentElement!).innerHTML = '<span style="font-size:16px">💰</span>'; }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={S.headerTitle}>Edit Loot</div>
            {tokenName && <div style={S.headerSub}>{tokenName}</div>}
          </div>
          <div style={S.lootCount}>{loot.reduce((s, e) => s + e.quantity, 0)} items</div>
          {onClose && (
            <button onClick={onClose} style={S.closeBtn}>&times;</button>
          )}
        </div>

        {/* Search Section */}
        <div style={S.searchSection}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setShowCustom(false); }}
              placeholder="Search compendium items..."
              style={{ ...S.searchInput, flex: 1 }}
            />
            <button
              onClick={() => setShowCustom(!showCustom)}
              title="Create custom item"
              style={{
                padding: '8px 12px', fontSize: 14, fontWeight: 700,
                background: showCustom ? theme.gold.bg : theme.bg.elevated,
                border: `1px solid ${showCustom ? theme.gold.border : theme.border.default}`,
                borderRadius: 8, color: showCustom ? theme.gold.primary : theme.text.secondary,
                cursor: 'pointer', fontFamily: theme.font.body, flexShrink: 0,
              }}
            >+</button>
          </div>

          {/* Search results dropdown */}
          {searchResults.length > 0 && !showCustom && (
            <div style={S.searchDropdown}>
              {searchResults.map(r => (
                <div key={r.slug} style={S.searchItem}
                  onClick={() => addItem(r.name, r.slug, r.rarity)}
                  onMouseEnter={e => (e.currentTarget.style.background = theme.bg.hover)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <img src={`/uploads/items/${r.slug}.png`} alt="" loading="lazy"
                    style={S.searchItemImg}
                    onError={e => { (e.currentTarget).src = '/uploads/items/default-item.svg'; }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: RARITY_COLORS[r.rarity?.toLowerCase() || 'common'] || theme.text.primary }}>
                      {r.name}
                    </div>
                    {r.type && <div style={{ fontSize: 9, color: theme.text.muted }}>{r.type}{r.rarity ? ` \u2022 ${r.rarity}` : ''}</div>}
                  </div>
                  <div style={S.addBadge}>Add</div>
                </div>
              ))}
            </div>
          )}

          {searching && <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 4 }}>Searching...</div>}

          {/* Custom item creation panel */}
          {showCustom && (
            <div style={{
              marginTop: 8, padding: 12, borderRadius: 8,
              background: theme.bg.card, border: `1px solid ${theme.border.default}`,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: theme.gold.dim, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Create Custom Item
              </div>
              <input
                type="text" value={customName} onChange={e => setCustomName(e.target.value)}
                placeholder="Item name..." autoFocus
                style={{ ...S.searchInput, marginBottom: 6 }}
              />
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <select value={customType} onChange={e => setCustomType(e.target.value)} style={{ ...S.raritySelect, flex: 1 }}>
                  {['gear', 'weapon', 'armor', 'shield', 'potion', 'scroll', 'treasure', 'currency'].map(t =>
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  )}
                </select>
                <select value={customRarity} onChange={e => setCustomRarity(e.target.value)}
                  style={{ ...S.raritySelect, flex: 1, color: RARITY_COLORS[customRarity] || theme.text.primary }}>
                  {Object.keys(RARITY_COLORS).map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>

              {/* Weapon fields */}
              {customType === 'weapon' && (<>
                <div style={S.fieldLabel}>Base Weapon (auto-fills stats)</div>
                <select
                  onChange={e => {
                    const presets: Record<string, { damage: string; damageType: string; properties: string[]; range?: string; weight: string; cost: string }> = {
                      '': { damage: '', damageType: '', properties: [], weight: '', cost: '' },
                      'dagger': { damage: '1d4', damageType: 'piercing', properties: ['Finesse', 'Light', 'Thrown'], range: '20/60', weight: '1', cost: '2' },
                      'shortsword': { damage: '1d6', damageType: 'piercing', properties: ['Finesse', 'Light'], weight: '2', cost: '10' },
                      'longsword': { damage: '1d8', damageType: 'slashing', properties: ['Versatile'], weight: '3', cost: '15' },
                      'rapier': { damage: '1d8', damageType: 'piercing', properties: ['Finesse'], weight: '2', cost: '25' },
                      'greatsword': { damage: '2d6', damageType: 'slashing', properties: ['Heavy', 'Two-Handed'], weight: '6', cost: '50' },
                      'greataxe': { damage: '1d12', damageType: 'slashing', properties: ['Heavy', 'Two-Handed'], weight: '7', cost: '30' },
                      'battleaxe': { damage: '1d8', damageType: 'slashing', properties: ['Versatile'], weight: '4', cost: '10' },
                      'warhammer': { damage: '1d8', damageType: 'bludgeoning', properties: ['Versatile'], weight: '2', cost: '15' },
                      'handaxe': { damage: '1d6', damageType: 'slashing', properties: ['Light', 'Thrown'], range: '20/60', weight: '2', cost: '5' },
                      'mace': { damage: '1d6', damageType: 'bludgeoning', properties: [], weight: '4', cost: '5' },
                      'spear': { damage: '1d6', damageType: 'piercing', properties: ['Thrown', 'Versatile'], range: '20/60', weight: '3', cost: '1' },
                      'longbow': { damage: '1d8', damageType: 'piercing', properties: ['Ammunition', 'Heavy', 'Two-Handed'], range: '150/600', weight: '2', cost: '50' },
                      'shortbow': { damage: '1d6', damageType: 'piercing', properties: ['Ammunition', 'Two-Handed'], range: '80/320', weight: '2', cost: '25' },
                      'crossbow-light': { damage: '1d8', damageType: 'piercing', properties: ['Ammunition', 'Loading', 'Two-Handed'], range: '80/320', weight: '5', cost: '25' },
                      'scimitar': { damage: '1d6', damageType: 'slashing', properties: ['Finesse', 'Light'], weight: '3', cost: '25' },
                    };
                    const p = presets[e.target.value];
                    if (p) {
                      setCustomDamage(p.damage);
                      setCustomDamageType(p.damageType);
                      setCustomProperties(p.properties);
                      setCustomRange(p.range || '');
                      setCustomWeight(p.weight);
                      setCustomCost(p.cost);
                    }
                  }}
                  style={{ ...S.raritySelect, marginBottom: 6 }}
                >
                  <option value="">— Select base weapon to auto-fill —</option>
                  <option value="dagger">Dagger (1d4 piercing, Finesse/Light/Thrown)</option>
                  <option value="shortsword">Shortsword (1d6 piercing, Finesse/Light)</option>
                  <option value="rapier">Rapier (1d8 piercing, Finesse)</option>
                  <option value="scimitar">Scimitar (1d6 slashing, Finesse/Light)</option>
                  <option value="longsword">Longsword (1d8 slashing, Versatile)</option>
                  <option value="battleaxe">Battleaxe (1d8 slashing, Versatile)</option>
                  <option value="warhammer">Warhammer (1d8 bludgeoning, Versatile)</option>
                  <option value="greatsword">Greatsword (2d6 slashing, Heavy/Two-Handed)</option>
                  <option value="greataxe">Greataxe (1d12 slashing, Heavy/Two-Handed)</option>
                  <option value="mace">Mace (1d6 bludgeoning)</option>
                  <option value="spear">Spear (1d6 piercing, Thrown/Versatile)</option>
                  <option value="handaxe">Handaxe (1d6 slashing, Light/Thrown)</option>
                  <option value="longbow">Longbow (1d8 piercing, Ammunition/Heavy)</option>
                  <option value="shortbow">Shortbow (1d6 piercing, Ammunition)</option>
                  <option value="crossbow-light">Light Crossbow (1d8 piercing, Ammunition/Loading)</option>
                </select>
                <div style={{ fontSize: 9, color: theme.text.muted, marginBottom: 6, fontStyle: 'italic' }}>
                  Pick a base weapon, then modify the stats below. Finesse weapons use DEX instead of STR for attacks.
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <div style={{ flex: 2 }}><div style={S.fieldLabel}>Magic Bonus (+X to hit and damage)</div>
                    <select value={customMagicBonus} onChange={e => setCustomMagicBonus(e.target.value)} style={S.raritySelect}>
                      <option value="0">None (mundane)</option>
                      <option value="1">+1 (uncommon)</option>
                      <option value="2">+2 (rare)</option>
                      <option value="3">+3 (very rare)</option>
                    </select>
                  </div>
                </div>
                <div style={S.fieldLabel}>Damage</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <select value={customDamage} onChange={e => setCustomDamage(e.target.value)} style={{ ...S.raritySelect, flex: 1 }}>
                    <option value="">— dice —</option>
                    {['1', '1d4', '1d6', '1d8', '1d10', '1d12', '2d6', '2d8', '2d10', '2d12', '3d6'].map(d =>
                      <option key={d} value={d}>{d}</option>
                    )}
                  </select>
                  <select value={customDamageType} onChange={e => setCustomDamageType(e.target.value)} style={{ ...S.raritySelect, flex: 1 }}>
                    <option value="">— type —</option>
                    {['slashing', 'piercing', 'bludgeoning', 'fire', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'force', 'psychic'].map(t =>
                      <option key={t} value={t}>{t}</option>
                    )}
                  </select>
                </div>
                <div style={S.fieldLabel}>Properties</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {([
                    ['Finesse', 'Use STR or DEX for attack and damage rolls (your choice)'],
                    ['Light', 'Can be used for two-weapon fighting (dual wield)'],
                    ['Heavy', 'Small creatures have disadvantage on attacks'],
                    ['Two-Handed', 'Requires both hands to wield'],
                    ['Versatile', 'Can use one or two hands (two-handed deals more damage)'],
                    ['Thrown', 'Can throw for a ranged attack using STR'],
                    ['Reach', 'Adds 5 ft to your melee attack range (10 ft total)'],
                    ['Ammunition', 'Requires ammo to fire, has a normal/long range'],
                    ['Loading', 'Only one attack per action, even with Extra Attack'],
                    ['Special', 'Has unique rules — describe in the description field'],
                  ] as [string, string][]).map(([p, desc]) => (
                    <button key={p} title={desc} onClick={() => {
                      setCustomProperties(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
                    }} style={{
                      padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                      fontFamily: theme.font.body,
                      background: customProperties.includes(p) ? theme.gold.bg : 'transparent',
                      border: `1px solid ${customProperties.includes(p) ? theme.gold.border : theme.border.default}`,
                      color: customProperties.includes(p) ? theme.gold.primary : theme.text.muted,
                    }}>{p}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  {(customProperties.includes('Thrown') || customProperties.includes('Ammunition')) && (
                    <div style={{ flex: 1 }}>
                      <div style={S.fieldLabel}>Range (ft)</div>
                      <input type="text" value={customRange} onChange={e => setCustomRange(e.target.value)}
                        placeholder="e.g. 20/60" style={S.raritySelect} />
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>Weight (lb)</div>
                    <input type="number" value={customWeight} onChange={e => setCustomWeight(e.target.value)}
                      placeholder="0" style={S.raritySelect} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>Cost (gp)</div>
                    <input type="number" value={customCost} onChange={e => setCustomCost(e.target.value)}
                      placeholder="0" style={S.raritySelect} />
                  </div>
                </div>
              </>)}

              {/* Armor fields */}
              {(customType === 'armor' || customType === 'shield') && (<>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>{customType === 'shield' ? 'AC Bonus' : 'Base AC'}</div>
                    <input type="number" value={customAC} onChange={e => setCustomAC(e.target.value)}
                      placeholder={customType === 'shield' ? '2' : '14'} style={S.raritySelect} />
                  </div>
                  {customType === 'armor' && (
                    <div style={{ flex: 1 }}>
                      <div style={S.fieldLabel}>AC Type</div>
                      <select value={customACType} onChange={e => setCustomACType(e.target.value)} style={S.raritySelect}>
                        <option value="flat">Flat (heavy)</option>
                        <option value="dex">+ Dex (light)</option>
                        <option value="dex-max-2">+ Dex max 2 (medium)</option>
                      </select>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>Weight (lb)</div>
                    <input type="number" value={customWeight} onChange={e => setCustomWeight(e.target.value)}
                      placeholder="0" style={S.raritySelect} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>Cost (gp)</div>
                    <input type="number" value={customCost} onChange={e => setCustomCost(e.target.value)}
                      placeholder="0" style={S.raritySelect} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <label style={{ fontSize: 10, color: theme.text.muted, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="checkbox" checked={customStealthDis} onChange={e => setCustomStealthDis(e.target.checked)} />
                    Stealth Disadvantage
                  </label>
                  {customType === 'armor' && (
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 10, color: theme.text.muted }}>Str Req: </span>
                      <input type="number" value={customStrReq} onChange={e => setCustomStrReq(e.target.value)}
                        placeholder="0" style={{ ...S.raritySelect, width: 40 }} />
                    </div>
                  )}
                </div>
              </>)}

              {/* Common fields for all types */}
              {customType !== 'weapon' && customType !== 'armor' && customType !== 'shield' && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>Weight (lb)</div>
                    <input type="number" value={customWeight} onChange={e => setCustomWeight(e.target.value)}
                      placeholder="0" style={S.raritySelect} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={S.fieldLabel}>Cost (gp)</div>
                    <input type="number" value={customCost} onChange={e => setCustomCost(e.target.value)}
                      placeholder="0" style={S.raritySelect} />
                  </div>
                </div>
              )}

              <textarea
                value={customDesc} onChange={e => setCustomDesc(e.target.value)}
                placeholder="Description (optional, supports markdown)..."
                rows={3}
                style={{ ...S.searchInput, resize: 'vertical', marginBottom: 8, minHeight: 50, fontFamily: theme.font.body }}
              />
              <button onClick={addCustomItem} style={{ ...S.addBtn, width: '100%' }}
              >Add to Loot</button>
            </div>
          )}
        </div>

        {/* Loot List */}
        <div style={S.lootList}>
          {loot.length === 0 ? (
            <div style={S.emptyState}>
              <div style={{ fontSize: 24, marginBottom: 6 }}>💰</div>
              <div>No loot yet</div>
              <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 2 }}>Search items above or add custom loot</div>
            </div>
          ) : (
            loot.map(entry => (
              <div key={entry.id} style={S.lootItem}>
                <button
                  onClick={() => toggleEquipped(entry.id, entry.equipped)}
                  title={entry.equipped ? 'Equipped — click to unequip' : 'Not equipped — click to equip'}
                  style={{
                    width: 20, height: 20, borderRadius: 4, flexShrink: 0, cursor: 'pointer',
                    border: entry.equipped ? `2px solid ${theme.gold.primary}` : `2px solid ${theme.border.default}`,
                    background: entry.equipped ? theme.gold.bg : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, color: entry.equipped ? theme.gold.primary : theme.text.muted,
                    padding: 0, transition: 'all 0.15s',
                  }}
                >
                  {entry.equipped ? 'E' : ''}
                </button>
                <img src={`/uploads/items/${entry.item_slug || ''}.png`} alt="" loading="lazy"
                  style={S.lootItemImg}
                  onError={e => { (e.currentTarget).src = '/uploads/items/default-item.svg'; }}
                />
                <div
                  style={{ flex: 1, minWidth: 0, cursor: entry.item_slug ? 'pointer' : 'default' }}
                  onClick={() => {
                    if (entry.item_slug) {
                      window.dispatchEvent(new CustomEvent('open-compendium-detail', {
                        detail: { slug: entry.item_slug, category: 'items', name: entry.item_name },
                      }));
                    }
                  }}
                >
                  <div style={{
                    fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: RARITY_COLORS[entry.item_rarity?.toLowerCase()] || theme.text.primary,
                  }}>{entry.item_name}</div>
                  <div style={{ fontSize: 8, color: theme.text.muted, textTransform: 'capitalize' }}>
                    {entry.item_rarity}{entry.equipped ? ' \u2022 Equipped' : ''}
                  </div>
                </div>
                <div style={S.qtyControls}>
                  <button onClick={() => updateQuantity(entry.id, entry.quantity - 1)} style={S.qtyBtn}>-</button>
                  <span style={S.qtyValue}>{entry.quantity}</span>
                  <button onClick={() => updateQuantity(entry.id, entry.quantity + 1)} style={S.qtyBtn}>+</button>
                </div>
                <button onClick={() => dropItem(entry)} title="Drop on map"
                  style={{ ...S.removeBtn, background: theme.gold.bg, border: `1px solid ${theme.gold.border}`, color: theme.gold.primary }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12l7 7 7-7"/>
                  </svg>
                </button>
                <button onClick={() => removeItem(entry.id)} title="Delete" style={S.removeBtn}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// --- Styles using app theme ---
const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 10000,
    display: 'flex', justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
  },
  panel: {
    position: 'relative', width: 380, maxWidth: '90vw', height: '100%',
    background: theme.bg.base, borderLeft: `1px solid ${theme.border.default}`,
    boxShadow: '-8px 0 32px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column',
    fontFamily: theme.font.body, color: theme.text.primary,
    animation: 'slideInRight 0.2s ease-out',
  },
  header: {
    padding: '12px 16px', borderBottom: `1px solid ${theme.border.default}`,
    background: theme.bg.card, display: 'flex', alignItems: 'center', gap: 10,
  },
  headerIcon: {
    width: 36, height: 36, borderRadius: '50%', overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: theme.bg.elevated, border: `2px solid ${theme.gold.border}`,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 15, fontWeight: 700, color: theme.text.primary,
    fontFamily: theme.font.display,
  },
  headerSub: { fontSize: 11, color: theme.text.secondary, marginTop: 1 },
  lootCount: {
    fontSize: 10, color: theme.gold.dim, fontWeight: 600,
    background: theme.gold.bg, padding: '2px 8px', borderRadius: 10,
    border: `1px solid ${theme.gold.border}`,
  },
  closeBtn: {
    background: 'none', border: 'none', color: theme.text.muted, fontSize: 20,
    cursor: 'pointer', padding: '0 4px', lineHeight: 1,
  },

  searchSection: {
    padding: '10px 16px', borderBottom: `1px solid ${theme.border.default}`,
  },
  searchInput: {
    width: '100%', padding: '8px 12px', fontSize: 13, boxSizing: 'border-box' as const,
    background: theme.bg.deep, border: `1px solid ${theme.border.default}`, borderRadius: 8,
    color: theme.text.primary, outline: 'none', fontFamily: theme.font.body,
  },
  searchDropdown: {
    marginTop: 6, maxHeight: 200, overflowY: 'auto' as const,
    borderRadius: 8, border: `1px solid ${theme.border.default}`,
    background: theme.bg.card,
  },
  searchItem: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    cursor: 'pointer', transition: 'background 0.1s',
  },
  searchItemImg: {
    width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' as const,
    flexShrink: 0, border: `1.5px solid ${theme.border.default}`,
  },
  addBadge: {
    fontSize: 9, fontWeight: 700, color: theme.gold.primary,
    background: theme.gold.bg, padding: '2px 8px', borderRadius: 4,
    border: `1px solid ${theme.gold.border}`, textTransform: 'uppercase' as const,
    letterSpacing: '0.04em', flexShrink: 0,
  },

  fieldLabel: {
    fontSize: 9, fontWeight: 700, color: theme.text.muted,
    textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 3,
  },
  raritySelect: {
    padding: '6px 8px', fontSize: 11,
    background: theme.bg.deep, border: `1px solid ${theme.border.default}`, borderRadius: 6,
    outline: 'none', fontFamily: theme.font.body,
  },
  addBtn: {
    padding: '6px 12px', fontSize: 13, fontWeight: 700,
    background: theme.gold.bg, border: `1px solid ${theme.gold.border}`,
    borderRadius: 6, color: theme.gold.primary, cursor: 'pointer', fontFamily: theme.font.body,
  },

  lootList: {
    flex: 1, overflowY: 'auto' as const, padding: '8px 16px',
  },
  emptyState: {
    fontSize: 12, color: theme.text.secondary, textAlign: 'center' as const,
    padding: 32, fontStyle: 'italic',
  },
  lootItem: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
    borderBottom: `1px solid ${theme.border.default}`,
  },
  lootItemImg: {
    width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' as const,
    flexShrink: 0, border: `1.5px solid ${theme.border.default}`,
  },
  qtyControls: {
    display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
  },
  qtyBtn: {
    width: 22, height: 22, fontSize: 12, fontWeight: 700,
    background: theme.bg.elevated, border: `1px solid ${theme.border.default}`, borderRadius: 4,
    color: theme.text.secondary, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
  },
  qtyValue: {
    fontSize: 13, fontWeight: 700, minWidth: 24, textAlign: 'center' as const,
  },
  removeBtn: {
    width: 22, height: 22,
    background: 'rgba(197,49,49,0.1)', border: `1px solid rgba(197,49,49,0.3)`,
    borderRadius: 4, color: '#c53131', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    flexShrink: 0,
  },
};
