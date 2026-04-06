import { useRef, useEffect, useState, useCallback } from 'react';
import { Group, Circle, Rect, Line, Ring } from 'react-konva';
import Konva from 'konva';
import type { SpellAnimationData } from '../../stores/useEffectStore';
import { useEffectStore } from '../../stores/useEffectStore';

// --- Particle system types ---

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
  color: string;
  life: number;
  maxLife: number;
}

function createParticle(
  x: number,
  y: number,
  color: string,
  spread: number,
  speed: number,
  dirX = 0,
  dirY = 0
): Particle {
  const angle = Math.random() * Math.PI * 2;
  const spd = speed * (0.5 + Math.random() * 0.5);
  return {
    x,
    y,
    vx: Math.cos(angle) * spd * spread + dirX * spd,
    vy: Math.sin(angle) * spd * spread + dirY * spd,
    radius: 1.5 + Math.random() * 3,
    opacity: 0.8 + Math.random() * 0.2,
    color,
    life: 0,
    maxLife: 0.3 + Math.random() * 0.7,
  };
}

// --- Projectile Animation ---

interface ProjectileState {
  x: number;
  y: number;
  progress: number;
  particles: Particle[];
  trailParticles: Particle[];
}

function useProjectileAnimation(
  anim: SpellAnimationData,
  onComplete: () => void
) {
  const [state, setState] = useState<ProjectileState>({
    x: anim.casterPosition.x,
    y: anim.casterPosition.y,
    progress: 0,
    particles: [],
    trailParticles: [],
  });
  const animRef = useRef<Konva.Animation | null>(null);
  const startTimeRef = useRef(0);

  useEffect(() => {
    const dx = anim.targetPosition.x - anim.casterPosition.x;
    const dy = anim.targetPosition.y - anim.casterPosition.y;

    const konvaAnim = new Konva.Animation((frame) => {
      if (!frame) return;
      if (startTimeRef.current === 0) startTimeRef.current = frame.time;

      const elapsed = frame.time - startTimeRef.current;
      const progress = Math.min(elapsed / anim.duration, 1);

      // Current projectile position (ease-out)
      const eased = 1 - Math.pow(1 - progress, 2);
      const cx = anim.casterPosition.x + dx * eased;
      const cy = anim.casterPosition.y + dy * eased;

      // Spawn trail particles behind projectile
      const newTrail: Particle[] = [];
      if (progress < 1) {
        for (let i = 0; i < 2; i++) {
          newTrail.push(
            createParticle(
              cx + (Math.random() - 0.5) * 6,
              cy + (Math.random() - 0.5) * 6,
              Math.random() > 0.5 ? anim.color : anim.secondaryColor,
              0.3,
              0.5
            )
          );
        }
      }

      // Impact burst at completion
      const impactParticles: Particle[] = [];
      if (progress >= 1 && state.particles.length === 0) {
        for (let i = 0; i < anim.particleCount; i++) {
          impactParticles.push(
            createParticle(
              anim.targetPosition.x,
              anim.targetPosition.y,
              Math.random() > 0.4 ? anim.color : anim.secondaryColor,
              1.0,
              2.0
            )
          );
        }
      }

      setState((prev) => {
        const dt = frame.timeDiff / 1000;
        const updatedTrail = [...prev.trailParticles, ...newTrail]
          .map((p) => ({
            ...p,
            x: p.x + p.vx * dt * 60,
            y: p.y + p.vy * dt * 60,
            life: p.life + dt,
            opacity: Math.max(0, p.opacity - dt * 2.5),
          }))
          .filter((p) => p.opacity > 0.01);

        const updatedParticles = [
          ...prev.particles,
          ...impactParticles,
        ]
          .map((p) => ({
            ...p,
            x: p.x + p.vx * dt * 60,
            y: p.y + p.vy * dt * 60,
            life: p.life + dt,
            opacity: Math.max(0, p.opacity - dt * 1.5),
          }))
          .filter((p) => p.opacity > 0.01);

        return {
          x: cx,
          y: cy,
          progress,
          trailParticles: updatedTrail,
          particles: updatedParticles,
        };
      });

      if (progress >= 1 && elapsed > anim.duration + 600) {
        konvaAnim.stop();
        onComplete();
      }
    });

    animRef.current = konvaAnim;
    konvaAnim.start();

    return () => {
      konvaAnim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

function ProjectileAnimation({
  anim,
  onComplete,
}: {
  anim: SpellAnimationData;
  onComplete: () => void;
}) {
  const state = useProjectileAnimation(anim, onComplete);

  return (
    <Group>
      {/* Trail particles */}
      {state.trailParticles.map((p, i) => (
        <Circle
          key={`trail-${i}`}
          x={p.x}
          y={p.y}
          radius={p.radius * 0.7}
          fill={p.color}
          opacity={p.opacity * 0.6}
          perfectDrawEnabled={false}
        />
      ))}

      {/* Projectile body */}
      {state.progress < 1 && (
        <>
          <Circle
            x={state.x}
            y={state.y}
            radius={6}
            fill={anim.color}
            opacity={0.9}
            shadowColor={anim.color}
            shadowBlur={16}
            shadowEnabled
          />
          <Circle
            x={state.x}
            y={state.y}
            radius={3}
            fill={anim.secondaryColor}
            opacity={1}
          />
        </>
      )}

      {/* Impact particles */}
      {state.particles.map((p, i) => (
        <Circle
          key={`impact-${i}`}
          x={p.x}
          y={p.y}
          radius={p.radius}
          fill={p.color}
          opacity={p.opacity}
          shadowColor={p.color}
          shadowBlur={6}
          shadowEnabled
          perfectDrawEnabled={false}
        />
      ))}
    </Group>
  );
}

// --- AoE Animation ---

function useAoeAnimation(
  anim: SpellAnimationData,
  onComplete: () => void
) {
  const [state, setState] = useState({
    radius: 0,
    opacity: 0,
    particles: [] as Particle[],
    ringOpacity: 0,
  });
  const animRef = useRef<Konva.Animation | null>(null);
  const startTimeRef = useRef(0);
  const spawnedRef = useRef(false);

  useEffect(() => {
    const maxRadius = 40 + anim.particleCount * 0.8;

    const konvaAnim = new Konva.Animation((frame) => {
      if (!frame) return;
      if (startTimeRef.current === 0) startTimeRef.current = frame.time;

      const elapsed = frame.time - startTimeRef.current;
      const progress = Math.min(elapsed / anim.duration, 1);

      // Expanding ring with ease-out
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentRadius = maxRadius * eased;
      const coreOpacity = progress < 0.6 ? 0.35 : 0.35 * (1 - (progress - 0.6) / 0.4);
      const ringOp = progress < 0.3 ? progress / 0.3 : 1 - (progress - 0.3) / 0.7;

      // Spawn particles once at ~30% progress
      const newParticles: Particle[] = [];
      if (progress > 0.15 && !spawnedRef.current) {
        spawnedRef.current = true;
        for (let i = 0; i < anim.particleCount; i++) {
          newParticles.push(
            createParticle(
              anim.targetPosition.x,
              anim.targetPosition.y,
              Math.random() > 0.4 ? anim.color : anim.secondaryColor,
              1.0,
              1.5 + Math.random()
            )
          );
        }
      }

      setState((prev) => {
        const dt = frame.timeDiff / 1000;
        const updatedParticles = [...prev.particles, ...newParticles]
          .map((p) => ({
            ...p,
            x: p.x + p.vx * dt * 40,
            y: p.y + p.vy * dt * 40,
            life: p.life + dt,
            opacity: Math.max(0, p.opacity - dt * 1.2),
            radius: p.radius * (1 - dt * 0.3),
          }))
          .filter((p) => p.opacity > 0.01);

        return {
          radius: currentRadius,
          opacity: coreOpacity,
          particles: updatedParticles,
          ringOpacity: Math.max(0, ringOp),
        };
      });

      if (progress >= 1 && elapsed > anim.duration + 500) {
        konvaAnim.stop();
        onComplete();
      }
    });

    animRef.current = konvaAnim;
    konvaAnim.start();

    return () => {
      konvaAnim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

function AoeAnimation({
  anim,
  onComplete,
}: {
  anim: SpellAnimationData;
  onComplete: () => void;
}) {
  const state = useAoeAnimation(anim, onComplete);

  return (
    <Group>
      {/* Core expanding circle */}
      <Circle
        x={anim.targetPosition.x}
        y={anim.targetPosition.y}
        radius={state.radius}
        fill={anim.color}
        opacity={state.opacity}
        perfectDrawEnabled={false}
      />

      {/* Outer ring */}
      <Ring
        x={anim.targetPosition.x}
        y={anim.targetPosition.y}
        innerRadius={Math.max(0, state.radius - 4)}
        outerRadius={state.radius}
        fill={anim.secondaryColor}
        opacity={state.ringOpacity * 0.6}
        shadowColor={anim.color}
        shadowBlur={20}
        shadowEnabled
        perfectDrawEnabled={false}
      />

      {/* Particles */}
      {state.particles.map((p, i) => (
        <Circle
          key={`aoe-p-${i}`}
          x={p.x}
          y={p.y}
          radius={p.radius}
          fill={p.color}
          opacity={p.opacity}
          perfectDrawEnabled={false}
        />
      ))}
    </Group>
  );
}

// --- Buff Animation ---

function useBuffAnimation(
  anim: SpellAnimationData,
  onComplete: () => void
) {
  const [state, setState] = useState({
    particles: [] as Particle[],
    glowOpacity: 0,
    glowRadius: 20,
  });
  const animRef = useRef<Konva.Animation | null>(null);
  const startTimeRef = useRef(0);
  const spawnTimerRef = useRef(0);

  useEffect(() => {
    const konvaAnim = new Konva.Animation((frame) => {
      if (!frame) return;
      if (startTimeRef.current === 0) startTimeRef.current = frame.time;

      const elapsed = frame.time - startTimeRef.current;
      const progress = Math.min(elapsed / anim.duration, 1);
      const dt = frame.timeDiff / 1000;
      spawnTimerRef.current += dt;

      // Rising golden particles spawned periodically
      const newParticles: Particle[] = [];
      if (progress < 0.8 && spawnTimerRef.current > 0.04) {
        spawnTimerRef.current = 0;
        const angle = Math.random() * Math.PI * 2;
        const dist = 10 + Math.random() * 20;
        newParticles.push({
          x: anim.targetPosition.x + Math.cos(angle) * dist,
          y: anim.targetPosition.y + Math.sin(angle) * dist,
          vx: (Math.random() - 0.5) * 0.5,
          vy: -1.5 - Math.random() * 1.5, // Rise upward
          radius: 1.5 + Math.random() * 2.5,
          opacity: 0.9,
          color: Math.random() > 0.3 ? anim.color : anim.secondaryColor,
          life: 0,
          maxLife: 0.8 + Math.random() * 0.4,
        });
      }

      // Glow pulse
      const glowPhase = Math.sin(progress * Math.PI);
      const glowOp = glowPhase * 0.25;
      const glowRad = 20 + glowPhase * 15;

      setState((prev) => {
        const updatedParticles = [...prev.particles, ...newParticles]
          .map((p) => ({
            ...p,
            x: p.x + p.vx * dt * 60,
            y: p.y + p.vy * dt * 60,
            life: p.life + dt,
            opacity: Math.max(0, p.opacity - dt * 1.0),
            radius: Math.max(0.5, p.radius - dt * 0.5),
          }))
          .filter((p) => p.opacity > 0.01);

        return {
          particles: updatedParticles,
          glowOpacity: glowOp,
          glowRadius: glowRad,
        };
      });

      if (progress >= 1 && elapsed > anim.duration + 400) {
        konvaAnim.stop();
        onComplete();
      }
    });

    animRef.current = konvaAnim;
    konvaAnim.start();

    return () => {
      konvaAnim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

function BuffAnimation({
  anim,
  onComplete,
}: {
  anim: SpellAnimationData;
  onComplete: () => void;
}) {
  const state = useBuffAnimation(anim, onComplete);

  return (
    <Group>
      {/* Glow halo */}
      <Circle
        x={anim.targetPosition.x}
        y={anim.targetPosition.y}
        radius={state.glowRadius}
        fill={anim.color}
        opacity={state.glowOpacity}
        shadowColor={anim.color}
        shadowBlur={25}
        shadowEnabled
        perfectDrawEnabled={false}
      />

      {/* Rising particles */}
      {state.particles.map((p, i) => (
        <Rect
          key={`buff-p-${i}`}
          x={p.x - p.radius / 2}
          y={p.y - p.radius / 2}
          width={p.radius}
          height={p.radius}
          fill={p.color}
          opacity={p.opacity}
          rotation={p.life * 90}
          shadowColor={p.color}
          shadowBlur={4}
          shadowEnabled
          perfectDrawEnabled={false}
        />
      ))}
    </Group>
  );
}

// --- Melee Animation ---

function useMeleeAnimation(
  anim: SpellAnimationData,
  onComplete: () => void
) {
  const [state, setState] = useState({
    flashOpacity: 0,
    shockwaveRadius: 0,
    shockwaveOpacity: 0,
    particles: [] as Particle[],
    slashAngle: 0,
    slashOpacity: 0,
  });
  const animRef = useRef<Konva.Animation | null>(null);
  const startTimeRef = useRef(0);
  const spawnedRef = useRef(false);

  useEffect(() => {
    const konvaAnim = new Konva.Animation((frame) => {
      if (!frame) return;
      if (startTimeRef.current === 0) startTimeRef.current = frame.time;

      const elapsed = frame.time - startTimeRef.current;
      const progress = Math.min(elapsed / anim.duration, 1);
      const dt = frame.timeDiff / 1000;

      // Flash at the start
      const flash = progress < 0.15 ? progress / 0.15 : Math.max(0, 1 - (progress - 0.15) / 0.3);

      // Shockwave ring expanding outward
      const swProgress = Math.max(0, (progress - 0.1) / 0.6);
      const swEased = 1 - Math.pow(1 - Math.min(swProgress, 1), 2);
      const swRadius = swEased * 35;
      const swOpacity = swProgress < 0.5 ? swProgress * 2 * 0.5 : Math.max(0, 0.5 - (swProgress - 0.5));

      // Slash arc
      const slashProgress = Math.min(progress / 0.4, 1);
      const slashAngle = -45 + slashProgress * 90;
      const slashOp = progress < 0.3 ? 0.8 : Math.max(0, 0.8 - (progress - 0.3) / 0.3);

      // Spawn impact particles
      const newParticles: Particle[] = [];
      if (progress > 0.1 && !spawnedRef.current) {
        spawnedRef.current = true;
        for (let i = 0; i < anim.particleCount; i++) {
          newParticles.push(
            createParticle(
              anim.targetPosition.x,
              anim.targetPosition.y,
              Math.random() > 0.5 ? anim.color : anim.secondaryColor,
              1.0,
              2.0
            )
          );
        }
      }

      setState((prev) => {
        const updatedParticles = [...prev.particles, ...newParticles]
          .map((p) => ({
            ...p,
            x: p.x + p.vx * dt * 60,
            y: p.y + p.vy * dt * 60,
            life: p.life + dt,
            opacity: Math.max(0, p.opacity - dt * 2.5),
          }))
          .filter((p) => p.opacity > 0.01);

        return {
          flashOpacity: flash * 0.5,
          shockwaveRadius: swRadius,
          shockwaveOpacity: swOpacity,
          particles: updatedParticles,
          slashAngle,
          slashOpacity: slashOp,
        };
      });

      if (progress >= 1 && elapsed > anim.duration + 300) {
        konvaAnim.stop();
        onComplete();
      }
    });

    animRef.current = konvaAnim;
    konvaAnim.start();

    return () => {
      konvaAnim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

function MeleeAnimation({
  anim,
  onComplete,
}: {
  anim: SpellAnimationData;
  onComplete: () => void;
}) {
  const state = useMeleeAnimation(anim, onComplete);

  // Slash arc as a curved line
  const slashPoints: number[] = [];
  const arcCenter = anim.targetPosition;
  const arcRadius = 25;
  for (let i = 0; i <= 8; i++) {
    const angle = ((state.slashAngle - 45 + (i / 8) * 90) * Math.PI) / 180;
    slashPoints.push(
      arcCenter.x + Math.cos(angle) * arcRadius,
      arcCenter.y + Math.sin(angle) * arcRadius
    );
  }

  return (
    <Group>
      {/* Flash */}
      <Circle
        x={anim.targetPosition.x}
        y={anim.targetPosition.y}
        radius={20}
        fill="#ffffff"
        opacity={state.flashOpacity}
        perfectDrawEnabled={false}
      />

      {/* Shockwave ring */}
      {state.shockwaveRadius > 0 && (
        <Ring
          x={anim.targetPosition.x}
          y={anim.targetPosition.y}
          innerRadius={Math.max(0, state.shockwaveRadius - 3)}
          outerRadius={state.shockwaveRadius}
          fill={anim.color}
          opacity={state.shockwaveOpacity}
          shadowColor={anim.color}
          shadowBlur={10}
          shadowEnabled
          perfectDrawEnabled={false}
        />
      )}

      {/* Slash arc */}
      {slashPoints.length >= 4 && (
        <Line
          points={slashPoints}
          stroke={anim.secondaryColor}
          strokeWidth={3}
          opacity={state.slashOpacity}
          lineCap="round"
          lineJoin="round"
          shadowColor={anim.secondaryColor}
          shadowBlur={8}
          shadowEnabled
          perfectDrawEnabled={false}
        />
      )}

      {/* Impact particles */}
      {state.particles.map((p, i) => (
        <Circle
          key={`melee-p-${i}`}
          x={p.x}
          y={p.y}
          radius={p.radius}
          fill={p.color}
          opacity={p.opacity}
          perfectDrawEnabled={false}
        />
      ))}
    </Group>
  );
}

// --- Main SpellAnimation component ---

export function SpellAnimation({
  animation,
  onComplete,
}: {
  animation: SpellAnimationData;
  onComplete: (id: string) => void;
}) {
  const handleComplete = useCallback(() => {
    onComplete(animation.id);
  }, [animation.id, onComplete]);

  switch (animation.animationType) {
    case 'projectile':
      return <ProjectileAnimation anim={animation} onComplete={handleComplete} />;
    case 'aoe':
      return <AoeAnimation anim={animation} onComplete={handleComplete} />;
    case 'buff':
      return <BuffAnimation anim={animation} onComplete={handleComplete} />;
    case 'melee':
      return <MeleeAnimation anim={animation} onComplete={handleComplete} />;
    default:
      return null;
  }
}

// --- Container that renders all active animations ---

export function SpellAnimationLayer() {
  const activeAnimations = useEffectStore((s) => s.activeAnimations);
  const removeAnimation = useEffectStore((s) => s.removeAnimation);

  const handleComplete = useCallback(
    (id: string) => {
      removeAnimation(id);
    },
    [removeAnimation]
  );

  if (activeAnimations.length === 0) return null;

  return (
    <Group>
      {activeAnimations.map((anim) => (
        <SpellAnimation
          key={anim.id}
          animation={anim}
          onComplete={handleComplete}
        />
      ))}
    </Group>
  );
}
