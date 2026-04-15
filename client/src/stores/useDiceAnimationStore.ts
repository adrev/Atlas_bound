import { create } from 'zustand';
import type { DiceRollData } from '@dnd-vtt/shared';

/**
 * In-flight 3D dice animation state.
 *
 * Only one animation plays at a time. When a new roll comes in while an
 * old one is still tumbling, the old one is replaced — the user only
 * ever cares about the latest roll. Chat history (via useChatStore)
 * still keeps the full log, so no data is lost.
 */
export interface ActiveDiceAnim {
  id: number;
  roll: DiceRollData;
  /** Settle deadline (performance.now() + duration) — overlay reads this to know when to fade. */
  endsAt: number;
}

interface DiceAnimationState {
  active: ActiveDiceAnim | null;
}

interface DiceAnimationActions {
  play: (roll: DiceRollData, durationMs: number) => void;
  clear: () => void;
}

let seq = 0;

export const useDiceAnimationStore = create<DiceAnimationState & DiceAnimationActions>((set) => ({
  active: null,
  play: (roll, durationMs) => {
    // Guard: rolls with only flat modifiers (e.g. "+3" entered as "1d0+3")
    // have no dice to tumble. Skip the overlay entirely for those.
    if (!roll.dice || roll.dice.length === 0) return;
    seq += 1;
    set({ active: { id: seq, roll, endsAt: performance.now() + durationMs } });
  },
  clear: () => set({ active: null }),
}));
