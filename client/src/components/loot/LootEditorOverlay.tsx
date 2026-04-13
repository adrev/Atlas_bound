import { useState, useEffect } from 'react';
import { LootEditor } from './LootEditor';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';

/**
 * Global overlay that listens for 'open-loot-editor' events and shows the LootEditor modal.
 * Mount once in the app (e.g. in BattleMap).
 */
export function LootEditorOverlay() {
  const [state, setState] = useState<{ characterId: string; tokenName: string } | null>(null);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.characterId) {
        setState({ characterId: detail.characterId, tokenName: detail.tokenName || '' });
      }
    };
    window.addEventListener('open-loot-editor', handler);
    return () => window.removeEventListener('open-loot-editor', handler);
  }, []);

  if (!state) return null;

  // Determine if the current user can edit this character's inventory.
  // DM can always edit. Players can only edit their own characters.
  const tokens = useMapStore.getState().tokens;
  const ownerToken = Object.values(tokens).find(
    (t: any) => t.characterId === state.characterId,
  );
  const canEdit = isDM || (ownerToken && (ownerToken as any).ownerUserId === userId);

  return (
    <LootEditor
      characterId={state.characterId}
      tokenName={state.tokenName}
      onClose={() => setState(null)}
      canEdit={!!canEdit}
    />
  );
}
