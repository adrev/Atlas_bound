import React, { useState } from 'react';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

interface CreateSpellFormProps {
  sessionId: string;
  onCreated: () => void;
  onCancel: () => void;
}

const SCHOOLS = [
  'abjuration',
  'conjuration',
  'divination',
  'enchantment',
  'evocation',
  'illusion',
  'necromancy',
  'transmutation',
] as const;

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

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: theme.text.secondary,
  marginBottom: 2,
  fontFamily: theme.font.body,
};

const fieldGroup: React.CSSProperties = {
  marginBottom: 8,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
};

export function CreateSpellForm({ sessionId, onCreated, onCancel }: CreateSpellFormProps) {
  const [name, setName] = useState('');
  const [level, setLevel] = useState(0);
  const [school, setSchool] = useState<string>('evocation');
  const [castingTime, setCastingTime] = useState('1 action');
  const [range, setRange] = useState('30 feet');
  const [components, setComponents] = useState('V, S');
  const [duration, setDuration] = useState('Instantaneous');
  const [concentration, setConcentration] = useState(false);
  const [ritual, setRitual] = useState(false);
  const [description, setDescription] = useState('');
  const [higherLevels, setHigherLevels] = useState('');
  const [classes, setClasses] = useState('');
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
      };

      if (higherLevels.trim()) {
        body.higherLevels = higherLevels.trim();
      }
      if (classes.trim()) {
        body.classes = classes.trim();
      }

      const res = await fetch(`/api/custom/spells`, {
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
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        padding: 10,
        background: theme.bg.card,
        border: `1px solid ${theme.border.default}`,
        borderRadius: theme.radius.md,
      }}
    >
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
          <select
            style={{ ...inputStyle, cursor: 'pointer' }}
            value={school}
            onChange={(e) => setSchool(e.target.value)}
          >
            {SCHOOLS.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Casting Time + Range */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Casting Time</label>
          <input
            style={inputStyle}
            type="text"
            value={castingTime}
            onChange={(e) => setCastingTime(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Range</label>
          <input
            style={inputStyle}
            type="text"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          />
        </div>
      </div>

      {/* Components + Duration */}
      <div style={{ ...fieldGroup, ...rowStyle }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Components</label>
          <input
            style={inputStyle}
            type="text"
            value={components}
            onChange={(e) => setComponents(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Duration</label>
          <input
            style={inputStyle}
            type="text"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
      </div>

      {/* Concentration + Ritual checkboxes */}
      <div style={{ ...fieldGroup, display: 'flex', gap: 16, alignItems: 'center' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: theme.text.secondary,
            fontFamily: theme.font.body,
            cursor: 'pointer',
          }}
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
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: theme.text.secondary,
            fontFamily: theme.font.body,
            cursor: 'pointer',
          }}
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

      {/* Description */}
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

      {/* Higher Levels */}
      <div style={fieldGroup}>
        <label style={labelStyle}>At Higher Levels</label>
        <textarea
          style={{ ...inputStyle, minHeight: 48, resize: 'vertical' }}
          value={higherLevels}
          onChange={(e) => setHigherLevels(e.target.value)}
          placeholder="When you cast this spell using a spell slot of..."
        />
      </div>

      {/* Classes */}
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

      {/* Error */}
      {error && (
        <div
          style={{
            fontSize: 11,
            color: '#e55',
            marginBottom: 8,
            fontFamily: theme.font.body,
          }}
        >
          {error}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
