import { create } from 'zustand';
import type { AnimationType } from '@dnd-vtt/shared';

export type AoeType = 'cone' | 'sphere' | 'line' | 'cube';

export interface TargetingSpell {
  spellName: string;
  aoeType: AoeType;
  /** Size in feet (e.g. 20 for a 20ft radius sphere) */
  aoeSize: number;
  casterTokenId: string;
  color: string;
}

export interface ReachableCell {
  col: number;
  row: number;
  /** Movement cost in cells to reach here */
  cost: number;
}

export interface SpellAnimationData {
  id: string;
  casterPosition: { x: number; y: number };
  targetPosition: { x: number; y: number };
  animationType: AnimationType;
  color: string;
  secondaryColor: string;
  duration: number;
  particleCount: number;
  startedAt: number;
}

interface EffectState {
  // Spell targeting
  targetingSpell: TargetingSpell | null;
  targetPosition: { x: number; y: number } | null;
  targetRotation: number;

  // Movement range
  showMovementRange: boolean;
  reachableCells: ReachableCell[];
  dashReachableCells: ReachableCell[];
  movementPath: { col: number; row: number }[];

  // Active animations
  activeAnimations: SpellAnimationData[];
}

interface EffectActions {
  startTargeting: (spell: TargetingSpell) => void;
  cancelTargeting: () => void;
  setTargetPosition: (pos: { x: number; y: number } | null) => void;
  setTargetRotation: (rotation: number) => void;

  setMovementRange: (
    reachable: ReachableCell[],
    dashReachable: ReachableCell[]
  ) => void;
  setMovementPath: (path: { col: number; row: number }[]) => void;
  clearMovementRange: () => void;

  addAnimation: (animation: SpellAnimationData) => void;
  removeAnimation: (id: string) => void;
}

const initialState: EffectState = {
  targetingSpell: null,
  targetPosition: null,
  targetRotation: 0,

  showMovementRange: false,
  reachableCells: [],
  dashReachableCells: [],
  movementPath: [],

  activeAnimations: [],
};

export const useEffectStore = create<EffectState & EffectActions>((set) => ({
  ...initialState,

  startTargeting: (spell) =>
    set({
      targetingSpell: spell,
      targetPosition: null,
      targetRotation: 0,
    }),

  cancelTargeting: () =>
    set({
      targetingSpell: null,
      targetPosition: null,
      targetRotation: 0,
    }),

  setTargetPosition: (pos) => set({ targetPosition: pos }),

  setTargetRotation: (rotation) => set({ targetRotation: rotation }),

  setMovementRange: (reachable, dashReachable) =>
    set({
      showMovementRange: true,
      reachableCells: reachable,
      dashReachableCells: dashReachable,
    }),

  setMovementPath: (path) => set({ movementPath: path }),

  clearMovementRange: () =>
    set({
      showMovementRange: false,
      reachableCells: [],
      dashReachableCells: [],
      movementPath: [],
    }),

  addAnimation: (animation) =>
    set((state) => ({
      activeAnimations: [...state.activeAnimations, animation],
    })),

  removeAnimation: (id) =>
    set((state) => ({
      activeAnimations: state.activeAnimations.filter((a) => a.id !== id),
    })),
}));
