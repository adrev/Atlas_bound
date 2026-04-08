import { useState, useEffect } from 'react';
import {
  Plus,
  Minus,
  Shield,
  Zap,
  Upload,
  MapPin,
  Sword,
  BookOpen,
  Maximize2,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitTokenAdd, emitTokenUpdate, emitCharacterUpdate } from '../../socket/emitters';
import {
  abilityModifier,
  type AbilityName,
  type Character,
} from '@dnd-vtt/shared';
import { emitRoll } from '../../socket/emitters';
import { CharacterImport } from './CharacterImport';
import { CharacterSheetFull } from './CharacterSheetFull';
import { theme } from '../../styles/theme';
import { HPBar, StatBlock } from '../ui';

/* ── Color Palette ─────────────────────────────────────────
 * Thin alias over the shared theme tokens. Keeps the existing
 * `C.red`, `C.green` etc. references working so we don't have to
 * sweep every usage in this 848-line file, while making every color
 * route through the unified theme.ts. Before the unification pass
 * this was a local hardcoded palette that drifted from the theme —
 * e.g. C.red was #c53131 while theme.danger is #c0392b, causing
 * the HP bar in the sidebar to look different from the tooltip.
 */
const C = {
  bgDeep: theme.bg.deep,
  bgCard: theme.bg.card,
  bgElevated: theme.bg.elevated,
  bgHover: theme.bg.hover,
  red: theme.state.danger,
  redDim: theme.dangerDim,
  redGlow: theme.dangerGlow,
  textPrimary: theme.text.primary,
  textSecondary: theme.text.secondary,
  textMuted: theme.text.muted,
  textDim: theme.text.muted,
  border: theme.border.default,
  borderDim: theme.border.default,
  green: theme.state.success,
  greenDim: theme.healDim,
  blue: theme.blue,
  purple: theme.purple,
  gold: theme.gold.primary,
} as const;

const ABILITY_LABELS: Record<AbilityName, string> = {
  str: 'STR', dex: 'DEX', con: 'CON',
  int: 'INT', wis: 'WIS', cha: 'CHA',
};

function fmtMod(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return (val as T) ?? fallback;
}

/* ── Main Component ─────────────────────────────────────── */
export function CharacterSheet() {
  const character = useCharacterStore((s) => s.myCharacter);
  const updateCharacter = useCharacterStore((s) => s.updateCharacter);
  const [showImport, setShowImport] = useState(false);
  const [showFullSheet, setShowFullSheet] = useState(false);
  const [hpDelta, setHpDelta] = useState('');

  // Auto-load character from localStorage if not already in store
  useEffect(() => {
    if (character) return; // already have one
    const savedCharId = localStorage.getItem('dnd-vtt-characterId');
    if (!savedCharId) return;
    fetch(`/api/characters/${savedCharId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) useCharacterStore.getState().setCharacter(data);
      })
      .catch(() => {});
  }, []);

  // Listen for external request to open full sheet
  useEffect(() => {
    const handler = () => setShowFullSheet(true);
    window.addEventListener('open-my-full-sheet', handler);
    return () => window.removeEventListener('open-my-full-sheet', handler);
  }, []);

  if (!character) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, padding: 48, textAlign: 'center',
        height: '100%', background: C.bgDeep,
      }}>
        <BookOpen size={48} color={C.textDim} />
        <p style={{ color: C.textSecondary, margin: 0, fontSize: 14 }}>
          No character loaded
        </p>
        <button
          onClick={() => setShowImport(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', fontSize: 13, fontWeight: 600,
            background: C.red, border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer',
          }}
        >
          <Upload size={16} />
          Import Character
        </button>
        {showImport && <CharacterImport onClose={() => setShowImport(false)} />}
      </div>
    );
  }

  /* ── Parse JSON fields ────────────────────────────────── */
  const parsedScores: Record<string, number> = parse(character.abilityScores, {} as any);
  const parsedSlots: Record<string, any> = parse(character.spellSlots, {});
  const parsedInventory: any[] = parse(character.inventory, []);
  const parsedSpells: any[] = parse(character.spells, []);

  /* ── HP helpers ───────────────────────────────────────── */
  const adjustHP = (amount: number) => {
    const newHP = Math.max(0, Math.min(character.maxHitPoints, character.hitPoints + amount));
    updateCharacter({ hitPoints: newHP });
    if (character.id) {
      emitCharacterUpdate(character.id, { hitPoints: newHP });
    }
  };

  const applyHpDelta = (mode: 'heal' | 'damage') => {
    const val = parseInt(hpDelta, 10);
    if (isNaN(val) || val <= 0) return;
    adjustHP(mode === 'heal' ? val : -val);
    setHpDelta('');
  };

  const adjustTempHP = (amount: number) => {
    const newTemp = Math.max(0, character.tempHitPoints + amount);
    updateCharacter({ tempHitPoints: newTemp });
    if (character.id) {
      emitCharacterUpdate(character.id, { tempHitPoints: newTemp });
    }
  };

  /* ── Roll helpers ─────────────────────────────────────── */
  const rollAbilityCheck = (ability: AbilityName) => {
    const mod = abilityModifier(parsedScores[ability] || 10);
    emitRoll(`1d20${fmtMod(mod)}`, `${ABILITY_LABELS[ability]} Check`);
  };

  const rollWeaponAttack = (item: any) => {
    const isFinesse = (item.description || '').toLowerCase().includes('finesse');
    const isRanged = item.type === 'weapon' && (item.description || '').toLowerCase().includes('ranged');
    const strMod = abilityModifier(parsedScores.str || 10);
    const dexMod = abilityModifier(parsedScores.dex || 10);
    let atkMod: number;
    if (isFinesse) {
      atkMod = Math.max(strMod, dexMod);
    } else if (isRanged) {
      atkMod = dexMod;
    } else {
      atkMod = strMod;
    }
    atkMod += character.proficiencyBonus;
    emitRoll(`1d20${fmtMod(atkMod)}`, `${item.name} Attack`);
  };

  /* ── Spell casting handler ──────────────────────────────── */
  const handleCastSpell = (spell: any) => {
    const spellAttack = character?.spellAttackBonus ?? 0;
    const spellDC = character?.spellSaveDC ?? 13;

    if (spell.damage && spell.attackType) {
      // Attack roll + damage spell (Fire Bolt, Eldritch Blast, etc.)
      emitRoll(`1d20+${spellAttack}`, `${spell.name} Attack`);
      setTimeout(() => emitRoll(spell.damage, `${spell.name} Damage`), 500);
    } else if (spell.damage && spell.savingThrow) {
      // Save-based damage spell (Poison Spray, etc.) - target makes save
      emitRoll(spell.damage, `${spell.name} (DC ${spellDC} ${spell.savingThrow.toUpperCase()} save)`);
    } else if (spell.damage) {
      // Damage only, no attack or save specified - just roll damage
      emitRoll(spell.damage, `${spell.name} Damage`);
    } else if (spell.name === 'Light' || spell.name === 'Dancing Lights') {
      // Light / Dancing Lights — toggle a light source on the caster's
      // token. This also cuts the fog of war around the lit token (see
      // FogLayer.tsx) so the party can see what's been illuminated.
      // Uses a cool blue "magic" hue so the LightingLayer tints the glow
      // correctly. Light cantrip gives 20 ft bright + 20 ft dim; Dancing
      // Lights is equivalent.
      const tokens = useMapStore.getState().tokens;
      const myToken = Object.values(tokens).find(t => t.characterId === character?.id);
      if (myToken) {
        if (myToken.hasLight) {
          // Already lit - turn it off
          emitTokenUpdate(myToken.id, {
            hasLight: false,
            lightRadius: 0,
            lightDimRadius: 0,
          });
          emitRoll('1d0+0', `ends ${spell.name}`);
        } else {
          const gridSize = useMapStore.getState().currentMap?.gridSize ?? 70;
          emitTokenUpdate(myToken.id, {
            hasLight: true,
            lightRadius: gridSize * 4,   // 20ft bright (4 squares)
            lightDimRadius: gridSize * 8, // 40ft dim (8 squares)
            lightColor: '#8cb4ff', // magic blue — matches LightingLayer heuristic
          });
          emitRoll('1d0+0', `casts ${spell.name} - magical light blooms!`);
        }
      } else {
        emitRoll('1d0+0', `casts ${spell.name}`);
      }
    } else if (/heal|cure|restore/i.test(spell.name)) {
      // Healing spells - roll healing dice
      const healDice = spell.level === 0
        ? '1d4'
        : `${spell.level}d8`;
      const wisMod = abilityModifier(parsedScores.wis || parsedScores.cha || 10);
      emitRoll(`${healDice}+${wisMod}`, `${spell.name} Healing`);
    } else if (spell.attackType) {
      // Attack spell without listed damage
      emitRoll(`1d20+${spellAttack}`, `${spell.name} Attack`);
    } else if (spell.savingThrow) {
      // Save-based spell without damage (Command, Tasha's, etc.)
      emitRoll('1d0+0', `casts ${spell.name} (DC ${spellDC} ${spell.savingThrow.toUpperCase()} save)`);
    } else {
      // Utility/buff spell - announce the cast
      emitRoll('1d0+0', `casts ${spell.name}`);
    }

    // Consume a spell slot if not a cantrip
    if (spell.level > 0) {
      const slots = parse(character?.spellSlots, {} as Record<string, any>);
      const slotLevel = String(spell.level);
      const slotData = slots[slotLevel];
      if (slotData && slotData.used < slotData.max) {
        const updatedSlots = {
          ...slots,
          [slotLevel]: { ...slotData, used: slotData.used + 1 },
        };
        updateCharacter({ spellSlots: updatedSlots });
        if (character?.id) {
          emitCharacterUpdate(character.id, { spellSlots: JSON.stringify(updatedSlots) });
        }
      }
    }
  };

  /* ── Derived data ─────────────────────────────────────── */
  const hpRatio = character.maxHitPoints > 0 ? character.hitPoints / character.maxHitPoints : 1;
  const hpBarColor = hpRatio > 0.5 ? C.green : hpRatio > 0.25 ? C.gold : C.red;

  const equippedWeapons = parsedInventory.filter((item: any) => item.type === 'weapon' && item.equipped);

  const initMod = abilityModifier(parsedScores.dex || 10);

  // Spell slots: condense into a quick view
  const slotEntries = Object.entries(parsedSlots).filter(([, slot]) => slot && slot.max > 0);

  // Active conditions
  const conditions: string[] = parse(character.conditions, []);

  return (
    <>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 0,
        height: '100%', overflow: 'auto', background: C.bgDeep,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: C.textPrimary, fontSize: 13,
      }}>
        {/* ═══════════ HEADER ═══════════ */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px',
          background: C.bgCard,
          // Replaced the harsh hard-red underline with a subtle gold
          // ornate divider for the Dungeon Master vibe. Softer, more
          // refined, matches the rest of the unified styling.
          borderBottom: `1px solid ${theme.border.default}`,
          boxShadow: `0 1px 0 ${theme.gold.border}`,
        }}>
          <PortraitWithUpload character={character} onUpdate={updateCharacter} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{
              margin: 0, fontSize: 16, fontWeight: 700, color: C.textPrimary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {character.name}
            </h2>
            <p style={{ margin: '1px 0 0', fontSize: 11, color: C.textSecondary }}>
              {character.race} | {character.class} | Lv {character.level}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button
              onClick={() => setShowFullSheet(true)}
              title="Open Full Sheet"
              style={iconBtnStyle}
            >
              <Maximize2 size={14} />
            </button>
            <button
              onClick={() => setShowImport(true)}
              title="Import Character"
              style={iconBtnStyle}
            >
              <Upload size={14} />
            </button>
            {character.dndbeyondId && (
              <button
                onClick={async () => {
                  try {
                    const resp = await fetch(`/api/dndbeyond/character/${character.dndbeyondId}`);
                    if (!resp.ok) throw new Error('Failed');
                    const ddbJson = await resp.json();
                    const importResp = await fetch('/api/dndbeyond/import', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ characterJson: ddbJson, userId: character.userId }),
                    });
                    if (!importResp.ok) throw new Error('Import failed');
                    const result = await importResp.json();
                    const charResp = await fetch(`/api/characters/${result.id}`);
                    if (charResp.ok) {
                      const fullChar = await charResp.json();
                      useCharacterStore.getState().setCharacter(fullChar);
                    }
                  } catch { /* ignore */ }
                }}
                title="Sync from D&D Beyond"
                style={{ ...iconBtnStyle, color: '#4a9fd5' }}
              >
                <RefreshCw size={14} />
              </button>
            )}
            <PlaceOnMapButton character={character} />
          </div>
        </div>

        {/* More breathing room: padding bumped up and gap between
            sections increased from 8→12 so the ability scores, HP
            bar, and actions sections feel less cramped. */}
        <div style={{ padding: '14px 12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ═══════════ ABILITY SCORES 3x2 GRID ═══════════
              Gap bumped from 4→6 so the ability score boxes breathe
              a little and the 3x2 grid feels less packed. */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6,
          }}>
            {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as AbilityName[]).map((ability) => {
              const score = parsedScores[ability] || 10;
              const mod = abilityModifier(score);
              return (
                <button
                  key={ability}
                  onClick={() => rollAbilityCheck(ability)}
                  title={`Roll ${ABILITY_LABELS[ability]} check (${score})`}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '5px 8px', background: C.bgCard,
                    border: `1px solid ${C.redDim}`, borderRadius: 4,
                    cursor: 'pointer', transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.red; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.redDim; }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: C.red, letterSpacing: '0.5px' }}>
                    {ABILITY_LABELS[ability]}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary }}>
                    {fmtMod(mod)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* ═══════════ QUICK STATS ROW ═══════════ */}
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { label: 'AC', value: String(character.armorClass), icon: <Shield size={10} color={C.textMuted} /> },
              { label: 'SPD', value: `${character.speed}ft` },
              { label: 'INIT', value: fmtMod(initMod) },
              { label: 'PROF', value: `+${character.proficiencyBonus}` },
            ].map((stat) => (
              <div key={stat.label} style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: '4px 2px', background: C.bgCard, border: `1px solid ${C.borderDim}`,
                borderRadius: 4,
              }}>
                <span style={{ fontSize: 8, fontWeight: 700, color: C.textDim, textTransform: 'uppercase' }}>
                  {stat.icon || null}{stat.label}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>
                  {stat.value}
                </span>
              </div>
            ))}
          </div>

          {/* ═══════════ HP BAR ═══════════
              Uses the shared HPBar primitive so the sidebar, tooltip,
              and full sheet all render identical HP visuals. Keeps
              the adjacent Dmg/Heal/Temp-HP controls unchanged. */}
          <div style={{
            padding: '8px 10px', background: C.bgCard, borderRadius: 6,
            border: `1px solid ${C.border}`,
          }}>
            <HPBar
              current={character.hitPoints}
              max={character.maxHitPoints}
              temp={character.tempHitPoints}
              size="normal"
              showEmoji
              style={{ marginBottom: 6 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button onClick={() => adjustHP(-1)} style={hpBtnStyle} title="-1 HP">
                <Minus size={10} />
              </button>
              <input
                type="number"
                value={hpDelta}
                onChange={(e) => setHpDelta(e.target.value)}
                placeholder="HP"
                style={{
                  flex: 1, padding: '3px 6px', fontSize: 11,
                  background: C.bgDeep, border: `1px solid ${C.border}`,
                  borderRadius: 3, color: C.textPrimary, textAlign: 'center',
                  outline: 'none', minWidth: 0,
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') applyHpDelta('damage'); }}
              />
              <button
                onClick={() => applyHpDelta('damage')}
                style={{ ...hpBtnStyle, background: 'rgba(197,49,49,0.2)', borderColor: C.red, color: C.red }}
              >
                Dmg
              </button>
              <button
                onClick={() => applyHpDelta('heal')}
                style={{ ...hpBtnStyle, background: 'rgba(69,160,73,0.2)', borderColor: C.green, color: C.green }}
              >
                Heal
              </button>
              <button onClick={() => adjustHP(1)} style={hpBtnStyle} title="+1 HP">
                <Plus size={10} />
              </button>
            </div>
            {/* Temp HP inline */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: C.textMuted }}>Temp:</span>
              <button onClick={() => adjustTempHP(-1)} style={{ ...hpBtnStyle, padding: '1px 5px' }}>
                <Minus size={8} />
              </button>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.blue, minWidth: 16, textAlign: 'center' }}>
                {character.tempHitPoints}
              </span>
              <button onClick={() => adjustTempHP(1)} style={{ ...hpBtnStyle, padding: '1px 5px' }}>
                <Plus size={8} />
              </button>
            </div>
          </div>

          {/* ═══════════ QUICK ACTIONS (Equipped Weapons) ═══════════ */}
          {equippedWeapons.length > 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 3,
            }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '1px' }}>
                Actions
              </span>
              {equippedWeapons.map((weapon: any, i: number) => {
                const isFinesse = (weapon.description || '').toLowerCase().includes('finesse');
                const isRanged = (weapon.description || '').toLowerCase().includes('ranged');
                const strMod = abilityModifier(parsedScores.str || 10);
                const dexMod = abilityModifier(parsedScores.dex || 10);
                let atkMod: number;
                if (isFinesse) atkMod = Math.max(strMod, dexMod);
                else if (isRanged) atkMod = dexMod;
                else atkMod = strMod;
                atkMod += character.proficiencyBonus;
                return (
                  <button
                    key={i}
                    onClick={() => rollWeaponAttack(weapon)}
                    title={`Roll ${weapon.name} Attack`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 8px', background: 'rgba(197,49,49,0.08)',
                      border: `1px solid ${C.redDim}`, borderRadius: 4,
                      cursor: 'pointer', width: '100%', textAlign: 'left',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(197,49,49,0.18)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(197,49,49,0.08)'; }}
                  >
                    <Sword size={12} color={C.red} />
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: C.textPrimary }}>
                      {weapon.name}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.red }}>
                      {fmtMod(atkMod)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* ═══════════ SPELL SLOTS (Compact Pips) ═══════════ */}
          {slotEntries.length > 0 && (
            <div style={{
              padding: '6px 8px', background: C.bgCard, borderRadius: 6,
              border: `1px solid ${C.borderDim}`,
            }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '1px' }}>
                Spell Slots
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                {slotEntries.map(([level, slot]) => {
                  const remaining = slot.max - slot.used;
                  return (
                    <div key={level} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: C.textSecondary, width: 16 }}>
                        {level}
                      </span>
                      <div style={{ display: 'flex', gap: 3, flex: 1 }}>
                        {Array.from({ length: slot.max }).map((_: unknown, i: number) => (
                          <div
                            key={i}
                            style={{
                              width: 10, height: 10, borderRadius: '50%',
                              border: `2px solid ${C.red}`,
                              background: i < remaining ? C.red : 'transparent',
                              boxShadow: i < remaining ? C.redGlow : 'none',
                            }}
                          />
                        ))}
                      </div>
                      <span style={{ fontSize: 9, color: C.textMuted, fontFamily: 'monospace' }}>
                        {remaining}/{slot.max}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══════════ SPELLS LIST ═══════════ */}
          {parsedSpells.length > 0 && (
            <div style={{
              padding: '6px 8px', background: C.bgCard, borderRadius: 6,
              border: `1px solid ${C.borderDim}`,
            }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '1px' }}>
                Spells ({parsedSpells.length})
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 4 }}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(level => {
                  const levelSpells = parsedSpells.filter((s: any) => s.level === level);
                  if (levelSpells.length === 0) return null;
                  return (
                    <div key={level}>
                      <div style={{ fontSize: 8, fontWeight: 700, color: C.gold, textTransform: 'uppercase', marginTop: level > 0 ? 4 : 0 }}>
                        {level === 0 ? 'Cantrips' : `Level ${level}`}
                      </div>
                      {levelSpells.map((spell: any, i: number) => (
                        <div key={i}
                          onClick={() => handleCastSpell(spell)}
                          style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '4px 6px', fontSize: 11, borderRadius: 4,
                            cursor: 'pointer',
                            color: C.textPrimary,
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = C.bgHover}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title={spell.description || spell.name}
                        >
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{spell.name}</span>
                          <span style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0, marginLeft: 4 }}>
                            {spell.damage && <span style={{ fontSize: 9, color: C.red, padding: '1px 4px', background: 'rgba(197,49,49,0.15)', borderRadius: 3 }}>{spell.damage}</span>}
                            {spell.savingThrow && !spell.damage && <span style={{ fontSize: 8, color: C.gold, padding: '1px 4px', background: 'rgba(212,168,67,0.15)', borderRadius: 3 }}>{spell.savingThrow.toUpperCase()}</span>}
                            {spell.isConcentration && <span style={{ fontSize: 7, color: C.purple, fontWeight: 700 }}>C</span>}
                            {spell.isRitual && <span style={{ fontSize: 7, color: C.blue, fontWeight: 700 }}>R</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══════════ CONDITIONS ═══════════ */}
          {conditions.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {conditions.map((cond) => (
                <span
                  key={cond}
                  style={{
                    padding: '2px 8px', fontSize: 10, fontWeight: 600,
                    background: 'rgba(197,49,49,0.15)', border: `1px solid ${C.red}`,
                    borderRadius: 10, color: C.red, textTransform: 'capitalize',
                  }}
                >
                  {cond}
                </span>
              ))}
            </div>
          )}

          {/* ═══════════ OPEN FULL SHEET BUTTON ═══════════ */}
          <button
            onClick={() => setShowFullSheet(true)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 16px', fontSize: 12, fontWeight: 700,
              background: 'rgba(197,49,49,0.12)', border: `1px solid ${C.red}`,
              borderRadius: 6, color: C.red, cursor: 'pointer',
              textTransform: 'uppercase', letterSpacing: '0.5px',
              marginTop: 4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(197,49,49,0.25)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(197,49,49,0.12)'; }}
          >
            <Maximize2 size={14} />
            Open Full Sheet
          </button>
        </div>

        {showImport && <CharacterImport onClose={() => setShowImport(false)} />}
      </div>

      {/* ═══════════ FULL SHEET OVERLAY ═══════════ */}
      {showFullSheet && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'fadeIn 0.2s ease',
        }}>
          <div style={{
            width: '90%', maxWidth: 1000, maxHeight: '90vh',
            overflow: 'auto', background: C.bgDeep,
            borderRadius: 12, border: `1px solid ${C.border}`,
            boxShadow: '0 16px 64px rgba(0,0,0,0.6)',
            position: 'relative',
          }}>
            <button
              onClick={() => setShowFullSheet(false)}
              style={{
                position: 'absolute', top: 12, right: 12, zIndex: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '50%',
                background: C.bgElevated, border: `1px solid ${C.border}`,
                color: C.textSecondary, cursor: 'pointer',
              }}
            >
              <X size={16} />
            </button>
            <CharacterSheetFull character={character} onClose={() => setShowFullSheet(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/* ── Shared styles ─────────────────────────────────────── */

const iconBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 4,
  background: 'rgba(197,49,49,0.15)', border: `1px solid ${C.red}`,
  color: C.red, cursor: 'pointer',
};

const hpBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '3px 6px', fontSize: 10, fontWeight: 600,
  background: C.bgElevated, border: `1px solid ${C.border}`,
  borderRadius: 3, color: C.textSecondary, cursor: 'pointer',
};

/* ── Portrait ───────────────────────────────────────────── */

function PortraitWithUpload({ character, onUpdate }: { character: Character; onUpdate: (changes: Partial<Character>) => void }) {
  const [hover, setHover] = useState(false);

  const handleUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext('2d')!;
      const img = new Image();
      img.onload = async () => {
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, 200, 200);
        canvas.toBlob(async (blob) => {
          if (!blob) return;
          const formData = new FormData();
          formData.append('image', blob, 'portrait.png');
          try {
            const resp = await fetch('/api/uploads/token-image', { method: 'POST', body: formData });
            if (resp.ok) {
              const data = await resp.json();
              onUpdate({ portraitUrl: data.url });
              if (character.id) {
                fetch(`/api/characters/${character.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ portraitUrl: data.url }),
                });
                // Also update the token on the map if placed
                const tokens = useMapStore.getState().tokens;
                const myToken = Object.values(tokens).find(t => t.characterId === character.id);
                if (myToken) {
                  emitTokenUpdate(myToken.id, { imageUrl: data.url });
                }
              }
            }
          } catch { /* ignore */ }
        }, 'image/png');
      };
      img.src = URL.createObjectURL(file);
    };
    input.click();
  };

  const portraitSrc = character.portraitUrl;

  return (
    <div style={{ position: 'relative' as const, display: 'inline-block' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          width: 48, height: 48, borderRadius: '50%',
          border: `3px solid ${C.red}`, overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: C.bgElevated, cursor: 'pointer', flexShrink: 0,
          boxShadow: C.redGlow,
        }}
        onClick={handleUpload}
        title="Click to upload portrait"
      >
        {portraitSrc ? (
          <img src={portraitSrc} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} />
        ) : (
          <span style={{ fontSize: 20, fontWeight: 700, color: C.red }}>{character.name.charAt(0)}</span>
        )}
      </div>
      <div style={{
        position: 'absolute' as const, bottom: -1, right: -1,
        width: 14, height: 14, borderRadius: '50%',
        background: C.red, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        fontSize: 9, color: '#fff', fontWeight: 700,
        border: `2px solid ${C.bgDeep}`,
      }}>+</div>
      {hover && portraitSrc && (
        <div style={{
          position: 'absolute' as const, left: 56, top: -10, zIndex: 100,
          width: 140, height: 140, borderRadius: 10,
          border: `3px solid ${C.red}`,
          boxShadow: `0 8px 32px rgba(0,0,0,0.6), ${C.redGlow}`,
          overflow: 'hidden', background: C.bgCard,
          pointerEvents: 'none' as const,
        }}>
          <img src={portraitSrc} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      )}
    </div>
  );
}

/* ── Place on Map ───────────────────────────────────────── */

function PlaceOnMapButton({ character }: { character: Character }) {
  const currentMap = useMapStore((s) => s.currentMap);
  const tokens = useMapStore((s) => s.tokens);
  const userId = useSessionStore((s) => s.userId);
  const gridSize = currentMap?.gridSize ?? 70;

  const alreadyPlaced = Object.values(tokens).some(
    (t) => t.characterId === character.id
  );

  const handlePlace = () => {
    if (!currentMap || alreadyPlaced) return;
    emitTokenAdd({
      mapId: currentMap.id,
      characterId: character.id,
      name: character.name,
      x: currentMap.width / 2,
      y: currentMap.height / 2,
      size: 1,
      imageUrl: character.portraitUrl,
      color: '#d4a843',
      layer: 'token',
      visible: true,
      hasLight: false,
      lightRadius: gridSize * 4,
      lightDimRadius: gridSize * 8,
      lightColor: '#ffcc66',
      conditions: [],
      ownerUserId: userId,
    });
  };

  return (
    <button
      onClick={handlePlace}
      disabled={!currentMap || alreadyPlaced}
      title={alreadyPlaced ? 'Already on map' : currentMap ? 'Place on map' : 'Load a map first'}
      style={{
        ...iconBtnStyle,
        background: alreadyPlaced ? C.bgElevated : 'rgba(197,49,49,0.15)',
        borderColor: alreadyPlaced ? C.border : C.red,
        color: alreadyPlaced ? C.textMuted : C.red,
        cursor: alreadyPlaced || !currentMap ? 'default' : 'pointer',
        opacity: !currentMap ? 0.4 : 1,
      }}
    >
      <MapPin size={14} />
    </button>
  );
}
