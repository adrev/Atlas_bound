import React, { useState } from 'react';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

interface CreateSpellFormProps {
  sessionId: string;
  onCreated: () => void;
  onCancel: () => void;
}

const SCHOOLS = [
  'abjuration', 'conjuration', 'divination', 'enchantment',
  'evocation', 'illusion', 'necromancy', 'transmutation',
] as const;

const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning',
  'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
] as const;

const ATTACK_TYPES = ['none', 'ranged', 'melee'] as const;
const SAVING_THROWS = ['none', 'str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const AOE_TYPES = ['none', 'sphere', 'cone', 'cube', 'line'] as const;

const CONDITIONS = [
  'none', 'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
  'prone', 'restrained', 'stunned', 'unconscious',
] as const;

const ANIMATION_TYPES = ['auto', 'projectile', 'aoe', 'buff', 'melee'] as const;

// ── Shared styles ───────────────────────────────────────────

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
  display: 'flex', alignItems: 'center', gap: 4,
  fontSize: 12, color: theme.text.secondary,
  fontFamily: theme.font.body, cursor: 'pointer',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: theme.gold.primary,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  margin: '10px 0 6px', fontFamily: theme.font.body,
  borderBottom: `1px solid ${theme.border.default}`,
  paddingBottom: 4,
};

const sectionToggleStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: '6px 0', margin: '4px 0 2px',
  fontSize: 11, fontWeight: 700, color: theme.gold.primary,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  cursor: 'pointer', fontFamily: theme.font.body, textAlign: 'left', width: '100%',
};

// ── Helpers ─────────────────────────────────────────────────

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Component ───────────────────────────────────────────────

export function CreateSpellForm({ sessionId, onCreated, onCancel }: CreateSpellFormProps) {
  // Basic info
  const [name, setName] = useState('');
  const [level, setLevel] = useState(0);
  const [school, setSchool] = useState<string>('evocation');
  const [castingTime, setCastingTime] = useState('1 action');
  const [range, setRange] = useState('30 feet');
  const [components, setComponents] = useState('V, S');
  const [duration, setDuration] = useState('Instantaneous');
  const [concentration, setConcentration] = useState(false);
  const [ritual, setRitual] = useState(false);

  // Combat
  const [damage, setDamage] = useState('');
  const [damageType, setDamageType] = useState('fire');
  const [attackType, setAttackType] = useState('none');
  const [savingThrow, setSavingThrow] = useState('none');
  const [halfOnSave, setHalfOnSave] = useState(false);

  // AoE
  const [aoeType, setAoeType] = useState('none');
  const [aoeSize, setAoeSize] = useState(0);
  const [pushDistance, setPushDistance] = useState(0);

  // Effects
  const [appliesCondition, setAppliesCondition] = useState('none');

  // Animation
  const [animationType, setAnimationType] = useState('auto');
  const [animationColor, setAnimationColor] = useState('');

  // Description
  const [description, setDescription] = useState('');
  const [higherLevels, setHigherLevels] = useState('');
  const [classes, setClasses] = useState('');

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim() !== '' && description.trim() !== '' && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        sessionId,
        name: name.trim(),
        level,
        school,
        castingTime,
        range,
        components,
        duration,
        description: description.trim(),
        concentration,
        ritual,
        damage: damage.trim(),
        damageType,
        savingThrow,
        attackType,
        aoeType,
        aoeSize,
        halfOnSave,
        pushDistance,
        appliesCondition,
        animationType,
        animationColor: animationColor.trim(),
      };

      if (higherLevels.trim()) body.higherLevels = higherLevels.trim();
      if (classes.trim()) body.classes = classes.trim();

      const res = await fetch('/api/custom/spells', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Failed to create spell (${res.status})`);
      }

      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create spell');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex', flexDirection: 'column', gap: 0, padding: 10,
        background: theme.bg.card, border: `1px solid ${theme.border.default}`,
        borderRadius: theme.radius.md,
      }}
    >
      {/* ── Header ──────────────────────────────────────────── */}
      <div style={{
        fontSize: 14, fontWeight: 700, color: theme.gold.primary,
        fontFamily: theme.font.display, marginBottom: 10,
      }}>
        Create Custom Spell
      </div>

      {/* ── Basic Info ──────────────────────────────────────── */}

      {/* Name */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Name *</label>
        <input
          style={inputStyle}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Fireball"
          required
        />
      </div>

      {/* Level + School */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: '0 0 70px' }}>
          <label style={labelStyle}>Level</label>
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={9}
            value={level}
            onChange={(e) => setLevel(Math.min(9, Math.max(0, Number(e.target.value))))}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>School</label>
          <select style={selectStyle} value={school} onChange={(e) => setSchool(e.target.value)}>
            {SCHOOLS.map((s) => (
              <option key={s} value={s}>{cap(s)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Casting Time + Range */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Casting Time</label>
          <input style={inputStyle} type="text" value={castingTime} onChange={(e) => setCastingTime(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Range</label>
          <input style={inputStyle} type="text" value={range} onChange={(e) => setRange(e.target.value)} />
        </div>
      </div>

      {/* Components + Duration */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Components</label>
          <input style={inputStyle} type="text" value={components} onChange={(e) => setComponents(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Duration</label>
          <input style={inputStyle} type="text" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
      </div>

      {/* Concentration + Ritual */}
      <div style={{ ...fieldGroup, display: 'flex', gap: 16, alignItems: 'center' }}>
        <label
          style={checkboxLabelStyle}
          title="You must maintain concentration or the spell ends early"
        >
          <input
            type="checkbox"
            checked={concentration}
            onChange={(e) => setConcentration(e.target.checked)}
            style={{ accentColor: theme.gold.primary }}
          />
          Concentration
        </label>
        <label
          style={checkboxLabelStyle}
          title="Can be cast without a spell slot by spending 10 extra minutes"
        >
          <input
            type="checkbox"
            checked={ritual}
            onChange={(e) => setRitual(e.target.checked)}
            style={{ accentColor: theme.gold.primary }}
          />
          Ritual
        </label>
      </div>

      {/* ── Combat (always visible) ────────────────────────── */}
      <div style={sectionHeaderStyle}>Combat</div>

      {/* Damage + Damage Type */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Damage</label>
          <input
            style={inputStyle}
            type="text"
            value={damage}
            onChange={(e) => setDamage(e.target.value)}
            placeholder="8d6"
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Damage Type</label>
          <select style={selectStyle} value={damageType} onChange={(e) => setDamageType(e.target.value)}>
            {DAMAGE_TYPES.map((t) => (
              <option key={t} value={t}>{cap(t)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Attack Type + Saving Throw + Half on save */}
      <div style={{ ...fieldGroup, ...rowStyle, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Attack Type</label>
          <select style={selectStyle} value={attackType} onChange={(e) => setAttackType(e.target.value)}>
            {ATTACK_TYPES.map((t) => (
              <option key={t} value={t}>{cap(t)}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Saving Throw</label>
          <select style={selectStyle} value={savingThrow} onChange={(e) => setSavingThrow(e.target.value)}>
            {SAVING_THROWS.map((t) => (
              <option key={t} value={t}>{t === 'none' ? 'None' : t.toUpperCase()}</option>
            ))}
          </select>
        </div>
        {savingThrow !== 'none' && (
          <label
            style={{ ...checkboxLabelStyle, whiteSpace: 'nowrap', paddingBottom: 2 }}
            title="Target takes half damage on a successful save"
          >
            <input
              type="checkbox"
              checked={halfOnSave}
              onChange={(e) => setHalfOnSave(e.target.checked)}
              style={{ accentColor: theme.gold.primary }}
            />
            Half on save
          </label>
        )}
      </div>

      {/* AoE: Type + Size + Push — all one row */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label
            style={labelStyle}
            title="Area shape — sphere radiates from a point, cone is a triangle from caster, cube is a box, line is a beam"
          >
            AoE Type
          </label>
          <select style={selectStyle} value={aoeType} onChange={(e) => setAoeType(e.target.value)}>
            {AOE_TYPES.map((t) => (
              <option key={t} value={t}>{cap(t)}</option>
            ))}
          </select>
        </div>
        {aoeType !== 'none' && (
          <>
            <div style={{ flex: '0 0 70px' }}>
              <label style={labelStyle}>Size (ft)</label>
              <input
                style={inputStyle}
                type="number"
                min={0}
                value={aoeSize}
                onChange={(e) => setAoeSize(Math.max(0, Number(e.target.value)))}
                placeholder="20"
              />
            </div>
            <div style={{ flex: '0 0 70px' }}>
              <label
                style={labelStyle}
                title="Pushes affected creatures this many feet away from the point of origin"
              >
                Push (ft)
              </label>
              <input
                style={inputStyle}
                type="number"
                min={0}
                value={pushDistance}
                onChange={(e) => setPushDistance(Math.max(0, Number(e.target.value)))}
                placeholder="0"
              />
            </div>
          </>
        )}
      </div>

      {/* ── Advanced Options (collapsible) ──────────────────── */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        style={sectionToggleStyle}
      >
        {showAdvanced ? '\u25BE' : '\u25B8'} Advanced Options
      </button>
      {showAdvanced && (
        <div style={{ marginBottom: 4 }}>
          {/* Condition on failed save */}
          <div style={fieldGroup}>
            <label
              style={labelStyle}
              title="Automatically applied to targets that fail their saving throw"
            >
              Condition on Failed Save
            </label>
            <select style={selectStyle} value={appliesCondition} onChange={(e) => setAppliesCondition(e.target.value)}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>{cap(c)}</option>
              ))}
            </select>
          </div>

          {/* Animation Type */}
          <div style={fieldGroup}>
            <label
              style={labelStyle}
              title="Visual effect when the spell is cast"
            >
              Animation Type
            </label>
            <select style={selectStyle} value={animationType} onChange={(e) => setAnimationType(e.target.value)}>
              {ANIMATION_TYPES.map((t) => (
                <option key={t} value={t}>{cap(t)}</option>
              ))}
            </select>
          </div>

          {/* Animation Color */}
          <div style={fieldGroup}>
            <label
              style={labelStyle}
              title="Leave empty for auto color based on school"
            >
              Animation Color
            </label>
            <div style={{ ...rowStyle, alignItems: 'center' }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                type="text"
                value={animationColor}
                onChange={(e) => setAnimationColor(e.target.value)}
                placeholder="#ff4500"
              />
              <div style={{
                width: 24, height: 24, borderRadius: theme.radius.sm,
                border: `1px solid ${theme.gold.border}`,
                background: animationColor || 'transparent', flexShrink: 0,
              }} />
            </div>
          </div>
        </div>
      )}

      {/* ── Description ─────────────────────────────────────── */}
      <div style={{ ...sectionHeaderStyle, marginTop: 6 }}>Description</div>

      <div style={fieldGroup}>
        <label style={labelStyle}>Description *</label>
        <textarea
          style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A bright streak flashes from your pointing finger..."
          required
        />
      </div>

      <div style={fieldGroup}>
        <label style={labelStyle}>At Higher Levels</label>
        <textarea
          style={{ ...inputStyle, minHeight: 48, resize: 'vertical' }}
          value={higherLevels}
          onChange={(e) => setHigherLevels(e.target.value)}
          placeholder="When you cast this spell using a spell slot of..."
        />
      </div>

      <div style={fieldGroup}>
        <label style={labelStyle}>Classes (comma-separated)</label>
        <input
          style={inputStyle}
          type="text"
          value={classes}
          onChange={(e) => setClasses(e.target.value)}
          placeholder="Sorcerer, Wizard"
        />
      </div>

      {/* ── Error ───────────────────────────────────────────── */}
      {error && (
        <div style={{
          fontSize: 11, color: theme.state.danger,
          marginBottom: 8, fontFamily: theme.font.body,
        }}>
          {error}
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <Button variant="ghost" onClick={onCancel} type="button">
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!canSubmit}>
          {submitting ? 'Creating...' : 'Create Spell'}
        </Button>
      </div>
    </form>
  );
}
