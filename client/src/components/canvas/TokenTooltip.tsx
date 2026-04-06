import { useEffect, useState } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { abilityModifier } from '@dnd-vtt/shared';

const HOVER_DELAY = 150;

const C = {
  bg: '#1a1a1a',
  bgCard: '#222',
  bgElevated: '#2a2a2a',
  red: '#c53131',
  text: '#eee',
  textSec: '#aaa',
  textMuted: '#777',
  border: '#444',
  green: '#45a049',
  yellow: '#e6a817',
  orange: '#e67e22',
};

const CONDITION_COLORS: Record<string, string> = {
  blinded: '#4a4a4a', charmed: '#ff69b4', deafened: '#95a5a6',
  frightened: '#9b59b6', grappled: '#e67e22', incapacitated: '#7f8c8d',
  invisible: '#3498db', paralyzed: '#f1c40f', petrified: '#bdc3c7',
  poisoned: '#27ae60', prone: '#e74c3c', restrained: '#c0392b',
  stunned: '#f39c12', unconscious: '#2c3e50', exhaustion: '#8e44ad',
};

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') try { return JSON.parse(val); } catch { return fallback; }
  return (val as T) ?? fallback;
}

function fmtMod(n: number): string { return n >= 0 ? `+${n}` : String(n); }

export function TokenTooltip() {
  const hoveredTokenId = useMapStore((s) => s.hoveredTokenId);
  const hoverPosition = useMapStore((s) => s.hoverPosition);
  const tokens = useMapStore((s) => s.tokens);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const combatants = useCombatStore((s) => s.combatants);

  const [visibleTokenId, setVisibleTokenId] = useState<string | null>(null);
  const [fetchedIds] = useState(() => new Set<string>());

  useEffect(() => {
    if (!hoveredTokenId) { setVisibleTokenId(null); return; }
    const timer = setTimeout(() => setVisibleTokenId(hoveredTokenId), HOVER_DELAY);
    return () => clearTimeout(timer);
  }, [hoveredTokenId]);

  // Auto-fetch character data if missing from store
  useEffect(() => {
    if (!visibleTokenId) return;
    const token = tokens[visibleTokenId];
    if (!token?.characterId) return;
    const charId = token.characterId;
    if (allCharacters[charId] || fetchedIds.has(charId)) return;
    fetchedIds.add(charId);
    fetch(`/api/characters/${charId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          useCharacterStore.getState().setAllCharacters({
            ...useCharacterStore.getState().allCharacters,
            [charId]: data,
          });
        }
      })
      .catch(() => {});
  }, [visibleTokenId, tokens, allCharacters, fetchedIds]);

  if (!visibleTokenId || !hoverPosition) return null;

  const token = tokens[visibleTokenId];
  if (!token) return null;

  const character = token.characterId ? allCharacters[token.characterId] : null;
  const combatant = combatants.find((c) => c.tokenId === visibleTokenId);
  const isOwner = token.ownerUserId === userId;
  const showFullInfo = isDM || isOwner;

  let hp: number | null = combatant?.hp ?? character?.hitPoints ?? null;
  let maxHp: number | null = combatant?.maxHp ?? character?.maxHitPoints ?? null;
  let ac: number | null = character?.armorClass ?? combatant?.armorClass ?? null;

  const conditions = token.conditions ?? [];
  const portraitUrl = token.imageUrl || character?.portraitUrl || null;

  // Parse character data for GM view
  const abilityScores = character ? parse<Record<string, number>>(character.abilityScores, {}) : null;
  const spells = character ? parse<any[]>(character.spells, []) : [];
  const speed = character?.speed ?? combatant?.speed ?? null;

  // Position - keep tooltip on screen
  const tooltipX = Math.min(hoverPosition.x + 16, typeof window !== 'undefined' ? window.innerWidth - 340 : 600);
  const tooltipY = Math.max(hoverPosition.y - 8, 20);

  return (
    <div style={{
      position: 'fixed', left: tooltipX, top: tooltipY, zIndex: 10000,
      pointerEvents: 'none', transform: 'translateY(-100%)',
      animation: 'tooltipFadeIn 0.15s ease',
    }}>
      <div style={{
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)', padding: 0,
        minWidth: showFullInfo ? 280 : 160, maxWidth: 320,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: C.text, fontSize: 12, overflow: 'hidden',
      }}>
        {/* Large portrait */}
        {showFullInfo && portraitUrl && (
          <div style={{
            display: 'flex', justifyContent: 'center', padding: '12px 12px 0',
            background: C.bgCard,
          }}>
            <div style={{
              width: 100, height: 100, borderRadius: '50%', overflow: 'hidden',
              border: `3px solid ${isOwner ? C.green : token.ownerUserId ? '#4a9fd5' : C.red}`,
              boxShadow: `0 0 12px ${isOwner ? 'rgba(69,160,73,0.4)' : 'rgba(197,49,49,0.4)'}`,
            }}>
              <img src={portraitUrl} alt={token.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          </div>
        )}

        {/* Header info */}
        <div style={{
          display: 'flex', gap: 10, padding: showFullInfo && portraitUrl ? '6px 12px 10px' : '10px 12px',
          background: C.bgCard, borderBottom: `1px solid ${C.border}`,
          alignItems: 'center', justifyContent: showFullInfo && portraitUrl ? 'center' : 'flex-start',
          flexDirection: showFullInfo && portraitUrl ? 'column' : 'row',
        }}>
          {/* Small portrait fallback when no image or not GM */}
          {(!showFullInfo || !portraitUrl) && (
            portraitUrl ? (
              <div style={{
                width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
                border: `2px solid ${isOwner ? C.green : C.red}`,
              }}>
                <img src={portraitUrl} alt={token.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            ) : (
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                background: token.color || '#555',
                border: `2px solid ${isOwner ? C.green : C.red}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, fontWeight: 700, color: '#fff',
              }}>
                {token.name[0]}
              </div>
            )
          )}
          <div style={{ textAlign: showFullInfo && portraitUrl ? 'center' : 'left', minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.text, lineHeight: 1.2 }}>
              {token.name}
            </div>
            {showFullInfo && character && (
              <div style={{ fontSize: 11, color: C.textSec, marginTop: 2 }}>
                {character.race} {character.class} Lv{character.level}
              </div>
            )}
            {/* Quick stats inline */}
            {showFullInfo && (
              <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 11 }}>
                {ac !== null && (
                  <span><span style={{ color: C.textMuted }}>AC</span> <strong>{ac}</strong></span>
                )}
                {speed !== null && (
                  <span><span style={{ color: C.textMuted }}>SPD</span> <strong>{speed}ft</strong></span>
                )}
                {character?.initiative !== undefined && (
                  <span><span style={{ color: C.textMuted }}>INIT</span> <strong>{fmtMod(character.initiative)}</strong></span>
                )}
                {hp !== null && maxHp !== null && (
                  <span><span style={{ color: C.textMuted }}>HP</span> <strong style={{ color: hp / maxHp > 0.5 ? C.green : hp / maxHp > 0.25 ? C.yellow : C.red }}>{hp}/{maxHp}</strong></span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* HP Bar */}
        {showFullInfo && hp !== null && maxHp !== null && maxHp > 0 && (
          <div style={{ padding: '6px 12px 4px', background: C.bgCard }}>
            <div style={{
              width: '100%', height: 8, background: 'rgba(0,0,0,0.5)',
              borderRadius: 4, overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', borderRadius: 4,
                width: `${Math.max(0, Math.min(100, (hp / maxHp) * 100))}%`,
                background: hp / maxHp > 0.5 ? C.green : hp / maxHp > 0.25 ? C.yellow : C.red,
                transition: 'width 0.2s ease',
              }} />
            </div>
          </div>
        )}

        {/* GM: Full ability scores */}
        {showFullInfo && abilityScores && Object.keys(abilityScores).length > 0 && (
          <div style={{ padding: '6px 12px', borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
              {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).map(ab => {
                const score = abilityScores[ab] ?? 10;
                const mod = abilityModifier(score);
                return (
                  <div key={ab} style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 8, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>{ab}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{fmtMod(mod)}</div>
                    <div style={{ fontSize: 9, color: C.textMuted }}>{score}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* GM: Spells summary */}
        {showFullInfo && spells.length > 0 && (
          <div style={{ padding: '4px 12px 6px', borderTop: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.red, textTransform: 'uppercase', marginBottom: 3 }}>
              Spells ({spells.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {spells.slice(0, 8).map((s: any, i: number) => (
                <span key={i} style={{
                  padding: '1px 5px', fontSize: 9, borderRadius: 3,
                  background: C.bgElevated, border: `1px solid ${C.border}`,
                  color: s.level === 0 ? C.textSec : C.text,
                }}>
                  {s.name}
                </span>
              ))}
              {spells.length > 8 && (
                <span style={{ fontSize: 9, color: C.textMuted }}>+{spells.length - 8} more</span>
              )}
            </div>
          </div>
        )}

        {/* Conditions */}
        {conditions.length > 0 && (
          <div style={{ padding: '4px 12px 6px', borderTop: `1px solid ${C.border}`, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {conditions.map((cond) => (
              <span key={cond} style={{
                padding: '1px 6px', fontSize: 9, fontWeight: 600,
                background: `${CONDITION_COLORS[cond] || '#888'}33`,
                border: `1px solid ${CONDITION_COLORS[cond] || '#888'}`,
                borderRadius: 8, color: CONDITION_COLORS[cond] || '#888',
                textTransform: 'capitalize',
              }}>
                {cond}
              </span>
            ))}
          </div>
        )}

        {/* Non-GM: just show name for enemy tokens */}
        {!showFullInfo && !isOwner && (
          <div style={{ padding: '4px 12px 6px', fontSize: 10, color: C.textMuted, fontStyle: 'italic' }}>
            Enemy creature
          </div>
        )}
      </div>

      <style>{`
        @keyframes tooltipFadeIn {
          from { opacity: 0; transform: translateY(calc(-100% + 4px)); }
          to { opacity: 1; transform: translateY(-100%); }
        }
      `}</style>
    </div>
  );
}
