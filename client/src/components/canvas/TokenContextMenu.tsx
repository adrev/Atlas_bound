import { useState, useEffect } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import {
  emitTokenRemove, emitTokenUpdate, emitCharacterUpdate,
  emitRoll, emitPing, emitStartCombat, emitAddCombatant,
} from '../../socket/emitters';
import { abilityModifier, LIGHT_SOURCE_PRESETS } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

// Theme-routed palette — matches TokenActionPanel + TokenTooltip so
// every hover / left-click / right-click surface shares the same look.
const C = {
  bg: theme.bg.deep,
  bgCard: theme.bg.card,
  bgHover: theme.bg.hover,
  border: theme.border.default,
  borderDim: theme.border.default,
  text: theme.text.primary,
  textSec: theme.text.secondary,
  textMuted: theme.text.muted,
  red: theme.state.danger,
  green: theme.state.success,
  gold: theme.gold.primary,
  blue: theme.blue,
  purple: theme.purple,
};

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') try { return JSON.parse(val); } catch { return fallback; }
  return (val as T) ?? fallback;
}

type SubMenu = null | 'hp' | 'attack' | 'conditions' | 'aura' | 'light';

export function TokenContextMenu() {
  const contextTokenId = useMapStore((s) => s.contextMenuTokenId);
  const contextPos = useMapStore((s) => s.contextMenuPosition);
  const tokens = useMapStore((s) => s.tokens);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const combatActive = useCombatStore((s) => s.active);

  const [subMenu, setSubMenu] = useState<SubMenu>(null);
  const [hpInput, setHpInput] = useState('');
  const [fetchAttempted, setFetchAttempted] = useState(false);

  useEffect(() => { setFetchAttempted(false); setSubMenu(null); setHpInput(''); }, [contextTokenId]);

  // Auto-fetch character data
  useEffect(() => {
    if (!contextTokenId || fetchAttempted) return;
    const t = tokens[contextTokenId];
    if (!t?.characterId) return;
    if (useCharacterStore.getState().allCharacters[t.characterId]) return;
    setFetchAttempted(true);
    fetch(`/api/characters/${t.characterId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) useCharacterStore.getState().setAllCharacters({
          ...useCharacterStore.getState().allCharacters, [t.characterId!]: data,
        });
      }).catch(() => {});
  }, [contextTokenId, fetchAttempted, tokens]);

  if (!contextTokenId || !contextPos) return null;
  const token = tokens[contextTokenId];
  if (!token) return null;

  // Only show for DM or token owner
  const isOwner = token.ownerUserId === userId;
  if (!isDM && !isOwner) return null;

  const character = token.characterId ? allCharacters[token.characterId] : null;
  const scores = character ? parse<Record<string, number>>(character.abilityScores, {}) : {};
  const hp = character?.hitPoints ?? 0;
  const maxHp = character?.maxHitPoints ?? 0;
  const ac = character?.armorClass ?? 10;
  const inventory = character ? parse<any[]>(character.inventory, []) : [];
  const weapons = inventory.filter((i: any) => i.type === 'weapon' && i.equipped);
  const profBonus = character?.proficiencyBonus ?? 2;
  const strMod = abilityModifier(scores.str || 10);
  const dexMod = abilityModifier(scores.dex || 10);
  const gridSize = useMapStore.getState().currentMap?.gridSize ?? 70;

  const close = () => { useMapStore.getState().setContextMenu(null, null); setSubMenu(null); setHpInput(''); };

  const menuX = Math.min(contextPos.x, (typeof window !== 'undefined' ? window.innerWidth - 240 : 600));
  const menuY = Math.min(contextPos.y, (typeof window !== 'undefined' ? window.innerHeight - 500 : 300));

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={e => { e.stopPropagation(); e.preventDefault(); close(); }}
        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
        onMouseUp={e => { e.stopPropagation(); }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); close(); }} />

      <div
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: menuX, top: menuY, zIndex: 9999,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.7)', minWidth: 220, maxWidth: 280,
          fontFamily: '-apple-system, sans-serif', fontSize: 13, color: C.text,
          overflow: 'hidden',
        }}>
        {/* Header */}
        <div style={{
          padding: '8px 12px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', gap: 8, background: C.bgCard,
        }}>
          {token.imageUrl ? (
            <img src={token.imageUrl} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${isOwner ? C.green : C.red}` }} />
          ) : (
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: token.color || '#555', border: `2px solid ${C.red}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700 }}>{token.name[0]}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{token.name}</div>
            {character && <div style={{ fontSize: 10, color: C.textSec }}>HP {hp}/{maxHp} • AC {ac}</div>}
          </div>
        </div>

        {/* Sub-menus */}
        {subMenu === 'hp' && character && (
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <input type="number" value={hpInput} onChange={e => setHpInput(e.target.value)} placeholder="Amount" autoFocus
                onKeyDown={e => { if (e.key === 'Enter') { const v = parseInt(hpInput); if (!isNaN(v) && v > 0 && token.characterId) { emitCharacterUpdate(token.characterId, { hitPoints: Math.max(0, hp - v) }); close(); } } }}
                style={{ flex: 1, padding: '5px 8px', fontSize: 13, background: theme.bg.elevated, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', gap: 3 }}>
              <Btn label="Damage" color={C.red} onClick={() => { const v = parseInt(hpInput); if (!isNaN(v) && v > 0 && token.characterId) { emitCharacterUpdate(token.characterId, { hitPoints: Math.max(0, hp - v) }); close(); } }} />
              <Btn label="Heal" color={C.green} onClick={() => { const v = parseInt(hpInput); if (!isNaN(v) && v > 0 && token.characterId) { emitCharacterUpdate(token.characterId, { hitPoints: Math.min(maxHp, hp + v) }); close(); } }} />
            </div>
            <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
              {[1, 5, 10, 20].map(n => <MiniBtn key={n} label={`-${n}`} color={C.red} onClick={() => { if (token.characterId) { emitCharacterUpdate(token.characterId, { hitPoints: Math.max(0, hp - n) }); close(); } }} />)}
              {[1, 5, 10].map(n => <MiniBtn key={`h${n}`} label={`+${n}`} color={C.green} onClick={() => { if (token.characterId) { emitCharacterUpdate(token.characterId, { hitPoints: Math.min(maxHp, hp + n) }); close(); } }} />)}
            </div>
          </div>
        )}

        {subMenu === 'attack' && (
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
            {weapons.length > 0 ? weapons.map((w: any, i: number) => {
              const isFinesse = (w.properties || []).some((p: string) => p.toLowerCase().includes('finesse'));
              const isRanged = (w.properties || []).some((p: string) => p.toLowerCase().includes('range'));
              const atkMod = (isRanged ? dexMod : isFinesse ? Math.max(strMod, dexMod) : strMod) + profBonus;
              const dmgMod = isRanged ? dexMod : isFinesse ? Math.max(strMod, dexMod) : strMod;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0', borderBottom: i < weapons.length - 1 ? `1px solid ${C.borderDim}` : 'none' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{w.name}</div>
                    <div style={{ fontSize: 9, color: C.textMuted }}>+{atkMod} hit • {w.damage || '1d4'}+{dmgMod}</div>
                  </div>
                  <MiniBtn label="ATK" color={C.red} onClick={() => { emitRoll(`1d20+${atkMod}`, `${token.name} ${w.name}`); close(); }} />
                  <MiniBtn label="DMG" color={C.gold} onClick={() => { emitRoll(`${w.damage || '1d4'}+${dmgMod}`, `${token.name} ${w.name} Damage`); close(); }} />
                </div>
              );
            }) : (
              <div style={{ display: 'flex', gap: 3 }}>
                <Btn label={`Attack (d20+${Math.max(strMod, dexMod) + profBonus})`} color={C.red} onClick={() => { emitRoll(`1d20+${Math.max(strMod, dexMod) + profBonus}`, `${token.name} Attack`); close(); }} />
                <Btn label={`Damage (1d6+${strMod})`} color={C.gold} onClick={() => { emitRoll(`1d6+${strMod}`, `${token.name} Damage`); close(); }} />
              </div>
            )}
          </div>
        )}

        {subMenu === 'conditions' && (
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {['blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'].map(cond => {
                const active = (token.conditions || []).includes(cond as any);
                return (
                  <button key={cond} onClick={() => {
                    const current = [...(token.conditions || [])];
                    const updated = active ? current.filter(c => c !== cond) : [...current, cond];
                    emitTokenUpdate(token.id, { conditions: updated as any });
                    close();
                  }} style={{
                    padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                    background: active ? 'rgba(197,49,49,0.3)' : C.bgHover,
                    border: `1px solid ${active ? C.red : C.border}`,
                    color: active ? C.red : C.textSec, fontWeight: active ? 700 : 400,
                    textTransform: 'capitalize',
                  }}>{cond}</button>
                );
              })}
            </div>
          </div>
        )}

        {subMenu === 'light' && (
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 6 }}>
              5e Light Source (PHB p.183)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, marginBottom: 8 }}>
              {LIGHT_SOURCE_PRESETS.map((preset) => {
                const expectedBright = preset.bright * gridSize / 5;
                const active = token.hasLight
                  && Math.abs(token.lightRadius - expectedBright) < 1
                  && token.lightColor === preset.color;
                return (
                  <button
                    key={preset.id}
                    onClick={() => {
                      emitTokenUpdate(token.id, {
                        hasLight: true,
                        lightRadius: preset.bright * gridSize / 5,
                        lightDimRadius: preset.dim * gridSize / 5,
                        lightColor: preset.color,
                      } as any);
                      close();
                    }}
                    title={`${preset.bright} ft bright / ${preset.dim - preset.bright} ft dim · ${preset.ref ?? ''}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 6px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                      background: active ? 'rgba(212,168,67,0.3)' : C.bgHover,
                      border: `1px solid ${active ? C.gold : C.border}`,
                      color: active ? C.gold : C.textSec, fontWeight: 600, textAlign: 'left',
                    }}
                  >
                    <span aria-hidden style={{ fontSize: 12 }}>{preset.icon}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {preset.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {token.hasLight && (
              <Btn label="Remove Light" color={C.red} onClick={() => {
                emitTokenUpdate(token.id, {
                  hasLight: false,
                  lightRadius: 0,
                  lightDimRadius: 0,
                } as any);
                close();
              }} />
            )}
          </div>
        )}

        {subMenu === 'aura' && (
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Radius (feet)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 8 }}>
              {[5, 10, 15, 20, 30, 60].map(r => (
                <button key={r} onClick={() => {
                  const current = (token as any).aura;
                  emitTokenUpdate(token.id, {
                    aura: { radiusFeet: r, color: current?.color || '#d4a843', opacity: current?.opacity || 0.2, shape: current?.shape || 'circle' },
                  } as any);
                  close();
                }} style={{
                  padding: '3px 8px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                  background: (token as any).aura?.radiusFeet === r ? 'rgba(212,168,67,0.3)' : C.bgHover,
                  border: `1px solid ${(token as any).aura?.radiusFeet === r ? C.gold : C.border}`,
                  color: (token as any).aura?.radiusFeet === r ? C.gold : C.textSec, fontWeight: 600,
                }}>{r} ft</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4 }}>Color</div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              {[
                { label: 'Gold', color: '#d4a843' },
                { label: 'Purple', color: '#9b59b6' },
                { label: 'Green', color: '#27ae60' },
                { label: 'Red', color: '#c0392b' },
                { label: 'Blue', color: '#2980b9' },
              ].map(preset => (
                <button key={preset.label} onClick={() => {
                  const current = (token as any).aura;
                  if (!current) {
                    emitTokenUpdate(token.id, {
                      aura: { radiusFeet: 10, color: preset.color, opacity: 0.2, shape: 'circle' },
                    } as any);
                  } else {
                    emitTokenUpdate(token.id, {
                      aura: { ...current, color: preset.color },
                    } as any);
                  }
                  close();
                }} style={{
                  width: 24, height: 24, borderRadius: 4, cursor: 'pointer',
                  background: preset.color,
                  border: `2px solid ${(token as any).aura?.color === preset.color ? '#fff' : 'transparent'}`,
                  opacity: 0.8,
                }} title={preset.label} />
              ))}
            </div>
            {(token as any).aura && (
              <Btn label="Remove Aura" color={C.red} onClick={() => {
                emitTokenUpdate(token.id, { aura: null } as any);
                close();
              }} />
            )}
          </div>
        )}

        {/* Main menu items */}
        {subMenu === null && (
          <div>
            {/* Ping */}
            <Item icon="📡" label="Ping Location" onClick={() => { emitPing(token.x + (gridSize * token.size) / 2, token.y + (gridSize * token.size) / 2); close(); }} />

            <Divider />

            {/* Combat actions */}
            {character && <Item icon="❤️" label={`HP: ${hp}/${maxHp}`} onClick={() => setSubMenu('hp')} hasArrow />}
            <Item icon="⚔️" label="Attack" onClick={() => setSubMenu('attack')} hasArrow />
            {/* Conditions can only be applied by the DM. Players who want to
                inflict a condition on themselves (e.g. via a buff spell) do
                so through the cast flow, not by picking from this menu. */}
            {isDM && <Item icon="🎭" label="Conditions" onClick={() => setSubMenu('conditions')} hasArrow />}
            {isDM && <Item icon="🔮" label={(token as any).aura ? 'Aura (active)' : 'Aura'} onClick={() => setSubMenu('aura')} hasArrow />}
            {isDM && <Item icon={token.hasLight ? '💡' : '🔆'} label={token.hasLight ? `Light (${Math.round(token.lightRadius / gridSize * 5)} ft)` : 'Light source'} onClick={() => setSubMenu('light')} hasArrow />}
            <Item icon="📊" label="View Stats" onClick={async () => {
              // For NPC/creature tokens: open compendium stat block
              // For player tokens: open character sheet
              const isNPC = !token.ownerUserId || (character?.source === 'manual' && character?.userId === 'npc');

              if (isNPC) {
                // Try to find this creature in the compendium by name
                const slug = token.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                window.dispatchEvent(new CustomEvent('open-compendium-detail', {
                  detail: { slug, category: 'monsters', name: token.name }
                }));
                close();
                return;
              }

              // Player character: open character sheet
              if (!token.characterId) { close(); return; }
              const charId = token.characterId;
              const tokId = token.id;
              let char = useCharacterStore.getState().allCharacters[charId];
              if (!char) {
                try {
                  const r = await fetch(`/api/characters/${charId}`);
                  if (r.ok) {
                    char = await r.json();
                    useCharacterStore.getState().setAllCharacters({
                      ...useCharacterStore.getState().allCharacters,
                      [charId]: char,
                    });
                  }
                } catch {}
              }
              if (char) {
                window.dispatchEvent(new CustomEvent('open-character-sheet', {
                  detail: { characterId: charId, tokenId: tokId },
                }));
              }
              close();
            }} />

            {/* Player-owned utility tokens (Light spell markers, Dancing
                Lights, player-summoned aids) — the caster can dismiss
                their own marker without waiting for the DM. Matches the
                server-side token-remove check which lets owners delete
                their own tokens. Gated by ownership + name pattern so
                players can't accidentally nuke their PC token via the
                same path. */}
            {!isDM &&
              token.ownerUserId === userId &&
              /^(Light|Dancing Lights) \(/.test(token.name) && (
                <>
                  <Divider />
                  <Item
                    icon="✦"
                    label={`Dismiss ${token.name.split(' (')[0]}`}
                    onClick={() => { emitTokenRemove(contextTokenId); close(); }}
                    danger
                  />
                </>
              )}

            {isDM && (
              <>
                <Divider />

                {/* Turn management */}
                {!combatActive && Object.keys(tokens).length > 0 && (
                  <Item icon="⚔️" label="Start Combat" onClick={() => { emitStartCombat(Object.keys(tokens)); close(); }} />
                )}
                {combatActive && (
                  <Item icon="🏳️" label="End Combat" onClick={() => { import('../../socket/emitters').then(({ emitEndCombat: ec }) => ec()); close(); }} />
                )}
                {combatActive && (
                  <Item
                    icon="📋"
                    label="Add to Initiative"
                    onClick={() => { emitAddCombatant(token.id); close(); }}
                  />
                )}

                <Divider />

                {/* Layer / visibility */}
                <Item icon={token.visible ? '👁️' : '🙈'} label={token.visible ? 'Hide Token' : 'Show Token'}
                  onClick={() => { emitTokenUpdate(token.id, { visible: !token.visible }); close(); }} />
                <Item icon={useMapStore.getState().lockedTokenIds.has(token.id) ? '🔓' : '🔒'}
                  label={useMapStore.getState().lockedTokenIds.has(token.id) ? 'Unlock Position' : 'Lock Position'}
                  onClick={() => { useMapStore.getState().toggleLockToken(token.id); close(); }} />

                <Divider />

                {/* Token size */}
                <div style={{ padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: C.textMuted, marginRight: 4 }}>Size:</span>
                  {[{ label: 'T', size: 0.5 }, { label: 'S', size: 0.75 }, { label: 'M', size: 1 }, { label: 'L', size: 2 }, { label: 'H', size: 3 }, { label: 'G', size: 4 }].map(s => (
                    <button key={s.label} onClick={() => { emitTokenUpdate(token.id, { size: s.size }); close(); }}
                      style={{
                        padding: '2px 6px', fontSize: 10, borderRadius: 3, cursor: 'pointer',
                        background: token.size === s.size ? 'rgba(212,168,67,0.3)' : C.bgHover,
                        border: `1px solid ${token.size === s.size ? C.gold : C.border}`,
                        color: token.size === s.size ? C.gold : C.textSec, fontWeight: 600,
                      }}>{s.label}</button>
                  ))}
                </div>

                <Item icon="📋" label="Copy Token" onClick={() => { useMapStore.getState().copyToken(token); close(); }} />
                <Item icon="💰" label="Edit Loot" onClick={async () => {
                  let charId = token.characterId;
                  // Auto-create character if needed
                  if (!charId) {
                    try {
                      const slug = token.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                      const compResp = await fetch(`/api/compendium/monsters/${slug}`);
                      const comp = compResp.ok ? await compResp.json() : null;
                      const createResp = await fetch('/api/characters', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          userId: 'npc', name: token.name,
                          race: comp?.type || 'monster', class: `CR ${comp?.challengeRating || '0'}`,
                          level: 1, hitPoints: comp?.hitPoints || 10, maxHitPoints: comp?.hitPoints || 10,
                          armorClass: comp?.armorClass || 10, speed: comp?.speed?.walk || 30,
                          abilityScores: comp?.abilityScores || {}, portraitUrl: token.imageUrl,
                        }),
                      });
                      if (createResp.ok) {
                        const data = await createResp.json();
                        charId = data.id;
                        emitTokenUpdate(token.id, { characterId: charId } as any);
                        useMapStore.getState().updateToken(token.id, { characterId: charId } as any);
                      }
                    } catch {}
                  }
                  if (charId) {
                    window.dispatchEvent(new CustomEvent('open-loot-editor', {
                      detail: { characterId: charId, tokenName: token.name }
                    }));
                  }
                  close();
                }} />

                <Divider />
                <Item icon="🗑️" label="Delete Token" onClick={() => { emitTokenRemove(contextTokenId); close(); }} danger />
              </>
            )}

            {/* Ability scores (compact) */}
            {character && Object.keys(scores).length > 0 && (
              <div style={{ padding: '4px 12px 6px', borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between' }}>
                {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).map(ab => (
                  <div key={ab} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 7, color: C.textMuted, textTransform: 'uppercase' }}>{ab}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, cursor: 'pointer' }}
                      onClick={() => { emitRoll(`1d20+${abilityModifier(scores[ab] || 10) >= 0 ? '+' : ''}${abilityModifier(scores[ab] || 10)}`, `${token.name} ${ab.toUpperCase()} Check`); close(); }}
                      title={`Roll ${ab.toUpperCase()} check`}>
                      {abilityModifier(scores[ab] || 10) >= 0 ? '+' : ''}{abilityModifier(scores[ab] || 10)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Item({ icon, label, onClick, hasArrow, danger }: { icon: string; label: string; onClick: () => void; hasArrow?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      style={{
        padding: '6px 12px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: danger ? C.red : C.text,
        fontSize: 12,
        width: '100%',
        background: 'transparent',
        border: 'none',
        textAlign: 'left' as const,
        font: 'inherit',
      }}
    >
      <span style={{ fontSize: 13, width: 18, textAlign: 'center' }} aria-hidden>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hasArrow && <span style={{ fontSize: 10, color: C.textMuted }} aria-hidden>›</span>}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: C.border, margin: '2px 0' }} />;
}

function Btn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ flex: 1, padding: '6px', border: 'none', borderRadius: 4, background: `${color}22`, color, fontWeight: 600, cursor: 'pointer', fontSize: 11 }}>
      {label}
    </button>
  );
}

function MiniBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ padding: '3px 6px', fontSize: 9, border: `1px solid ${C.border}`, borderRadius: 3, background: theme.bg.elevated, color, cursor: 'pointer', fontWeight: 600 }}>
      {label}
    </button>
  );
}
