import { useCallback } from 'react';
import type { KonvaEventObject } from 'konva/lib/Node';
import { snapToGrid } from '@dnd-vtt/shared';
import { emitTokenMove, emitUseMovement } from '../socket/emitters';
import { useMapStore } from '../stores/useMapStore';
import { useSessionStore } from '../stores/useSessionStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useDrawStore } from '../stores/useDrawStore';

/**
 * Opportunity Attack detection used to live here as a client-side
 * chat-message-only system. It now lives on the server in
 * OpportunityAttackService.detectOpportunityAttacks, which is called
 * from the map:token-move handler. The server emits
 * combat:oa-opportunity to the attacker's owner, and the
 * OpportunityAttackModal pops a real prompt with Attack / Let them go
 * buttons. See client/src/components/combat/OpportunityAttackModal.tsx
 * for the UI side.
 */

/**
 * Tiny transient overlay shown when a drag is rejected for exceeding
 * the current combatant's remaining movement. Uses the same styling
 * vocabulary as the rest of the in-canvas toasts so it feels native.
 */
function showMovementDeniedToast(attempted: number, remaining: number, max: number) {
  const existing = document.getElementById('movement-denied-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'movement-denied-toast';
  toast.innerHTML = `
    <div style="font-size:13px;font-weight:700;color:#c53131;margin-bottom:4px">
      Movement exceeded
    </div>
    <div style="font-size:11px;color:#ccc;line-height:1.5">
      Tried to move <b>${attempted} ft</b> but only
      <b>${remaining} / ${max} ft</b> remain this turn.<br/>
      Take the Dash action for more movement, or End Turn to reset.
    </div>
  `;
  Object.assign(toast.style, {
    position: 'fixed', top: '18%', left: '50%',
    transform: 'translateX(-50%)',
    padding: '12px 18px', background: '#1a1a1a', color: '#eee',
    borderRadius: '8px', border: '2px solid #c53131',
    zIndex: '99999', minWidth: '260px', maxWidth: '360px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

export function useDragToken(tokenId: string) {
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const gridOffsetX = useMapStore((s) => s.currentMap?.gridOffsetX ?? 0);
  const gridOffsetY = useMapStore((s) => s.currentMap?.gridOffsetY ?? 0);

  const lockedTokenIds = useMapStore((s) => s.lockedTokenIds);

  // Subscribe to isDrawMode so the token component re-renders when
  // draw mode toggles. Without this subscription, `canDrag()` would
  // read the latest value but the memoized callback's consumers
  // (TokenLayer setting `draggable={canDrag()}` in a Konva Group)
  // wouldn't update until some OTHER state change triggered a render.
  const isDrawMode = useDrawStore((s) => s.isDrawMode);

  const canDrag = useCallback(() => {
    const token = useMapStore.getState().tokens[tokenId];
    const userId = useSessionStore.getState().userId;
    const isDM = useSessionStore.getState().isDM;
    const combat = useCombatStore.getState();
    const locked = useMapStore.getState().lockedTokenIds;

    if (!token) return false;

    // While in draw mode, every click is a draw stroke — tokens are
    // frozen so the DM can draw freely over them without grabbing.
    if (isDrawMode) return false;

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
  }, [tokenId, lockedTokenIds, isDrawMode]);

  const handleDragStart = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target;
      // Capture the start position from the live token state — this
      // is the "ghost anchor" the preview line draws back to.
      const tok = useMapStore.getState().tokens[tokenId];
      const startX = tok?.x ?? node.x();
      const startY = tok?.y ?? node.y();
      useMapStore.getState().beginDragPreview({
        tokenId,
        startX,
        startY,
        currentX: startX,
        currentY: startY,
      });
    },
    [tokenId],
  );

  const handleDragEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target;

      // Remember where the token was BEFORE the drag so we can work
      // out how far it travelled and deduct movement from the action
      // economy if combat is active. Use the dragPreview start, which
      // was captured in handleDragStart, falling back to the token
      // store value (DM teleports could skip the start handler).
      const previewStart = useMapStore.getState().dragPreview;
      const prevToken = useMapStore.getState().tokens[tokenId];
      const prevX = previewStart?.startX ?? prevToken?.x ?? node.x();
      const prevY = previewStart?.startY ?? prevToken?.y ?? node.y();

      const snapped = snapToGrid(
        node.x(),
        node.y(),
        gridSize,
        gridOffsetX,
        gridOffsetY
      );

      // Convert pixel delta → feet using Chebyshev (5e "variant")
      // distance on the grid. A diagonal square costs 5 ft (same as
      // orthogonal) which matches how the MovementRangeLayer draws
      // reachable cells. Round to the nearest square so a slight snap
      // wobble doesn't cost an extra 5 ft.
      const dxPx = snapped.x - prevX;
      const dyPx = snapped.y - prevY;
      const cellsX = Math.round(Math.abs(dxPx) / gridSize);
      const cellsY = Math.round(Math.abs(dyPx) / gridSize);
      const cellsMoved = Math.max(cellsX, cellsY);
      const feet = cellsMoved * 5;

      const combat = useCombatStore.getState();
      const isActiveCombatant = combat.active &&
        combat.combatants[combat.currentTurnIndex]?.tokenId === tokenId;

      // ── Enforce movement limit ────────────────────────────────
      // In combat, the current combatant can't exceed their remaining
      // movement. If they try, snap the token back to its start
      // position and pop a warning toast so they can see why. This
      // applies even to the DM when controlling the current combatant
      // — play Dash to get more movement, or End Turn to reset.
      if (isActiveCombatant && feet > combat.actionEconomy.movementRemaining) {
        node.position({ x: prevX, y: prevY });
        showMovementDeniedToast(
          feet,
          combat.actionEconomy.movementRemaining,
          combat.actionEconomy.movementMax,
        );
        useMapStore.getState().endDragPreview();
        return;
      }

      node.position(snapped);
      useMapStore.getState().moveToken(tokenId, snapped.x, snapped.y);
      emitTokenMove(tokenId, snapped.x, snapped.y);

      // Deduct movement from the action economy when combat is active
      // AND the dragged token belongs to the CURRENT combatant. DM
      // dragging a non-current token during combat is treated as a
      // free teleport (useful for placing NPCs) — only the active
      // combatant burns their move pool.
      if (isActiveCombatant && feet > 0) {
        emitUseMovement(feet);
      }

      // Opportunity Attack detection now happens server-side in the
      // map:token-move handler. The server emits combat:oa-opportunity
      // to the attacker's owner, which the OpportunityAttackModal
      // picks up and renders as a real prompt.

      // Clear the drag preview overlay (ghost + line + label).
      useMapStore.getState().endDragPreview();
    },
    [tokenId, gridSize, gridOffsetX, gridOffsetY]
  );

  const handleDragMove = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      // Snap-preview while dragging.
      const node = e.target;
      const snapped = snapToGrid(
        node.x(),
        node.y(),
        gridSize,
        gridOffsetX,
        gridOffsetY
      );
      node.position(snapped);
      // Update the drag-preview state so the ghost-line layer can
      // redraw the blue distance line + ft label live.
      useMapStore.getState().updateDragPreview(snapped.x, snapped.y);
    },
    [gridSize, gridOffsetX, gridOffsetY]
  );

  return {
    draggable: canDrag(),
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    onDragMove: handleDragMove,
  };
}
