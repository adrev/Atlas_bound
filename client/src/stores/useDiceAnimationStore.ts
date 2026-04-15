import { create } from 'zustand';

/**
 * Physical 3D dice roll queue — only used by the Dice Tray + /r chat
 * command. Each queued entry carries the notation to feed dice-box
 * plus the "pending emit" metadata so the overlay can call
 * `emitPhysicalRoll` once physics settle.
 *
 * Non-physical rolls (attacks, spells, initiative) bypass this queue
 * entirely — they go through `emitRoll` → server random → chat card
 * as before, no 3D animation involved.
 */
export interface PhysicalDiceRoll {
  id: number;
  /** Dice notation to feed dice-box, e.g. "1d20+3" or "2d6". */
  notation: string;
  /** Optional reason label for the chat card ("Attack", "Perception", …). */
  reason?: string;
  /** Hidden rolls go only to the DM socket once the server builds the card. */
  hidden?: boolean;
  /** Wall-clock start so consumers can compute elapsed animation time. */
  startedAt: number;
}

interface DiceAnimationState {
  active: PhysicalDiceRoll[];
}

interface DiceAnimationActions {
  /** Queue a physical roll. The overlay will pick it up, run dice-box,
   *  and (once settled) emit chat:roll with the reported values. */
  playPhysical: (notation: string, reason?: string, hidden?: boolean) => void;
  /** Remove a roll from the queue — called by the overlay after its
   *  post-settle hold + fade. */
  complete: (id: number) => void;
  clear: () => void;
}

let seq = 0;

export const useDiceAnimationStore = create<DiceAnimationState & DiceAnimationActions>((set) => ({
  active: [],
  playPhysical: (notation, reason, hidden) => {
    seq += 1;
    const entry: PhysicalDiceRoll = {
      id: seq, notation, reason, hidden, startedAt: performance.now(),
    };
    // Cap the queue at 3 — rapid-fire tray clicks shouldn't pile up.
    set((state) => ({ active: [...state.active.slice(-2), entry] }));
  },
  complete: (id) => set((state) => ({ active: state.active.filter((a) => a.id !== id) })),
  clear: () => set({ active: [] }),
}));
