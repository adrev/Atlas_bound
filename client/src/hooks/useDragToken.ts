import { useCallback } from 'react';
import type { KonvaEventObject } from 'konva/lib/Node';
import { snapToGrid } from '@dnd-vtt/shared';
import { emitTokenMove } from '../socket/emitters';
import { useMapStore } from '../stores/useMapStore';
import { useSessionStore } from '../stores/useSessionStore';
import { useCombatStore } from '../stores/useCombatStore';

export function useDragToken(tokenId: string) {
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const gridOffsetX = useMapStore((s) => s.currentMap?.gridOffsetX ?? 0);
  const gridOffsetY = useMapStore((s) => s.currentMap?.gridOffsetY ?? 0);

  const lockedTokenIds = useMapStore((s) => s.lockedTokenIds);

  const canDrag = useCallback(() => {
    const token = useMapStore.getState().tokens[tokenId];
    const userId = useSessionStore.getState().userId;
    const isDM = useSessionStore.getState().isDM;
    const combat = useCombatStore.getState();
    const locked = useMapStore.getState().lockedTokenIds;

    if (!token) return false;

    // Locked tokens cannot be dragged
    if (locked.has(tokenId)) return false;

    // DM can always move tokens
    if (isDM) return true;

    // Check ownership
    if (token.ownerUserId !== userId) return false;

    // In combat, can only move on your turn
    if (combat.active) {
      const currentCombatant = combat.combatants[combat.currentTurnIndex];
      if (currentCombatant?.tokenId !== tokenId) return false;
    }

    return true;
  }, [tokenId, lockedTokenIds]);

  const handleDragEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target;
      const snapped = snapToGrid(
        node.x(),
        node.y(),
        gridSize,
        gridOffsetX,
        gridOffsetY
      );

      node.position(snapped);
      useMapStore.getState().moveToken(tokenId, snapped.x, snapped.y);
      emitTokenMove(tokenId, snapped.x, snapped.y);
    },
    [tokenId, gridSize, gridOffsetX, gridOffsetY]
  );

  const handleDragMove = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      // Optional: snap preview while dragging
      const node = e.target;
      const snapped = snapToGrid(
        node.x(),
        node.y(),
        gridSize,
        gridOffsetX,
        gridOffsetY
      );
      node.position(snapped);
    },
    [gridSize, gridOffsetX, gridOffsetY]
  );

  return {
    draggable: canDrag(),
    onDragEnd: handleDragEnd,
    onDragMove: handleDragMove,
  };
}
