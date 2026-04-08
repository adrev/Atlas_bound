import { useState, useEffect } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import {
  emitTokenRemove, emitTokenUpdate, emitCharacterUpdate,
  emitRoll, emitPing, emitStartCombat,
} from '../../socket/emitters';
import { abilityModifier } from '@dnd-vtt/shared';

const C = {
  bg: '#1a1a1a', bgCard: '#222', bgHover: '#2a2a2a',
  border: '#444', borderDim: '#333',
  text: '#eee', textSec: '#aaa', textMuted: '#777',
  red: '#c53131', green: '#45a049', gold: '#d4a843', blue: '#4a9fd5', purple: '#9b59b6',
};

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') try { return JSON.parse(val); } catch { return fallback; }
  return (val as T) ?? fallback;
}

type SubMenu = null | 'hp' | 'attack' | 'conditions';

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
                style={{ flex: 1, padding: '5px 8px', fontSize: 13, background: '#333', border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, outline: 'none' }} />
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
                <Item icon="📋" label="Add to Initiative" onClick={() => { /* TODO */ close(); }} />

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
    <div onClick={onClick} style={{ padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: danger ? C.red : C.text, fontSize: 12 }}
      onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <span style={{ fontSize: 13, width: 18, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hasArrow && <span style={{ fontSize: 10, color: C.textMuted }}>›</span>}
    </div>
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
    <button onClick={onClick} style={{ padding: '3px 6px', fontSize: 9, border: `1px solid ${C.border}`, borderRadius: 3, background: '#333', color, cursor: 'pointer', fontWeight: 600 }}>
      {label}
    </button>
  );
}
