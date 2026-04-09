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
const AC_TYPES = ['light', 'medium', 'heavy'];

const WEAPON_PROPERTIES = [
  { name: 'Melee', tip: 'Used in close combat, reach 5ft' },
  { name: 'Ranged', tip: 'Used at distance, requires ammunition or thrown' },
  { name: 'Finesse', tip: 'Use STR or DEX for attack/damage (whichever is higher)' },
  { name: 'Light', tip: 'Small and easy to handle — enables two-weapon fighting' },
  { name: 'Heavy', tip: 'Small creatures have disadvantage on attack rolls' },
  { name: 'Thrown', tip: 'Can be thrown for a ranged attack using STR' },
  { name: 'Reach', tip: 'Adds 5ft to your melee attack range (10ft total)' },
  { name: 'Versatile', tip: 'Can be used one- or two-handed for more damage' },
  { name: 'Two-Handed', tip: 'Requires both hands to attack' },
  { name: 'Ammunition', tip: 'Requires ammunition (arrows, bolts, etc.)' },
  { name: 'Loading', tip: 'Only one attack per action regardless of extra attacks' },
  { name: 'Special', tip: 'Has unique rules described in the item description' },
  { name: 'Silvered', tip: 'Overcomes resistance to nonmagical attacks (lycanthropes, etc.)' },
  { name: 'Magical', tip: 'Counts as magical for overcoming resistance and immunity' },
] as const;

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 12,
  background: theme.bg.deepest, border: `1px solid ${theme.gold.border}`,
  borderRadius: theme.radius.sm, color: theme.text.primary,
  fontFamily: theme.font.body, outline: 'none', boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };

const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: theme.gold.dim,
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3, display: 'block',
};

const fieldGroup: React.CSSProperties = { marginBottom: 8 };

const rowStyle: React.CSSProperties = { display: 'flex', gap: 8 };

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 11, cursor: 'pointer',
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
  const [properties, setProperties] = useState<string[]>([]);
  const [range, setRange] = useState('');
  const [acType, setAcType] = useState('');
  const [stealthDisadvantage, setStealthDisadvantage] = useState(false);
  const [requiresAttunement, setRequiresAttunement] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isWeapon = type === 'weapon';
  const isArmor = type === 'armor' || type === 'shield';

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
          properties: isWeapon ? properties : stealthDisadvantage ? ['Stealth Disadvantage'] : [],
          range: isWeapon && range.trim() ? range.trim() : undefined,
          acType: isArmor && acType ? acType : undefined,
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

  const toggleProperty = (propName: string) => {
    if (properties.includes(propName)) {
      setProperties(properties.filter((p) => p !== propName));
    } else {
      setProperties([...properties, propName]);
    }
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 0, padding: 10,
      background: theme.bg.card, border: `1px solid ${theme.border.default}`,
      borderRadius: theme.radius.md,
    }}>
      {/* ── Header ──────────────────────────────────────────── */}
      <div style={{
        fontSize: 14, fontWeight: 700, color: theme.gold.primary,
        fontFamily: theme.font.display, marginBottom: 10,
      }}>
        Create Custom Item
      </div>

      {/* Name */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Name *</label>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sword of Awesomeness"
        />
      </div>

      {/* Type + Rarity */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Type</label>
          <select style={selectStyle} value={type} onChange={(e) => setType(e.target.value)}>
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>{cap(t)}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Rarity</label>
          <select style={selectStyle} value={rarity} onChange={(e) => setRarity(e.target.value)}>
            {RARITIES.map((r) => (
              <option key={r} value={r}>{cap(r)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Weapon: Damage + Damage Type */}
      {isWeapon && (
        <div style={{ ...fieldGroup, ...rowStyle }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Damage</label>
            <input style={inputStyle} value={damage} onChange={(e) => setDamage(e.target.value)} placeholder="1d8" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Damage Type</label>
            <select style={selectStyle} value={damageType} onChange={(e) => setDamageType(e.target.value)}>
              <option value="">--</option>
              {DAMAGE_TYPES.map((d) => (
                <option key={d} value={d}>{cap(d)}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Weapon: Properties (clickable pill chips) */}
      {isWeapon && (
        <div style={fieldGroup}>
          <label style={labelStyle}>Properties</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {WEAPON_PROPERTIES.map((prop) => {
              const active = properties.includes(prop.name);
              return (
                <button
                  key={prop.name}
                  type="button"
                  title={prop.tip}
                  onClick={() => toggleProperty(prop.name)}
                  style={{
                    padding: '3px 10px',
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: theme.font.body,
                    borderRadius: 20,
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                    border: `1px solid ${active ? theme.gold.primary : theme.border.default}`,
                    background: active ? theme.gold.bg : 'transparent',
                    color: active ? theme.gold.primary : theme.text.muted,
                    outline: 'none',
                  }}
                >
                  {prop.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Weapon: Range */}
      {isWeapon && (
        <div style={{ ...fieldGroup, width: '50%' }}>
          <label style={labelStyle}>Range</label>
          <input style={inputStyle} value={range} onChange={(e) => setRange(e.target.value)} placeholder="80/320" />
        </div>
      )}

      {/* Armor: AC + AC Type */}
      {isArmor && (
        <div style={{ ...fieldGroup, ...rowStyle, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>AC Bonus</label>
            <input style={inputStyle} type="number" value={ac} onChange={(e) => setAc(Number(e.target.value))} />
          </div>
          <div style={{ flex: 1 }}>
            <label
              style={labelStyle}
              title="Light = +DEX mod, Medium = +DEX mod (max 2), Heavy = no DEX mod"
            >
              AC Type
            </label>
            <select style={selectStyle} value={acType} onChange={(e) => setAcType(e.target.value)}>
              <option value="">--</option>
              {AC_TYPES.map((t) => (
                <option key={t} value={t}>{cap(t)}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Armor: Stealth Disadvantage */}
      {isArmor && acType === 'heavy' && (
        <div style={fieldGroup}>
          <button
            type="button"
            title="Heavy armor imposes disadvantage on Dexterity (Stealth) checks"
            onClick={() => setStealthDisadvantage(!stealthDisadvantage)}
            style={{
              padding: '3px 10px', fontSize: 10, fontWeight: 600,
              fontFamily: theme.font.body, borderRadius: 20, cursor: 'pointer',
              border: `1px solid ${stealthDisadvantage ? theme.state.danger : theme.border.default}`,
              background: stealthDisadvantage ? theme.state.dangerBg : 'transparent',
              color: stealthDisadvantage ? theme.state.danger : theme.text.muted,
              outline: 'none',
            }}
          >
            Stealth Disadvantage
          </button>
        </div>
      )}

      {/* Magic bonus + Weight + Value */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label
            style={labelStyle}
            title="Adds +1/+2/+3 to attack and damage rolls"
          >
            Magic +
          </label>
          <input
            style={inputStyle}
            type="number"
            value={magicBonus}
            min={0}
            max={3}
            onChange={(e) => setMagicBonus(Number(e.target.value))}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Weight</label>
          <input
            style={inputStyle}
            type="number"
            value={weight}
            min={0}
            onChange={(e) => setWeight(Number(e.target.value))}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Value (gp)</label>
          <input
            style={inputStyle}
            type="number"
            value={valueGp}
            min={0}
            onChange={(e) => setValueGp(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Attunement */}
      <div style={fieldGroup}>
        <button
          type="button"
          title="Must spend a short rest attuning before the item's magic works"
          onClick={() => setRequiresAttunement(!requiresAttunement)}
          style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 600,
            fontFamily: theme.font.body, borderRadius: 20, cursor: 'pointer',
            border: `1px solid ${requiresAttunement ? theme.purple : theme.border.default}`,
            background: requiresAttunement ? 'rgba(155,89,182,0.15)' : 'transparent',
            color: requiresAttunement ? theme.purple : theme.text.muted,
            outline: 'none',
          }}
        >
          Requires Attunement
        </button>
      </div>

      {/* Description */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Description</label>
        <textarea
          style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the item's properties and lore..."
        />
      </div>

      {/* Error */}
      {error && (
        <div style={{
          fontSize: 11, color: theme.state.danger,
          marginBottom: 8, fontFamily: theme.font.body,
        }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Item'}
        </Button>
      </div>
    </div>
  );
}
