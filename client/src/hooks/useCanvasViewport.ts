import { useCallback, useRef, useState } from 'react';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useMapStore } from '../stores/useMapStore';

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

      // Check if a tool is active (measure/wall) - don't pan during tool use
      // Check active tool from the map store - avoid panning during tool use
      const tool = useMapStore.getState().activeTool;
      const isToolActive = tool === 'measure' || tool === 'wall';

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

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleContextMenu = useCallback(
    (e: KonvaEventObject<PointerEvent>) => {
      e.evt.preventDefault();
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
    draggable: false,
  };

  const resetViewport = useCallback(() => {
    setViewport({ x: 0, y: 0, scale: 1 });
  }, []);

  return { viewport, stageProps, resetViewport, setViewport };
}
