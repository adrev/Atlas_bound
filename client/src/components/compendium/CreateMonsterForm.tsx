import { useState, type CSSProperties, type FormEvent } from 'react';
import { theme } from '../../styles/theme';
import { Button, TextInput, NumberInput, Textarea, Select, FieldGroup } from '../ui';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CreateMonsterFormProps {
  sessionId: string;
  onCreated: () => void;
  onCancel: () => void;
}

interface ActionEntry {
  name: string;
  desc: string;
}

const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const;
const TYPES = [
  'aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental',
  'fey', 'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant', 'undead',
] as const;

const ABILITY_NAMES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const ABILITY_LABELS: Record<string, string> = {
  str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA',
};

const SPEED_TYPES = ['walk', 'fly', 'swim', 'burrow', 'climb'] as const;
const SPEED_LABELS: Record<string, string> = {
  walk: 'Walk', fly: 'Fly', swim: 'Swim', burrow: 'Burrow', climb: 'Climb',
};

function crToNumeric(cr: string): number {
  if (cr.includes('/')) {
    const [num, den] = cr.split('/');
    return parseInt(num) / parseInt(den);
  }
  return parseFloat(cr) || 0;
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
  background: theme.bg.card,
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.border.default}`,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-end',
  flexWrap: 'wrap',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontFamily: theme.font.body,
  color: theme.text.secondary,
  marginBottom: 2,
};

const sectionHeading: CSSProperties = {
  fontSize: 11,
  fontFamily: theme.font.display,
  color: theme.gold.primary,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  margin: '4px 0 2px',
};

const errorText: CSSProperties = {
  fontSize: 11,
  color: theme.text.muted,
  fontFamily: theme.font.body,
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function CreateMonsterForm({ sessionId, onCreated, onCancel }: CreateMonsterFormProps) {
  // Basic info
  const [name, setName] = useState('');
  const [size, setSize] = useState('Medium');
  const [type, setType] = useState('humanoid');
  const [alignment, setAlignment] = useState('unaligned');
  const [cr, setCr] = useState('0');

  // Combat
  const [ac, setAc] = useState(10);
  const [hp, setHp] = useState(10);
  const [hitDice, setHitDice] = useState('1d8');
  const [speeds, setSpeeds] = useState<Record<string, number>>({
    walk: 30, fly: 0, swim: 0, burrow: 0, climb: 0,
  });

  // Abilities
  const [abilities, setAbilities] = useState<Record<string, number>>({
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
  });

  // Flavor
  const [description, setDescription] = useState('');
  const [senses, setSenses] = useState('');
  const [languages, setLanguages] = useState('');

  // Actions, special abilities & legendary actions
  const [actions, setActions] = useState<ActionEntry[]>([{ name: '', desc: '' }]);
  const [specialAbilities, setSpecialAbilities] = useState<ActionEntry[]>([]);
  const [legendaryActions, setLegendaryActions] = useState<ActionEntry[]>([]);

  // Resistances & immunities
  const [damageResistances, setDamageResistances] = useState('');
  const [damageImmunities, setDamageImmunities] = useState('');
  const [conditionImmunities, setConditionImmunities] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  /* ---- helpers ---- */

  function setAbility(key: string, val: number) {
    setAbilities(prev => ({ ...prev, [key]: val }));
  }

  function setSpeed(key: string, val: number) {
    setSpeeds(prev => ({ ...prev, [key]: val }));
  }

  function updateAction(idx: number, field: 'name' | 'desc', val: string) {
    setActions(prev => prev.map((a, i) => (i === idx ? { ...a, [field]: val } : a)));
  }

  function removeAction(idx: number) {
    setActions(prev => prev.filter((_, i) => i !== idx));
  }

  function updateSpecial(idx: number, field: 'name' | 'desc', val: string) {
    setSpecialAbilities(prev => prev.map((a, i) => (i === idx ? { ...a, [field]: val } : a)));
  }

  function removeSpecial(idx: number) {
    setSpecialAbilities(prev => prev.filter((_, i) => i !== idx));
  }

  function updateLegendary(idx: number, field: 'name' | 'desc', val: string) {
    setLegendaryActions(prev => prev.map((a, i) => (i === idx ? { ...a, [field]: val } : a)));
  }

  function removeLegendary(idx: number) {
    setLegendaryActions(prev => prev.filter((_, i) => i !== idx));
  }

  function resetForm() {
    setName(''); setSize('Medium'); setType('humanoid'); setAlignment('unaligned');
    setCr('0'); setAc(10); setHp(10); setHitDice('1d8');
    setSpeeds({ walk: 30, fly: 0, swim: 0, burrow: 0, climb: 0 });
    setAbilities({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
    setDescription(''); setSenses(''); setLanguages('');
    setActions([{ name: '', desc: '' }]); setSpecialAbilities([]); setLegendaryActions([]);
    setDamageResistances(''); setDamageImmunities(''); setConditionImmunities('');
    setError('');
  }

  /* ---- submit ---- */

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }

    setSubmitting(true);
    setError('');

    // Build speed object with only non-zero values
    const speedObj: Record<string, number> = {};
    for (const [k, v] of Object.entries(speeds)) {
      if (v > 0) speedObj[k] = v;
    }

    const body = {
      sessionId,
      name: name.trim(),
      size,
      type,
      alignment: alignment.trim() || 'unaligned',
      armorClass: ac,
      hitPoints: hp,
      hitDice,
      speed: speedObj,
      abilityScores: abilities,
      challengeRating: cr,
      crNumeric: crToNumeric(cr),
      actions: actions.filter(a => a.name.trim()),
      specialAbilities: specialAbilities.filter(a => a.name.trim()),
      legendaryActions: legendaryActions.filter(a => a.name.trim()),
      damageResistances: damageResistances.trim(),
      damageImmunities: damageImmunities.trim(),
      conditionImmunities: conditionImmunities.trim(),
      description: description.trim(),
      senses: senses.trim(),
      languages: languages.trim(),
    };

    try {
      const res = await fetch('/api/custom/monsters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Server error ${res.status}`);
      }
      resetForm();
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create monster.');
    } finally {
      setSubmitting(false);
    }
  }

  /* ---- render helpers ---- */

  function renderActionRows(
    items: ActionEntry[],
    update: (i: number, f: 'name' | 'desc', v: string) => void,
    remove: (i: number) => void,
    add: () => void,
    label: string,
  ) {
    return (
      <div>
        <div style={sectionHeading}>{label}</div>
        {items.map((item, i) => (
          <div key={i} style={{ ...rowStyle, marginBottom: 4, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 30%' }}>
              <TextInput
                size="sm"
                placeholder="Name"
                value={item.name}
                onChange={e => update(i, 'name', e.target.value)}
              />
            </div>
            <div style={{ flex: '2 1 55%' }}>
              <TextInput
                size="sm"
                placeholder="Description"
                value={item.desc}
                onChange={e => update(i, 'desc', e.target.value)}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => remove(i)} style={{ padding: '2px 6px', fontSize: 11 }}>
              X
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={add} style={{ fontSize: 11, marginTop: 2 }}>
          + Add {label.replace(/s$/, '')}
        </Button>
      </div>
    );
  }

  /* ---- render ---- */

  return (
    <form style={formStyle} onSubmit={handleSubmit}>
      {/* Name */}
      <FieldGroup label="Name *">
        <TextInput
          size="sm"
          placeholder="Monster name"
          value={name}
          onChange={e => setName(e.target.value)}
          error={!!(error && !name.trim())}
        />
      </FieldGroup>

      {/* Basic stats row */}
      <div style={rowStyle}>
        <div style={{ flex: '1 1 22%' }}>
          <label style={labelStyle}>Size</label>
          <Select size="sm" value={size} onChange={e => setSize(e.target.value)}>
            {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
        <div style={{ flex: '1 1 28%' }}>
          <label style={labelStyle}>Type</label>
          <Select size="sm" value={type} onChange={e => setType(e.target.value)}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </Select>
        </div>
        <div style={{ flex: '0 0 50px' }}>
          <label style={labelStyle}>CR</label>
          <TextInput size="sm" value={cr} onChange={e => setCr(e.target.value)} />
        </div>
        <div style={{ flex: '1 1 25%' }}>
          <label style={labelStyle}>Alignment</label>
          <TextInput size="sm" value={alignment} onChange={e => setAlignment(e.target.value)} />
        </div>
      </div>

      {/* Combat stats row */}
      <div style={rowStyle}>
        <div style={{ flex: '0 0 55px' }}>
          <label style={labelStyle}>AC</label>
          <NumberInput size="sm" value={ac} onChange={e => setAc(Number(e.target.value))} min={0} max={30} />
        </div>
        <div style={{ flex: '0 0 60px' }}>
          <label style={labelStyle}>HP</label>
          <NumberInput size="sm" value={hp} onChange={e => setHp(Number(e.target.value))} min={1} max={9999} />
        </div>
        <div style={{ flex: '1 1 70px' }}>
          <label style={labelStyle}>Hit Dice</label>
          <TextInput size="sm" value={hitDice} onChange={e => setHitDice(e.target.value)} placeholder="2d8+2" />
        </div>
      </div>

      {/* Speed types */}
      <div>
        <div style={sectionHeading}>Speed (ft)</div>
        <div style={{ ...rowStyle, gap: 6 }}>
          {SPEED_TYPES.map(st => (
            <div key={st} style={{ flex: '1 1 0', textAlign: 'center', minWidth: 50 }}>
              <label style={{ ...labelStyle, textAlign: 'center' }}>{SPEED_LABELS[st]}</label>
              <NumberInput
                size="sm"
                value={speeds[st]}
                onChange={e => setSpeed(st, Number(e.target.value))}
                min={0}
                max={200}
                step={5}
                containerStyle={{ width: '100%' }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Ability scores */}
      <div>
        <div style={sectionHeading}>Ability Scores</div>
        <div style={{ ...rowStyle, gap: 6 }}>
          {ABILITY_NAMES.map(ab => (
            <div key={ab} style={{ flex: '1 1 0', textAlign: 'center', minWidth: 40 }}>
              <label style={{ ...labelStyle, textAlign: 'center' }}>{ABILITY_LABELS[ab]}</label>
              <NumberInput
                size="sm"
                value={abilities[ab]}
                onChange={e => setAbility(ab, Number(e.target.value))}
                min={1}
                max={30}
                containerStyle={{ width: '100%' }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Damage Resistances / Immunities / Condition Immunities */}
      <div>
        <div style={sectionHeading}>Resistances &amp; Immunities</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>
            <label style={labelStyle}>Damage Resistances</label>
            <TextInput
              size="sm"
              value={damageResistances}
              onChange={e => setDamageResistances(e.target.value)}
              placeholder="fire, cold, bludgeoning"
            />
          </div>
          <div>
            <label style={labelStyle}>Damage Immunities</label>
            <TextInput
              size="sm"
              value={damageImmunities}
              onChange={e => setDamageImmunities(e.target.value)}
              placeholder="poison, necrotic"
            />
          </div>
          <div>
            <label style={labelStyle}>Condition Immunities</label>
            <TextInput
              size="sm"
              value={conditionImmunities}
              onChange={e => setConditionImmunities(e.target.value)}
              placeholder="poisoned, frightened"
            />
          </div>
        </div>
      </div>

      {/* Legendary Actions */}
      {renderActionRows(
        legendaryActions, updateLegendary, removeLegendary,
        () => setLegendaryActions(prev => [...prev, { name: '', desc: '' }]),
        'Legendary Actions',
      )}

      {/* Description */}
      <FieldGroup label="Description">
        <Textarea
          size="sm"
          rows={2}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="A brief description of the creature..."
        />
      </FieldGroup>

      {/* Actions */}
      {renderActionRows(
        actions, updateAction, removeAction,
        () => setActions(prev => [...prev, { name: '', desc: '' }]),
        'Actions',
      )}

      {/* Special Abilities */}
      {renderActionRows(
        specialAbilities, updateSpecial, removeSpecial,
        () => setSpecialAbilities(prev => [...prev, { name: '', desc: '' }]),
        'Special Abilities',
      )}

      {/* Senses + Languages */}
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Senses</label>
          <TextInput size="sm" value={senses} onChange={e => setSenses(e.target.value)} placeholder="darkvision 60 ft." />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Languages</label>
          <TextInput size="sm" value={languages} onChange={e => setLanguages(e.target.value)} placeholder="Common, Draconic" />
        </div>
      </div>

      {/* Error */}
      {error && <div style={errorText}>{error}</div>}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
        <Button variant="ghost" size="sm" onClick={onCancel} type="button">Cancel</Button>
        <Button variant="primary" size="sm" type="submit" disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Monster'}
        </Button>
      </div>
    </form>
  );
}
