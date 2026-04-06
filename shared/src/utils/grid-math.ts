/**
 * Snap a pixel position to the nearest grid cell center
 */
export function snapToGrid(
  pixelX: number,
  pixelY: number,
  gridSize: number,
  offsetX = 0,
  offsetY = 0
): { x: number; y: number } {
  const adjX = pixelX - offsetX;
  const adjY = pixelY - offsetY;
  return {
    x: Math.round(adjX / gridSize) * gridSize + offsetX,
    y: Math.round(adjY / gridSize) * gridSize + offsetY,
  };
}

/**
 * Convert pixel coordinates to grid cell coordinates
 */
export function pixelToGrid(
  pixelX: number,
  pixelY: number,
  gridSize: number,
  offsetX = 0,
  offsetY = 0
): { col: number; row: number } {
  return {
    col: Math.floor((pixelX - offsetX) / gridSize),
    row: Math.floor((pixelY - offsetY) / gridSize),
  };
}

/**
 * Convert grid cell coordinates to pixel position (top-left corner)
 */
export function gridToPixel(
  col: number,
  row: number,
  gridSize: number,
  offsetX = 0,
  offsetY = 0
): { x: number; y: number } {
  return {
    x: col * gridSize + offsetX,
    y: row * gridSize + offsetY,
  };
}

/**
 * Calculate distance in feet between two grid positions (5ft per cell)
 */
export function gridDistance(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  gridSize: number,
  feetPerCell = 5
): number {
  const dx = Math.abs(x1 - x2) / gridSize;
  const dy = Math.abs(y1 - y2) / gridSize;
  // D&D 5e uses the "every other diagonal costs 10ft" optional rule
  // For simplicity, use standard Euclidean rounded to nearest 5ft
  const cells = Math.sqrt(dx * dx + dy * dy);
  return Math.round(cells) * feetPerCell;
}

/**
 * BFS flood-fill to find reachable cells given movement speed
 */
export function getReachableCells(
  startCol: number,
  startRow: number,
  movementFeet: number,
  gridWidth: number,
  gridHeight: number,
  blockedCells: Set<string>,
  feetPerCell = 5
): { col: number; row: number; cost: number }[] {
  const maxCells = Math.floor(movementFeet / feetPerCell);
  const reachable: { col: number; row: number; cost: number }[] = [];
  const visited = new Set<string>();
  const queue: { col: number; row: number; cost: number }[] = [
    { col: startCol, row: startRow, cost: 0 },
  ];
  visited.add(`${startCol},${startRow}`);

  const directions = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.cost > 0) {
      reachable.push(current);
    }

    for (const [dx, dy] of directions) {
      const nc = current.col + dx;
      const nr = current.row + dy;
      const isDiagonal = dx !== 0 && dy !== 0;
      const moveCost = isDiagonal ? 1.5 : 1;
      const newCost = current.cost + moveCost;

      const key = `${nc},${nr}`;
      if (
        nc >= 0 && nc < gridWidth &&
        nr >= 0 && nr < gridHeight &&
        !visited.has(key) &&
        !blockedCells.has(key) &&
        newCost <= maxCells
      ) {
        visited.add(key);
        queue.push({ col: nc, row: nr, cost: newCost });
      }
    }
  }

  return reachable;
}

/**
 * A* pathfinding between two grid cells
 */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  gridWidth: number,
  gridHeight: number,
  blockedCells: Set<string>
): { col: number; row: number }[] {
  const key = (c: number, r: number) => `${c},${r}`;
  const heuristic = (c: number, r: number) =>
    Math.max(Math.abs(c - endCol), Math.abs(r - endRow));

  const openSet = new Map<string, { col: number; row: number; g: number; f: number }>();
  const cameFrom = new Map<string, string>();
  const start = { col: startCol, row: startRow, g: 0, f: heuristic(startCol, startRow) };
  openSet.set(key(startCol, startRow), start);

  const directions = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];

  while (openSet.size > 0) {
    let current: { col: number; row: number; g: number; f: number } | null = null;
    for (const node of openSet.values()) {
      if (!current || node.f < current.f) current = node;
    }
    if (!current) break;

    const ck = key(current.col, current.row);
    if (current.col === endCol && current.row === endRow) {
      const path: { col: number; row: number }[] = [];
      let k: string | undefined = ck;
      while (k) {
        const [c, r] = k.split(',').map(Number);
        path.unshift({ col: c, row: r });
        k = cameFrom.get(k);
      }
      return path;
    }

    openSet.delete(ck);

    for (const [dx, dy] of directions) {
      const nc = current.col + dx;
      const nr = current.row + dy;
      const nk = key(nc, nr);
      const isDiagonal = dx !== 0 && dy !== 0;
      const cost = isDiagonal ? 1.414 : 1;

      if (
        nc < 0 || nc >= gridWidth ||
        nr < 0 || nr >= gridHeight ||
        blockedCells.has(nk)
      ) continue;

      const g = current.g + cost;
      const existing = openSet.get(nk);
      if (existing && g >= existing.g) continue;

      cameFrom.set(nk, ck);
      openSet.set(nk, { col: nc, row: nr, g, f: g + heuristic(nc, nr) });
    }
  }

  return [];
}
