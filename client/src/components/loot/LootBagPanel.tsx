import { useState, useEffect, useCallback } from 'react';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { theme } from '../../styles/theme';

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
};

const RARITY_COLORS: Record<string, string> = {
  common: '#9d9d9d',
  uncommon: '#1eff00',
  rare: '#0070dd',
  'very rare': '#a335ee',
  legendary: '#ff8000',
  artifact: '#e6cc80',
};

interface LootEntry {
  id: string;
  character_id: string;
  item_slug: string | null;
  custom_item_id: string | null;
  item_name: string;
  item_rarity: string;
  quantity: number;
  sort_order: number;
}

interface LootBagPanelProps {
  characterId: string;
  creatureName: string;
}

export function LootBagPanel({ characterId, creatureName }: LootBagPanelProps) {
  const [loot, setLoot] = useState<LootEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [takingId, setTakingId] = useState<string | null>(null);
  const isDM = useSessionStore((s) => s.isDM);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const tokens = useMapStore((s) => s.tokens);

  const fetchLoot = useCallback(() => {
    setLoading(true);
    fetch(`/api/characters/${characterId}/loot`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setLoot(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [characterId]);

  useEffect(() => { fetchLoot(); }, [fetchLoot]);

  // Get player characters (non-NPC) for the "Give to" / "Take" feature
  const playerCharacters = Object.values(allCharacters).filter(
    c => c.userId !== 'npc' && c.id !== characterId
  );

  // Also derive from tokens for player characters that may not be in allCharacters
  const playerTokens = Object.values(tokens).filter(t => t.ownerUserId && t.characterId);

  const takeItem = async (entryId: string, targetCharacterId: string) => {
    setTakingId(entryId);
    try {
      const resp = await fetch(`/api/characters/${characterId}/loot/take`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, targetCharacterId }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.inventory && data.targetCharacterId) {
          useCharacterStore.getState().applyRemoteUpdate(data.targetCharacterId, { inventory: data.inventory });
        }
      }
      // Re-fetch loot — if empty, remove the dropped item token from map
      const lootResp = await fetch(`/api/characters/${characterId}/loot`);
      const remaining = lootResp.ok ? await lootResp.json() : [];
      setLoot(remaining);
      if (remaining.length === 0) {
        // Find and remove the token for this loot bag
        const tokens = useMapStore.getState().tokens;
        const lootToken = Object.values(tokens).find((t: any) => t.characterId === characterId);
        if (lootToken) {
          const { emitTokenRemove } = await import('../../socket/emitters');
          emitTokenRemove((lootToken as any).id);
        }
      }
      window.dispatchEvent(new Event('loot-updated'));
      // Pull the snapshot so the target character's inventory (and
      // the source loot-bag's remaining entries) reconcile on every
      // client without waiting for the 5 s tick.
      const { triggerSnapshot } = await import('../../socket/stateSnapshot');
      triggerSnapshot('loot:take');
    } catch { /* ignore */ }
    setTakingId(null);
  };

  return (
    <div style={{ padding: '6px 0' }}>
      {/* Loot bag header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', marginBottom: 6,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(197,49,49,0.15)', border: '1px solid rgba(197,49,49,0.3)', fontSize: 14, flexShrink: 0,
        }}>💀</div>
        <div>
          <div style={{ fontSize: 8, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Remains
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{creatureName}</div>
        </div>
      </div>

      {/* Loot list */}
      {loading ? (
        <div style={{ fontSize: 10, color: C.textMuted, textAlign: 'center', padding: 12 }}>Loading loot...</div>
      ) : loot.length === 0 ? (
        <div style={{ fontSize: 10, color: C.textMuted, textAlign: 'center', padding: 12 }}>
          No loot found on this creature.
          {isDM && (
            <div style={{ marginTop: 4, fontSize: 9, color: C.textMuted }}>
              Right-click the token and select "Edit Loot" to add items.
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '0 10px' }}>
          {loot.map(entry => (
            <div key={entry.id} style={{
              padding: '5px 0', borderBottom: `1px solid ${C.borderDim}`,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600,
                  color: RARITY_COLORS[entry.item_rarity?.toLowerCase()] || C.text,
                }}>
                  {entry.item_name}
                  {entry.quantity > 1 && (
                    <span style={{ color: C.textMuted, fontWeight: 400 }}> x{entry.quantity}</span>
                  )}
                </div>
                <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'capitalize' }}>
                  {entry.item_rarity}
                </div>
              </div>

              {/* Take/Give buttons */}
              {isDM ? (
                <DmGiveDropdown
                  playerCharacters={playerCharacters}
                  playerTokens={playerTokens}
                  allCharacters={allCharacters}
                  disabled={takingId === entry.id}
                  onGive={(targetId) => takeItem(entry.id, targetId)}
                />
              ) : (
                <button
                  disabled={takingId === entry.id || playerCharacters.length === 0}
                  onClick={() => {
                    const myChar = useCharacterStore.getState().myCharacter;
                    if (myChar) takeItem(entry.id, myChar.id);
                  }}
                  style={{
                    padding: '3px 10px', fontSize: 9, fontWeight: 600,
                    background: `${C.green}22`, border: `1px solid ${C.green}44`,
                    borderRadius: 4, color: C.green, cursor: 'pointer', fontFamily: 'inherit',
                    opacity: takingId === entry.id ? 0.5 : 1,
                  }}
                >
                  {takingId === entry.id ? '...' : 'Take'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DmGiveDropdownProps {
  playerCharacters: any[];
  playerTokens: any[];
  allCharacters: Record<string, any>;
  disabled: boolean;
  onGive: (targetCharId: string) => void;
}

function DmGiveDropdown({ playerCharacters, playerTokens, allCharacters, disabled, onGive }: DmGiveDropdownProps) {
  const [open, setOpen] = useState(false);

  // Combine sources of player characters
  const targets = new Map<string, string>();
  for (const c of playerCharacters) {
    targets.set(c.id, c.name);
  }
  for (const t of playerTokens) {
    if (t.characterId && !targets.has(t.characterId)) {
      const char = allCharacters[t.characterId];
      targets.set(t.characterId, char?.name || t.name);
    }
  }

  if (targets.size === 0) {
    return <span style={{ fontSize: 8, color: C.textMuted }}>No players</span>;
  }

  if (targets.size === 1) {
    const [charId, charName] = [...targets.entries()][0];
    return (
      <button
        disabled={disabled}
        onClick={() => onGive(charId)}
        style={{
          padding: '3px 8px', fontSize: 9, fontWeight: 600,
          background: `${C.gold}22`, border: `1px solid ${C.gold}44`,
          borderRadius: 4, color: C.gold, cursor: 'pointer', fontFamily: 'inherit',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        Give to {charName}
      </button>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        style={{
          padding: '3px 8px', fontSize: 9, fontWeight: 600,
          background: `${C.gold}22`, border: `1px solid ${C.gold}44`,
          borderRadius: 4, color: C.gold, cursor: 'pointer', fontFamily: 'inherit',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        Give to...
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 2,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)', minWidth: 120, zIndex: 10,
        }}>
          {[...targets.entries()].map(([charId, charName]) => (
            <div
              key={charId}
              onClick={() => { onGive(charId); setOpen(false); }}
              style={{
                padding: '5px 10px', fontSize: 10, cursor: 'pointer', color: C.text,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {charName}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
