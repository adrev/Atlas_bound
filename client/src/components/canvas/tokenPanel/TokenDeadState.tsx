import { LootBagPanel } from '../../loot/LootBagPanel';
import { C } from './styles';

/**
 * Rendered when a token is at 0 HP. NPCs flip into a loot bag (players
 * can pull items the creature was carrying); PCs show a resurrection
 * hint instead since PC death doesn't drop inventory in 5e.
 */
export function TokenDeadState({
  hp,
  maxHp,
  isNPC,
  characterId,
  tokenName,
}: {
  hp: number;
  maxHp: number;
  isNPC: boolean;
  characterId: string | null;
  tokenName: string;
}) {
  if (!(hp <= 0 && maxHp > 0)) return null;

  if (isNPC && characterId) {
    return <LootBagPanel characterId={characterId} creatureName={tokenName} />;
  }

  if (!isNPC) {
    return (
      <div
        style={{
          padding: '12px 10px',
          textAlign: 'center',
          borderRadius: 6,
          background: 'rgba(197,49,49,0.1)',
          border: `1px solid ${C.red}33`,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: C.red, marginBottom: 4 }}>DEAD</div>
        <div style={{ fontSize: 10, color: C.textSec }}>This character can be resurrected</div>
      </div>
    );
  }

  return null;
}
