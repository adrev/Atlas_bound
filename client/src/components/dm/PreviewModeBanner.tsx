import { useMemo } from 'react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useSceneStore } from '../../stores/useSceneStore';
import {
  emitPreviewLoadMap, emitActivateMapForPlayers,
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
  const maps = useSceneStore((s) => s.maps);

  const playerMapSummary = useMemo(
    () => maps.find((m) => m.id === playerMapId) ?? null,
    [maps, playerMapId],
  );

  if (!isDM) return null;
  if (!isPreviewing) return null;
  if (!currentMap) return null;

  const handleJumpToPlayers = () => {
    if (playerMapId) emitPreviewLoadMap(playerMapId);
  };

  const handleMovePlayersHere = () => {
    emitActivateMapForPlayers(currentMap.id);
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
        gap: theme.space.lg,
        padding: `${theme.space.md}px ${theme.space.lg + 2}px`,
        borderRadius: theme.radius.md,
        background: 'rgba(24, 20, 14, 0.96)',
        border: `1px solid ${theme.gold.border}`,
        boxShadow: `${theme.shadow.lg}, ${theme.goldGlow.soft}`,
        color: theme.text.primary,
        fontFamily: theme.font.body,
        minWidth: 420,
        maxWidth: '90%',
      }}
    >
      {/* Icon badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: theme.gold.bg,
          border: `1px solid ${theme.gold.border}`,
          fontSize: 18,
          boxShadow: theme.goldGlow.soft,
        }}
      >
        {EMOJI.map.viewing}
      </div>

      {/* Text */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            ...theme.type.h3,
            color: theme.gold.primary,
          }}
        >
          Preview Mode
        </span>
        <span
          style={{
            ...theme.type.small,
            color: theme.text.secondary,
            whiteSpace: 'nowrap' as const,
            overflow: 'hidden',
            textOverflow: 'ellipsis' as const,
          }}
        >
          Players are on{' '}
          <strong style={{ color: theme.text.primary, fontWeight: 600 }}>
            {playerMapSummary?.name ?? 'another map'}
          </strong>
          {playerMapSummary && (
            <>
              {' '}
              ({playerMapSummary.tokenCount} token
              {playerMapSummary.tokenCount !== 1 ? 's' : ''})
            </>
          )}
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: theme.space.sm, flexShrink: 0 }}>
        {playerMapId && (
          <Button variant="ghost" size="sm" onClick={handleJumpToPlayers}>
            Jump to Players
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={handleMovePlayersHere}>
          Move Players to {currentMap.name}
        </Button>
      </div>
    </div>
  );
}
