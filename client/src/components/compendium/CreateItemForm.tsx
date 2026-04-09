import { useState } from 'react';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

interface CreateItemFormProps {
  sessionId: string;
  onCreated: () => void;
  onCancel: () => void;
}

const ITEM_TYPES = ['weapon', 'armor', 'shield', 'gear', 'potion', 'scroll', 'wand', 'ring', 'wondrous'];
const RARITIES = ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'];
const DAMAGE_TYPES = ['bludgeoning', 'piercing', 'slashing', 'fire', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'force', 'psychic'];

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  background: theme.bg.deepest,
  border: `1px solid ${theme.gold.border}`,
  borderRadius: theme.radius.sm,
  color: theme.text.primary,
  fontFamily: theme.font.body,
  outline: 'none',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: theme.gold.dim,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 3,
  display: 'block',
};

export function CreateItemForm({ sessionId, onCreated, onCancel }: CreateItemFormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState('gear');
  const [rarity, setRarity] = useState('common');
  const [description, setDescription] = useState('');
  const [damage, setDamage] = useState('');
  const [damageType, setDamageType] = useState('');
  const [ac, setAc] = useState(0);
  const [weight, setWeight] = useState(0);
  const [valueGp, setValueGp] = useState(0);
  const [magicBonus, setMagicBonus] = useState(0);
  const [requiresAttunement, setRequiresAttunement] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSubmitting(true);
    setError('');
    try {
      const resp = await fetch('/api/custom/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          name: name.trim(),
          type,
          rarity,
          description: description.trim(),
          damage: damage.trim() || undefined,
          damageType: damageType || undefined,
          ac: ac || undefined,
          weight: weight || undefined,
          valueGp: valueGp || undefined,
          magicBonus: magicBonus || undefined,
          requiresAttunement,
          properties: [],
        }),
      });
      if (!resp.ok) throw new Error('Failed');
      onCreated();
    } catch {
      setError('Failed to create item');
    } finally {
      setSubmitting(false);
    }
  };

  const isWeapon = type === 'weapon';
  const isArmor = type === 'armor' || type === 'shield';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: theme.gold.primary }}>
        Create Custom Item
      </div>

      {/* Name */}
      <div>
        <label style={labelStyle}>Name *</label>
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sword of Awesomeness" />
      </div>

      {/* Type + Rarity */}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Type</label>
          <select style={selectStyle} value={type} onChange={(e) => setType(e.target.value)}>
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Rarity</label>
          <select style={selectStyle} value={rarity} onChange={(e) => setRarity(e.target.value)}>
            {RARITIES.map((r) => (
              <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Weapon fields */}
      {isWeapon && (
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Damage</label>
            <input style={inputStyle} value={damage} onChange={(e) => setDamage(e.target.value)} placeholder="1d8" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Damage Type</label>
            <select style={selectStyle} value={damageType} onChange={(e) => setDamageType(e.target.value)}>
              <option value="">—</option>
              {DAMAGE_TYPES.map((d) => (
                <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Armor fields */}
      {isArmor && (
        <div style={{ width: '50%' }}>
          <label style={labelStyle}>AC Bonus</label>
          <input style={inputStyle} type="number" value={ac} onChange={(e) => setAc(Number(e.target.value))} />
        </div>
      )}

      {/* Magic bonus + weight + value */}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Magic +</label>
          <input style={inputStyle} type="number" value={magicBonus} min={0} max={3} onChange={(e) => setMagicBonus(Number(e.target.value))} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Weight</label>
          <input style={inputStyle} type="number" value={weight} min={0} onChange={(e) => setWeight(Number(e.target.value))} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Value (gp)</label>
          <input style={inputStyle} type="number" value={valueGp} min={0} onChange={(e) => setValueGp(Number(e.target.value))} />
        </div>
      </div>

      {/* Attunement */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: theme.text.secondary, cursor: 'pointer' }}>
        <input type="checkbox" checked={requiresAttunement} onChange={(e) => setRequiresAttunement(e.target.checked)} />
        Requires Attunement
      </label>

      {/* Description */}
      <div>
        <label style={labelStyle}>Description</label>
        <textarea
          style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the item's properties and lore..."
        />
      </div>

      {error && <div style={{ fontSize: 11, color: theme.state.danger }}>{error}</div>}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button variant="primary" size="sm" fullWidth onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Item'}
        </Button>
        <Button variant="ghost" size="sm" fullWidth onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
