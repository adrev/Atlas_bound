/**
 * Raycasting visibility polygon algorithm for fog of war and dynamic lighting.
 * Casts rays toward wall endpoints, finds closest intersections, and produces
 * a visibility polygon suitable for Konva rendering.
 */

interface Point {
  x: number;
  y: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Intersection extends Point {
  /** Parametric t along the ray (0 = origin, 1 = ray endpoint) */
  t: number;
}

/**
 * Compute the intersection point of two line segments.
 * Returns null if the segments do not intersect.
 * Uses parametric form: P = p1 + t*(p2-p1), Q = p3 + u*(p4-p3)
 */
export function lineSegmentIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point
): Intersection | null {
  const dx1 = p2.x - p1.x;
  const dy1 = p2.y - p1.y;
  const dx2 = p4.x - p3.x;
  const dy2 = p4.y - p3.y;

  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null; // parallel or coincident

  const t = ((p3.x - p1.x) * dy2 - (p3.y - p1.y) * dx2) / denom;
  const u = ((p3.x - p1.x) * dy1 - (p3.y - p1.y) * dx1) / denom;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return {
    x: p1.x + t * dx1,
    y: p1.y + t * dy1,
    t,
  };
}

/**
 * Cast a single ray from origin in a given direction and find the closest
 * wall intersection. If no wall is hit, returns intersection with the
 * boundary circle at the given radius.
 */
function castRay(
  origin: Point,
  angle: number,
  walls: Segment[],
  boundaryRadius: number
): Point {
  const farX = origin.x + Math.cos(angle) * boundaryRadius;
  const farY = origin.y + Math.sin(angle) * boundaryRadius;

  let closestDist = boundaryRadius;
  let closestPoint: Point = { x: farX, y: farY };

  for (const wall of walls) {
    const hit = lineSegmentIntersection(
      origin,
      { x: farX, y: farY },
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 }
    );

    if (hit) {
      const dist = hit.t * boundaryRadius;
      if (dist < closestDist) {
        closestDist = dist;
        closestPoint = { x: hit.x, y: hit.y };
      }
    }
  }

  return closestPoint;
}

/**
 * Compute a visibility polygon from a given origin point, blocked by wall
 * segments, bounded by a circular radius.
 *
 * Algorithm:
 * 1. Gather all unique angles from origin to wall endpoints plus boundary points
 * 2. For each angle, also cast at +-epsilon offset to catch wall corners
 * 3. For each ray, find the closest wall intersection
 * 4. Sort results by angle and return as a flat point array
 *
 * @param origin The viewer position
 * @param walls Array of wall segments that block visibility
 * @param boundaryRadius Maximum visibility distance
 * @returns Flat array of polygon points [x1,y1, x2,y2, ...] for Konva Line/Shape
 */
export function computeVisibilityPolygon(
  origin: Point,
  walls: Segment[],
  boundaryRadius: number
): number[] {
  const EPSILON = 0.0001;

  // Collect unique angles to cast rays toward
  const angles = new Set<number>();

  // Add rays toward every wall endpoint
  for (const wall of walls) {
    const a1 = Math.atan2(wall.y1 - origin.y, wall.x1 - origin.x);
    const a2 = Math.atan2(wall.y2 - origin.y, wall.x2 - origin.x);

    angles.add(a1);
    angles.add(a1 - EPSILON);
    angles.add(a1 + EPSILON);
    angles.add(a2);
    angles.add(a2 - EPSILON);
    angles.add(a2 + EPSILON);
  }

  // Add boundary circle points at cardinal + diagonal + intermediate directions
  const boundarySteps = 16;
  for (let i = 0; i < boundarySteps; i++) {
    angles.add((i / boundarySteps) * Math.PI * 2 - Math.PI);
  }

  // Sort angles for proper polygon winding
  const sortedAngles = Array.from(angles).sort((a, b) => a - b);

  // Cast a ray for each angle and collect intersection points
  const points: { x: number; y: number; angle: number }[] = [];

  for (const angle of sortedAngles) {
    const hit = castRay(origin, angle, walls, boundaryRadius);
    points.push({ x: hit.x, y: hit.y, angle });
  }

  // Flatten into [x1, y1, x2, y2, ...] for Konva
  const flat: number[] = [];
  for (const p of points) {
    flat.push(p.x, p.y);
  }

  return flat;
}
