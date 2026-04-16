import { useMemo, useState } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import {
  emitRoll,
  emitSystemMessage,
  emitTokenUpdate,
} from '../../socket/emitters';
import { getSocket } from '../../socket/client';
import { theme } from '../../styles/theme';
import { showToast } from '../ui';
import { saveModifierForCharacter } from '../../utils/save-mod';
import type { AbilityName } from '@dnd-vtt/shared';

/**
 * Mass-action bar for DM multi-select.
 *
 * Appears at the bottom of the map canvas whenever the DM has
 * shift-clicked 2+ tokens. Single-select still uses the existing
 * TokenActionPanel — this bar is intentionally just the group
 * operations, no per-token inspector.
 *
 * v1 actions:
 *   - Apply Damage (prompt for amount, pick damage type)
 *   - Apply Heal (prompt for amount)
 *   - Add Condition (dropdown picker)
 *   - Clear Selection
 *
 * Deliberately deferred to v2 (these need more orchestration):
 *   - Mass Save (each token rolls vs DC, auto-half damage on success)
 *   - Remove All From Initiative
 *   - Move all together (pivot about centroid)
 */
const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Frightened', 'Grappled',
  'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned',
  'Prone', 'Restrained', 'Stunned', 'Unconscious',
] as const;

const SAVE_ABILITIES: AbilityName[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export function GroupActionBar() {
  const selectedIds = useMapStore((s) => s.selectedTokenIds);
  const tokens = useMapStore((s) => s.tokens);
  const selectToken = useMapStore((s) => s.selectToken);
  const isDM = useSessionStore((s) => s.isDM);
  const allCharacters = useCharacterStore((s) => s.allCharacters);

  const selected = useMemo(
    () => selectedIds.map((id) => tokens[id]).filter(Boolean),
    [selectedIds, tokens],
  );

  const [mode, setMode] = useState<null | 'damage' | 'heal' | 'condition' | 'save'>(null);
  const [amount, setAmount] = useState('');
  const [saveDC, setSaveDC] = useState('15');
  const [saveAbility, setSaveAbility] = useState<AbilityName>('dex');
  const [saveDamage, setSaveDamage] = useState('');

  // Only surfaces for the DM and only when 2+ tokens are selected.
  if (!isDM) return null;
  if (selected.length < 2) return null;

  const submit = () => {
    const n = Math.max(0, parseInt(amount, 10) || 0);
    if (mode === 'damage' && n > 0) {
      for (const t of selected) {
        getSocket().emit('combat:damage', { tokenId: t.id, amount: n });
      }
      emitSystemMessage(`💥 Mass damage: ${n} to ${selected.length} tokens`);
      showToast({ emoji: '💥', message: `Dealt ${n} damage × ${selected.length}`, variant: 'info', duration: 2500 });
    } else if (mode === 'heal' && n > 0) {
      for (const t of selected) {
        getSocket().emit('combat:heal', { tokenId: t.id, amount: n });
      }
      emitSystemMessage(`💚 Mass heal: ${n} to ${selected.length} tokens`);
      showToast({ emoji: '💚', message: `Healed ${n} × ${selected.length}`, variant: 'info', duration: 2500 });
    }
    setAmount('');
    setMode(null);
  };

  const addCondition = (condition: string) => {
    for (const t of selected) {
      getSocket().emit('combat:condition-add', {
        tokenId: t.id,
        condition: { name: condition, addedAt: new Date().toISOString() },
      });
    }
    emitSystemMessage(`🎯 ${condition} applied to ${selected.length} tokens`);
    setMode(null);
  };

  const hideAll = () => {
    for (const t of selected) {
      emitTokenUpdate(t.id, { visible: false });
    }
    showToast({ emoji: '🙈', message: `Hid ${selected.length} tokens`, variant: 'info', duration: 2000 });
  };

  const showAll = () => {
    for (const t of selected) {
      emitTokenUpdate(t.id, { visible: true });
    }
    showToast({ emoji: '👁️', message: `Revealed ${selected.length} tokens`, variant: 'info', duration: 2000 });
  };

  const rollInitiativeForGroup = () => {
    // Drop a chat line so players see "DM rolling initiative for N mobs".
    // The actual rolls would need combat active — we delegate via the
    // existing per-token initiative event.
    for (const t of selected) {
      emitRoll(`1d20`, `${t.name} initiative`);
    }
  };

  /**
   * Mass Save flow:
   *   - For each selected token, look up its save modifier from the
   *     backing character (0 for raw NPC tokens).
   *   - Emit a standard chat roll per token so everyone sees the
   *     individual d20s with the ±mod, tagged with the ability and DC.
   *   - If `saveDamage` is given, post a follow-up system line telling
   *     the DM the expected damage split (full on fail, half on pass)
   *     so they can apply with the normal per-token damage button.
   *     Auto-apply is deliberately left out of v1 — needs the server
   *     to correlate rolls to tokens, which is a bigger refactor.
   */
  const submitMassSave = () => {
    const dc = parseInt(saveDC, 10);
    if (!Number.isFinite(dc) || dc < 1) return;
    const dmg = parseInt(saveDamage, 10);
    const hasDamage = Number.isFinite(dmg) && dmg > 0;

    const abilityLabel = saveAbility.toUpperCase();
    for (const t of selected) {
      const character = t.characterId ? allCharacters[t.characterId] : null;
      const mod = saveModifierForCharacter(character, saveAbility);
      const sign = mod >= 0 ? '+' : '';
      emitRoll(
        `1d20${sign}${mod}`,
        `${t.name}: ${abilityLabel} save vs DC ${dc}`,
      );
    }
    const headline = hasDamage
      ? `🎲 Mass ${abilityLabel} save vs DC ${dc} — ${selected.length} tokens. Fail: ${dmg} damage · Pass: ${Math.floor(dmg / 2)}`
      : `🎲 Mass ${abilityLabel} save vs DC ${dc} — ${selected.length} tokens rolling.`;
    emitSystemMessage(headline);

    setSaveDamage('');
    setMode(null);
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 68,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'rgba(20, 20, 24, 0.95)',
        border: `1px solid ${theme.gold.border}`,
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,0.7)',
        pointerEvents: 'auto',
        maxWidth: '90vw',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: theme.gold.primary, marginRight: 4 }}>
        {selected.length} SELECTED
      </span>

      {mode === 'damage' || mode === 'heal' ? (
        <>
          <input
            type="number"
            min={0}
            autoFocus
            placeholder={mode === 'damage' ? 'HP damage' : 'HP healing'}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAmount(''); setMode(null); } }}
            style={{
              padding: '4px 8px', fontSize: 12, width: 110,
              background: theme.bg.deep, border: `1px solid ${theme.border.default}`,
              color: theme.text.primary, borderRadius: 4, outline: 'none',
            }}
          />
          <button onClick={submit} style={btnStyle(mode === 'damage' ? '#c0392b' : '#27ae60')}>Apply</button>
          <button onClick={() => { setAmount(''); setMode(null); }} style={btnStyle('#555')}>Cancel</button>
        </>
      ) : mode === 'save' ? (
        <>
          <span style={{ fontSize: 10, color: theme.text.muted }}>DC</span>
          <input
            type="number"
            min={1}
            autoFocus
            value={saveDC}
            onChange={(e) => setSaveDC(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitMassSave(); }}
            style={inputStyle(52)}
          />
          <select
            value={saveAbility}
            onChange={(e) => setSaveAbility(e.target.value as AbilityName)}
            style={{
              padding: '4px 6px', fontSize: 11, fontWeight: 600,
              background: theme.bg.deep, border: `1px solid ${theme.border.default}`,
              color: theme.text.primary, borderRadius: 4, outline: 'none',
              cursor: 'pointer',
            }}
          >
            {SAVE_ABILITIES.map((a) => (
              <option key={a} value={a}>{a.toUpperCase()}</option>
            ))}
          </select>
          <span style={{ fontSize: 10, color: theme.text.muted }}>DMG (opt)</span>
          <input
            type="number"
            min={0}
            placeholder="—"
            value={saveDamage}
            onChange={(e) => setSaveDamage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitMassSave(); if (e.key === 'Escape') { setSaveDamage(''); setMode(null); } }}
            style={inputStyle(70)}
          />
          <button onClick={submitMassSave} style={btnStyle('#2a78c2')}>Roll Saves</button>
          <button onClick={() => { setSaveDamage(''); setMode(null); }} style={btnStyle('#555')}>Cancel</button>
        </>
      ) : mode === 'condition' ? (
        <>
          {CONDITIONS.map((c) => (
            <button key={c} onClick={() => addCondition(c)} style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              background: theme.bg.deep, color: theme.text.primary,
              border: `1px solid ${theme.border.default}`, borderRadius: 4,
              cursor: 'pointer',
            }}>{c}</button>
          ))}
          <button
            onClick={() => setMode(null)}
            aria-label="Close condition picker"
            style={btnStyle('#555')}
          >✕</button>
        </>
      ) : (
        <>
          <button onClick={() => setMode('damage')} style={btnStyle('#c0392b')}>💥 Damage</button>
          <button onClick={() => setMode('heal')} style={btnStyle('#27ae60')}>💚 Heal</button>
          <button onClick={() => setMode('save')} style={btnStyle('#2a78c2')}>🛡️ Save</button>
          <button onClick={() => setMode('condition')} style={btnStyle('#8e44ad')}>🎯 Condition</button>
          <button onClick={rollInitiativeForGroup} style={btnStyle('#d4a257')}>🎲 Roll Init</button>
          <span style={{ width: 1, height: 18, background: theme.border.default, margin: '0 4px' }} />
          <button onClick={hideAll} style={btnStyle('#555')}>🙈 Hide</button>
          <button onClick={showAll} style={btnStyle('#555')}>👁️ Show</button>
          <button onClick={() => selectToken(null)} style={btnStyle('#333')}>✕ Clear</button>
        </>
      )}
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    color: '#fff',
    border: `1px solid ${bg}`,
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function inputStyle(width: number): React.CSSProperties {
  return {
    padding: '4px 8px',
    fontSize: 12,
    width,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    color: theme.text.primary,
    borderRadius: 4,
    outline: 'none',
  };
}
