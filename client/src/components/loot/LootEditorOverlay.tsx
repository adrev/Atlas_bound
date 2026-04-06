import { useState, useEffect } from 'react';
import { LootEditor } from './LootEditor';

/**
 * Global overlay that listens for 'open-loot-editor' events and shows the LootEditor modal.
 * Mount once in the app (e.g. in BattleMap).
 */
export function LootEditorOverlay() {
  const [state, setState] = useState<{ characterId: string; tokenName: string } | null>(null);

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

  return (
    <LootEditor
      characterId={state.characterId}
      tokenName={state.tokenName}
      onClose={() => setState(null)}
    />
  );
}
