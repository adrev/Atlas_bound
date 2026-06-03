export interface ViewportTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export interface VisibleMapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getVisibleMapRect(
  mapWidth: number,
  mapHeight: number,
  viewport: ViewportTransform,
  stageWidth: number,
  stageHeight: number,
): VisibleMapRect | null {
  const scaleX = viewport.scaleX || 1;
  const scaleY = viewport.scaleY || 1;
  const left = Math.max(0, -viewport.x / scaleX);
  const top = Math.max(0, -viewport.y / scaleY);
  const right = Math.min(mapWidth, (stageWidth - viewport.x) / scaleX);
  const bottom = Math.min(mapHeight, (stageHeight - viewport.y) / scaleY);

  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
