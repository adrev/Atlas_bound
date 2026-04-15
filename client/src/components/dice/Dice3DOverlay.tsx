import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDiceAnimationStore } from '../../stores/useDiceAnimationStore';

/**
 * Fullscreen-overlay 3D dice animation.
 *
 * Renders nothing when the animation store is idle. When a roll is
 * queued, it mounts a Three.js <Canvas>, spawns one mesh per die in
 * the roll, tumbles them for ~1.2s, then snaps to the face matching
 * the pre-rolled value and fades out.
 *
 * Animation is deterministic (no physics) — we always land on the
 * pre-computed server result. That way crit tension is preserved
 * without any risk of "dice say 17 but result card says 14".
 *
 * Face textures are drawn procedurally on a <canvas>, so no PNG or
 * GLB assets are shipped with the bundle. D6 uses pips, everything
 * else uses numbers centered per face.
 */
const SUPPORTED_DIE_TYPES = new Set([4, 6, 8, 10, 12, 20]);

export function Dice3DOverlay() {
  const active = useDiceAnimationStore((s) => s.active);
  const clear = useDiceAnimationStore((s) => s.clear);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    if (!active) { setFadingOut(false); return; }
    setFadingOut(false);
    const ttl = Math.max(0, active.endsAt - performance.now());
    // Start the fade a bit before we clear, so the canvas eases out
    // instead of popping.
    const fadeTimer = window.setTimeout(() => setFadingOut(true), ttl);
    const clearTimer = window.setTimeout(() => clear(), ttl + 400);
    return () => { window.clearTimeout(fadeTimer); window.clearTimeout(clearTimer); };
  }, [active, clear]);

  if (!active) return null;

  const dice = active.roll.dice.filter((d) => SUPPORTED_DIE_TYPES.has(d.type));
  if (dice.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 9999,
        opacity: fadingOut ? 0 : 1,
        transition: 'opacity 380ms ease-out',
      }}
      aria-hidden="true"
    >
      <Canvas
        camera={{ position: [0, 0, 8], fov: 40 }}
        style={{ width: '100%', height: '100%', background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[6, 8, 6]} intensity={1.2} castShadow />
        <directionalLight position={[-4, 2, 4]} intensity={0.4} color="#b4c7ff" />
        <DiceGroup dice={dice} id={active.id} endsAt={active.endsAt} />
      </Canvas>
    </div>
  );
}

/**
 * Lays the dice out in a horizontal row and animates each one. Width
 * adapts to the die count so 8d6 doesn't run off the edges.
 */
function DiceGroup({ dice, id, endsAt }: {
  dice: Array<{ type: number; value: number }>;
  id: number;
  endsAt: number;
}) {
  const count = dice.length;
  // Spacing tuned for up to ~12 dice; we shrink each die for larger counts.
  const spacing = count <= 4 ? 1.7 : count <= 8 ? 1.3 : 1.0;
  const scale = count <= 4 ? 1 : count <= 8 ? 0.8 : 0.65;

  return (
    <group>
      {dice.map((die, i) => {
        const x = (i - (count - 1) / 2) * spacing;
        return (
          <Die
            key={`${id}-${i}`}
            sides={die.type}
            value={die.value}
            position={[x, 0, 0]}
            scale={scale}
            startedAt={endsAt - 1200}
            settlesAt={endsAt - 200}
          />
        );
      })}
    </group>
  );
}

interface DieProps {
  sides: number;
  value: number;
  position: [number, number, number];
  scale: number;
  startedAt: number;
  settlesAt: number;
}

/**
 * A single die. Geometry is picked from die type. Rotation tweens
 * from a random spin into the exact orientation that shows `value`
 * face-up to the camera. Once settled, a brief settle wobble sells
 * the physical feel.
 */
function Die({ sides, value, position, scale, startedAt, settlesAt }: DieProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => makeGeometryForSides(sides), [sides]);
  const materials = useMemo(() => makeMaterialsForSides(sides, geometry), [sides, geometry]);
  // Target rotation: what rotation makes the target face point at the camera (+Z).
  const targetRotation = useMemo(
    () => faceUpEuler(sides, geometry, value),
    [sides, geometry, value],
  );
  // Randomize the tumble origin so two dice of the same type don't
  // move in lockstep.
  const tumbleAxis = useMemo(() => {
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    return v.normalize();
  }, []);
  const spinRate = useMemo(() => 8 + Math.random() * 6, []); // radians/sec while tumbling

  useFrame(() => {
    if (!meshRef.current) return;
    const now = performance.now();
    const total = settlesAt - startedAt;
    const t = Math.min(1, Math.max(0, (now - startedAt) / total));

    if (t < 0.7) {
      // Tumble phase — spin around a random axis, quadratic ease toward
      // the target orientation in the last 30% of the phase.
      const spinT = (now - startedAt) / 1000;
      const tumble = new THREE.Quaternion().setFromAxisAngle(tumbleAxis, spinT * spinRate);
      const target = new THREE.Quaternion().setFromEuler(targetRotation);
      const blend = Math.max(0, (t - 0.4) / 0.3); // start blending at 40%, full by 70%
      const out = tumble.clone().slerp(target, blend);
      meshRef.current.quaternion.copy(out);
      // Mild bob — rises then falls back to origin.
      const bob = Math.sin(t * Math.PI) * 0.3;
      meshRef.current.position.set(position[0], position[1] + bob, position[2]);
    } else if (t < 1) {
      // Settle phase — locked to target rotation with a subtle wobble
      // that dies out.
      const wobbleT = (t - 0.7) / 0.3;
      const wobble = Math.sin(wobbleT * Math.PI * 3) * (1 - wobbleT) * 0.05;
      const target = new THREE.Quaternion().setFromEuler(targetRotation);
      const wobbleQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0.2, 0), wobble);
      meshRef.current.quaternion.copy(target.clone().multiply(wobbleQ));
      meshRef.current.position.set(position[0], position[1], position[2]);
    } else {
      // Held on target rotation until the overlay fades out.
      meshRef.current.quaternion.setFromEuler(targetRotation);
      meshRef.current.position.set(position[0], position[1], position[2]);
    }
  });

  return (
    <mesh
      ref={meshRef}
      position={position}
      scale={scale}
      geometry={geometry}
      // THREE accepts a material array when the geometry has one group per face.
      material={materials}
      castShadow
    />
  );
}

// ---------------------------------------------------------------------------
// Geometry + materials
// ---------------------------------------------------------------------------

/**
 * Pick a primitive geometry that matches each die type.
 *
 * Icosahedron has 20 triangle faces → perfect D20.
 * Octahedron 8 → D8. Tetra 4 → D4. Box → D6. Dodecahedron 12 → D12.
 * D10 is a pentagonal trapezohedron in the wild, but that geometry
 * doesn't ship with three; we fake it with a bipyramid-like cylinder.
 * For this pass D10 uses a 10-sided cylinder which reads as a D10 well
 * enough for an action-table feel — we can swap in a proper mesh later.
 */
function makeGeometryForSides(sides: number): THREE.BufferGeometry {
  switch (sides) {
    case 4:  return new THREE.TetrahedronGeometry(1).toNonIndexed();
    case 6:  return new THREE.BoxGeometry(1.2, 1.2, 1.2).toNonIndexed();
    case 8:  return new THREE.OctahedronGeometry(1).toNonIndexed();
    case 10: return new THREE.CylinderGeometry(0, 1, 1.4, 10, 1).toNonIndexed();
    case 12: return new THREE.DodecahedronGeometry(1).toNonIndexed();
    case 20: return new THREE.IcosahedronGeometry(1).toNonIndexed();
    default: return new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  }
}

/**
 * Build one material per face, each with a procedurally-drawn canvas
 * texture showing the face number.
 *
 * We number faces in geometry order: face 0 = "1", face 1 = "2", etc.
 * The camera-facing orientation math in `faceUpEuler` assumes this
 * ordering, so don't reshuffle.
 */
function makeMaterialsForSides(sides: number, geometry: THREE.BufferGeometry): THREE.Material[] {
  const faceCount = countFaces(geometry, sides);
  const materials: THREE.Material[] = [];
  for (let i = 0; i < faceCount; i++) {
    const number = (i % sides) + 1;
    const texture = makeFaceTexture(number, sides);
    materials.push(new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.38,
      metalness: 0.05,
      color: '#f5e9c0',
    }));
  }
  // Split groups per face so each material indexes one face.
  // Non-indexed geometries have 3 vertices per triangle; assign groups.
  const posAttr = geometry.getAttribute('position');
  if (posAttr) {
    geometry.clearGroups();
    const triangleCount = posAttr.count / 3;
    const trianglesPerFace = Math.max(1, Math.floor(triangleCount / faceCount));
    for (let f = 0; f < faceCount; f++) {
      const start = f * trianglesPerFace * 3;
      const tris = f === faceCount - 1 ? (triangleCount - f * trianglesPerFace) : trianglesPerFace;
      geometry.addGroup(start, tris * 3, f);
    }
  }
  return materials;
}

function countFaces(geometry: THREE.BufferGeometry, sides: number): number {
  const posAttr = geometry.getAttribute('position');
  const triangleCount = posAttr ? posAttr.count / 3 : sides;
  // For geometries whose native face count matches the die (D4/D6/D8/D12/D20),
  // one triangle = one face except D6 (box has 2 tris per face) and D12
  // (dodecahedron has 3 tris per pentagonal face).
  if (sides === 6) return 6;
  if (sides === 12) return 12;
  if (sides === 10) return 10;
  return Math.min(sides, triangleCount);
}

/** Procedural face texture — big number on a parchment-cream background. */
function makeFaceTexture(number: number, sides: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // Background
  ctx.fillStyle = '#f5e9c0';
  ctx.fillRect(0, 0, size, size);
  // Subtle inner bevel ring so adjacent faces read as separate
  ctx.strokeStyle = 'rgba(60, 40, 20, 0.25)';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  // Number
  const isCrit = sides === 20 && number === 20;
  const isFail = sides === 20 && number === 1;
  ctx.fillStyle = isCrit ? '#b8860b' : isFail ? '#a93226' : '#2c2416';
  ctx.font = `bold ${size * 0.62}px "Georgia", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Nudge 6 and 9 down a hair and add an underline so you can tell them
  // apart on a die that's lying sideways in a screenshot.
  const shown = String(number);
  ctx.fillText(shown, size / 2, size / 2 + 4);
  if (number === 6 || number === 9) {
    ctx.fillRect(size / 2 - 14, size * 0.78, 28, 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Return an Euler rotation that brings the face labeled `value` toward
 * the +Z camera.
 *
 * Strategy: look at the world-space centroid of each face (after no
 * rotation), find the one tagged as the target value (face index =
 * value - 1), and compute a quaternion that rotates that face's normal
 * to point at +Z. Falls back to a random look-at for die types where
 * we don't have per-face normals cleanly.
 */
function faceUpEuler(sides: number, geometry: THREE.BufferGeometry, value: number): THREE.Euler {
  const faceIdx = Math.max(0, Math.min(sides - 1, value - 1));
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return new THREE.Euler(0, 0, 0);

  // Walk the geometry groups we created in makeMaterialsForSides —
  // each group corresponds to one face.
  const groups = geometry.groups;
  if (groups.length <= faceIdx) {
    return new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, 0);
  }
  const g = groups[faceIdx];
  // Average the group's vertex positions to get a centroid.
  const centroid = new THREE.Vector3();
  let n = 0;
  for (let i = g.start; i < g.start + g.count; i++) {
    centroid.x += posAttr.getX(i);
    centroid.y += posAttr.getY(i);
    centroid.z += posAttr.getZ(i);
    n++;
  }
  if (n === 0) return new THREE.Euler(0, 0, 0);
  centroid.divideScalar(n).normalize();

  // Rotation that sends `centroid` → +Z unit vector. Using the axis-
  // angle derived from the cross product keeps it gimbal-stable.
  const target = new THREE.Vector3(0, 0, 1);
  const axis = new THREE.Vector3().crossVectors(centroid, target);
  const angle = Math.acos(Math.max(-1, Math.min(1, centroid.dot(target))));
  if (axis.lengthSq() < 1e-6) {
    // Centroid is already aligned with +Z (or -Z). Flip around Y if
    // it's the latter.
    return new THREE.Euler(0, centroid.z > 0 ? 0 : Math.PI, 0);
  }
  const q = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
  return new THREE.Euler().setFromQuaternion(q);
}
