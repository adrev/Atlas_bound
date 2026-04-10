import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSceneStore } from '../../stores/useSceneStore';
import {
  emitPreviewLoadMap, emitActivateMapForPlayers, emitTokenAdd,
} from '../../socket/emitters';
import { Button } from '../ui';

/**
 * Docked banner shown above the canvas when a DM is previewing a
 * different map than the players. Reminds the DM "players aren't
 * seeing this" and offers two quick actions:
 *   • Jump to Players — preview-load the player ribbon map
 *   • Move Players Here — drop the ribbon on the DM's current view
 *
 * Rewritten for the UI unification pass to use the Button primitive
 * and shared theme tokens (no more hardcoded colors).
 */
export function PreviewModeBanner() {
  const isDM = useSessionStore((s) => s.isDM);
  const isPreviewing = useMapStore((s) => s.isDmPreviewingDifferentMap);
  const currentMap = useMapStore((s) => s.currentMap);
  const playerMapId = useMapStore((s) => s.playerMapId);
  const stagedHeroes = useMapStore((s) => s.stagedHeroes);
  const maps = useSceneStore((s) => s.maps);

  const playerMapSummary = useMemo(
    () => maps.find((m) => m.id === playerMapId) ?? null,
    [maps, playerMapId],
  );

  // Tracks the currentMap.id the DM manually dismissed the banner
  // for. Reset whenever the DM switches to a different preview map so
  // the banner re-appears naturally.
  const [dismissedForMapId, setDismissedForMapId] = useState<string | null>(null);
  useEffect(() => {
    if (currentMap?.id !== dismissedForMapId) setDismissedForMapId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMap?.id]);

  if (!isDM) return null;
  if (!isPreviewing) return null;
  if (!currentMap) return null;
  if (dismissedForMapId === currentMap.id) return null;

  const hasStaged = stagedHeroes.length > 0;

  const handleJumpToPlayers = () => {
    if (playerMapId) emitPreviewLoadMap(playerMapId);
  };

  /** Build a characterId -> ownerUserId lookup from the session players. */
  const buildOwnerMap = () => {
    const players = useSessionStore.getState().players;
    const map: Record<string, string> = {};
    for (const p of players) {
      if (p.characterId) map[p.characterId] = p.userId;
    }
    return map;
  };

  const handleStageHeroes = () => {
    if (hasStaged) {
      useMapStore.getState().clearStagedHeroes();
      return;
    }

    const players = useSessionStore.getState().players.filter(
      (p) => p.role === 'player' && p.characterId && p.connected,
    );
    const allChars = useCharacterStore.getState().allCharacters;
    const mapWidth = currentMap.width;
    const mapHeight = currentMap.height;
    const gridSize = currentMap.gridSize;

    // Place heroes in a centered horizontal line
    const count = players.length;
    const totalWidth = count * gridSize;
    const startX = Math.round((mapWidth - totalWidth) / 2) + gridSize / 2;
    const centerY = Math.round(mapHeight / 2);

    const heroes = players.map((p, i) => {
      const char = allChars[p.characterId!];
      return {
        characterId: p.characterId!,
        name: char?.name ?? p.displayName,
        portraitUrl: char?.portraitUrl ?? null,
        x: startX + i * gridSize,
        y: centerY,
        ownerUserId: p.userId,
      };
    });

    useMapStore.getState().stageHeroes(heroes);
  };

  const handleMovePlayersHere = () => {
    // Pass staged positions directly with the activate event so the
    // server can place tokens atomically instead of racing separate
    // token-add events against the migration logic.
    if (hasStaged) {
      const ownerMap = buildOwnerMap();
      const positions = stagedHeroes.map((hero) => ({
        characterId: hero.characterId,
        name: hero.name,
        x: hero.x,
        y: hero.y,
        imageUrl: hero.portraitUrl,
        ownerUserId: ownerMap[hero.characterId] ?? hero.ownerUserId,
      }));
      useMapStore.getState().clearStagedHeroes();
      emitActivateMapForPlayers(currentMap.id, positions);
    } else {
      emitActivateMapForPlayers(currentMap.id);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: theme.space.lg,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space.md,
        padding: `8px ${theme.space.md}px 8px 10px`,
        borderRadius: theme.radius.md,
        background: 'rgba(24, 20, 14, 0.96)',
        border: `1px solid ${theme.gold.border}`,
        boxShadow: `${theme.shadow.lg}, ${theme.goldGlow.soft}`,
        color: theme.text.primary,
        fontFamily: theme.font.body,
        whiteSpace: 'nowrap' as const,
      }}
    >
      {/* "PREVIEW" chip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: theme.radius.sm,
          background: theme.gold.bg,
          border: `1px solid ${theme.gold.border}`,
          color: theme.gold.primary,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase' as const,
          boxShadow: theme.goldGlow.soft,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>{EMOJI.map.viewing}</span>
        Preview
      </div>

      {/* Description — single line */}
      <span
        style={{
          fontSize: 12,
          color: theme.text.secondary,
          lineHeight: 1.2,
        }}
      >
        Viewing{' '}
        <strong style={{ color: theme.gold.primary, fontWeight: 600 }}>
          {currentMap.name}
        </strong>
        {' · '}
        Players on{' '}
        <strong style={{ color: theme.text.primary, fontWeight: 600 }}>
          {playerMapSummary?.name ?? 'another map'}
        </strong>
        {playerMapSummary && (
          <span style={{ color: theme.text.muted, fontWeight: 400 }}>
            {' '}({playerMapSummary.tokenCount} token
            {playerMapSummary.tokenCount !== 1 ? 's' : ''})
          </span>
        )}
      </span>

      {/* Actions */}
      <div style={{ display: 'flex', gap: theme.space.sm, flexShrink: 0, marginLeft: theme.space.sm }}>
        {playerMapId && (
          <Button variant="ghost" size="sm" onClick={handleJumpToPlayers}>
            Jump to Players
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleStageHeroes}>
          {hasStaged ? 'Clear Staging' : 'Stage Heroes'}
        </Button>
        <Button variant="primary" size="sm" onClick={handleMovePlayersHere}>
          Move Players Here
        </Button>
      </div>

      {/* Dismiss */}
      <button
        onClick={() => setDismissedForMapId(currentMap.id)}
        title="Dismiss (banner returns if you preview a different map)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          padding: 0,
          background: 'transparent',
          border: `1px solid ${theme.border.default}`,
          borderRadius: 4,
          color: theme.text.muted,
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = theme.gold.primary;
          e.currentTarget.style.borderColor = theme.gold.primary;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = theme.text.muted;
          e.currentTarget.style.borderColor = theme.border.default;
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
