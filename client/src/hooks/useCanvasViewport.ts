import { useCallback, useRef, useState } from 'react';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useMapStore } from '../stores/useMapStore';
import { useDrawStore } from '../stores/useDrawStore';

interface ViewportState {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const ZOOM_FACTOR = 1.1;

export function useCanvasViewport() {
  const [viewport, setViewport] = useState<ViewportState>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const isPanning = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  const handleWheel = useCallback(
    (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();

      const stage = e.target.getStage();
      if (!stage) return;

      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const direction = e.evt.deltaY < 0 ? 1 : -1;
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, viewport.scale * (direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR))
      );

      const mousePointTo = {
        x: (pointer.x - viewport.x) / viewport.scale,
        y: (pointer.y - viewport.y) / viewport.scale,
      };

      setViewport({
        scale: newScale,
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      });
    },
    [viewport]
  );

  const handleMouseDown = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      // Right-click = context menu, NOT panning
      if (e.evt.button === 2) return;

      // Check if a tool is active - don't pan during tool use. Zones
      // are included so a DM drawing a new zone on empty map space
      // gets the drag captured by ZoneLayer instead of panning.
      const tool = useMapStore.getState().activeTool;
      const isToolActive = tool === 'measure' || tool === 'wall' || tool === 'zone';

      // Middle mouse button ALWAYS pans (even during tool use)
      if (e.evt.button === 1) {
        e.evt.preventDefault();
        isPanning.current = true;
        lastPointer.current = { x: e.evt.clientX, y: e.evt.clientY };
        return;
      }
      // Left-click on empty space = pan ONLY if no tool is active
      if (e.evt.button === 0 && e.target === e.target.getStage() && !isToolActive) {
        isPanning.current = true;
        lastPointer.current = { x: e.evt.clientX, y: e.evt.clientY };
      }
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      if (!isPanning.current) return;

      const dx = e.evt.clientX - lastPointer.current.x;
      const dy = e.evt.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.evt.clientX, y: e.evt.clientY };

      setViewport((prev) => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy,
      }));
    },
    []
  );

  const handleMouseUp = useCallback((_e?: KonvaEventObject<MouseEvent>) => {
    isPanning.current = false;
  }, []);

  // --- Touch / pinch support for mobile + trackpad gestures. ---
  //
  // Konva forwards the native TouchEvent via `e.evt`. We track:
  //   one-finger drag → pan (same as left-mouse on empty map space)
  //   two-finger pinch → zoom, anchored on the midpoint between fingers
  //
  // We intentionally don't rely on Konva's built-in `draggable` on the
  // stage because that conflicts with the token drag layer and with
  // the map context-menu dispatcher above.
  const touch = useRef<{
    mode: 'none' | 'pan' | 'pinch';
    lastX: number; lastY: number;
    startDist: number;
    startScale: number;
    anchorMapX: number; anchorMapY: number;
  }>({ mode: 'none', lastX: 0, lastY: 0, startDist: 0, startScale: 1, anchorMapX: 0, anchorMapY: 0 });

  const handleTouchStart = useCallback((e: KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    const stage = e.target.getStage();
    if (!stage) return;
    if (touches.length === 1) {
      // Only pan on empty-stage touch — tokens / tools catch their own.
      if (e.target !== stage) return;
      touch.current.mode = 'pan';
      touch.current.lastX = touches[0].clientX;
      touch.current.lastY = touches[0].clientY;
    } else if (touches.length === 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      const rect = stage.container().getBoundingClientRect();
      const midX = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
      const midY = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
      touch.current.mode = 'pinch';
      touch.current.startDist = Math.hypot(dx, dy) || 1;
      touch.current.startScale = viewport.scale;
      // Anchor in map-space: the spot under the midpoint stays under
      // the midpoint while the user pinches.
      touch.current.anchorMapX = (midX - viewport.x) / viewport.scale;
      touch.current.anchorMapY = (midY - viewport.y) / viewport.scale;
      e.evt.preventDefault();
    }
  }, [viewport]);

  const handleTouchMove = useCallback((e: KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    const stage = e.target.getStage();
    if (!stage) return;
    if (touch.current.mode === 'pan' && touches.length === 1) {
      const dx = touches[0].clientX - touch.current.lastX;
      const dy = touches[0].clientY - touch.current.lastY;
      touch.current.lastX = touches[0].clientX;
      touch.current.lastY = touches[0].clientY;
      setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      e.evt.preventDefault();
    } else if (touch.current.mode === 'pinch' && touches.length === 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      const rect = stage.container().getBoundingClientRect();
      const midX = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
      const midY = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
      const dist = Math.hypot(dx, dy) || 1;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
        touch.current.startScale * (dist / touch.current.startDist)));
      setViewport({
        scale: nextScale,
        x: midX - touch.current.anchorMapX * nextScale,
        y: midY - touch.current.anchorMapY * nextScale,
      });
      e.evt.preventDefault();
    }
  }, []);

  const handleTouchEnd = useCallback((e: KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    if (touches.length === 0) touch.current.mode = 'none';
    else if (touches.length === 1) {
      touch.current.mode = 'pan';
      touch.current.lastX = touches[0].clientX;
      touch.current.lastY = touches[0].clientY;
    }
  }, []);

  const handleContextMenu = useCallback(
    (e: KonvaEventObject<PointerEvent>) => {
      e.evt.preventDefault();
      // Suppress the context menu entirely while in draw mode so the
      // DM can right-click-drag without the map menu popping up. Esc
      // exits draw mode when the DM wants access again.
      if (useDrawStore.getState().isDrawMode) return;
      // Right-click on empty map space = open map context menu
      if (e.target === e.target.getStage()) {
        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const container = stage.container().getBoundingClientRect();
        const mapX = (pointer.x - viewport.x) / viewport.scale;
        const mapY = (pointer.y - viewport.y) / viewport.scale;
        window.dispatchEvent(new CustomEvent('map-context-menu', {
          detail: {
            screenX: pointer.x + container.left,
            screenY: pointer.y + container.top,
            mapX, mapY,
          }
        }));
      }
    },
    [viewport]
  );

  const stageProps = {
    x: viewport.x,
    y: viewport.y,
    scaleX: viewport.scale,
    scaleY: viewport.scale,
    onWheel: handleWheel,
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
    onContextMenu: handleContextMenu,
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
    draggable: false,
  };

  const resetViewport = useCallback(() => {
    setViewport({ x: 0, y: 0, scale: 1 });
  }, []);

  return { viewport, stageProps, resetViewport, setViewport };
}
