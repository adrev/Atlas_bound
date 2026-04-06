import { create } from 'zustand';
import type { DiceRollData } from '@dnd-vtt/shared';

interface DiceState {
  pendingRoll: string | null;
  lastResult: DiceRollData | null;
  advantage: 'normal' | 'advantage' | 'disadvantage';
  showResult: boolean;
  rollHistory: DiceRollData[];
}

interface DiceActions {
  queueRoll: (notation: string) => void;
  setResult: (result: DiceRollData) => void;
  setAdvantage: (mode: 'normal' | 'advantage' | 'disadvantage') => void;
  clearResult: () => void;
}

export const useDiceStore = create<DiceState & DiceActions>((set) => ({
  pendingRoll: null,
  lastResult: null,
  advantage: 'normal',
  showResult: false,
  rollHistory: [],

  queueRoll: (notation) => set({ pendingRoll: notation }),

  setResult: (result) =>
    set((state) => ({
      lastResult: result,
      showResult: true,
      pendingRoll: null,
      rollHistory: [result, ...state.rollHistory].slice(0, 10),
    })),

  setAdvantage: (mode) => set({ advantage: mode }),

  clearResult: () => set({ showResult: false }),
}));
