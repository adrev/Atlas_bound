import { create } from 'zustand';
import type { Combatant, ActionEconomy, Condition } from '@dnd-vtt/shared';

interface InitiativePrompt {
  tokenId: string;
  bonus: number;
}

interface CombatState {
  active: boolean;
  roundNumber: number;
  currentTurnIndex: number;
  combatants: Combatant[];
  actionEconomy: ActionEconomy;
  initiativeRolls: Map<string, number>;
  initiativePrompts: InitiativePrompt[];
}

interface CombatActions {
  startCombat: (combatants: Combatant[], roundNumber: number) => void;
  endCombat: () => void;
  setCombatants: (combatants: Combatant[]) => void;
  nextTurn: (currentTurnIndex: number, roundNumber: number, economy: ActionEconomy) => void;
  setInitiative: (tokenId: string, total: number) => void;
  addInitiativePrompt: (tokenId: string, bonus: number) => void;
  updateHP: (tokenId: string, hp: number, tempHp: number) => void;
  addCondition: (tokenId: string, conditions: Condition[]) => void;
  removeCondition: (tokenId: string, conditions: Condition[]) => void;
  updateActionEconomy: (economy: ActionEconomy) => void;
  updateMovement: (tokenId: string, remaining: number) => void;
  setDeathSaves: (tokenId: string, deathSaves: { successes: number; failures: number }) => void;
}

const defaultActionEconomy: ActionEconomy = {
  action: false,
  bonusAction: false,
  movementRemaining: 30,
  movementMax: 30,
  reaction: false,
};

const initialState: CombatState = {
  active: false,
  roundNumber: 0,
  currentTurnIndex: 0,
  combatants: [],
  actionEconomy: defaultActionEconomy,
  initiativeRolls: new Map(),
  initiativePrompts: [],
};

export const useCombatStore = create<CombatState & CombatActions>((set) => ({
  ...initialState,

  startCombat: (combatants, roundNumber) =>
    set({
      active: true,
      combatants,
      roundNumber,
      currentTurnIndex: 0,
      actionEconomy: defaultActionEconomy,
      initiativeRolls: new Map(),
      initiativePrompts: [],
    }),

  endCombat: () =>
    set({
      active: false,
      roundNumber: 0,
      currentTurnIndex: 0,
      combatants: [],
      actionEconomy: defaultActionEconomy,
      initiativeRolls: new Map(),
      initiativePrompts: [],
    }),

  setCombatants: (combatants) => set({ combatants }),

  nextTurn: (currentTurnIndex, roundNumber, economy) =>
    set({
      currentTurnIndex,
      roundNumber,
      actionEconomy: economy,
    }),

  setInitiative: (tokenId, total) =>
    set((state) => {
      const newRolls = new Map(state.initiativeRolls);
      newRolls.set(tokenId, total);
      return { initiativeRolls: newRolls };
    }),

  addInitiativePrompt: (tokenId, bonus) =>
    set((state) => ({
      initiativePrompts: [...state.initiativePrompts, { tokenId, bonus }],
    })),

  updateHP: (tokenId, hp, tempHp) =>
    set((state) => ({
      combatants: state.combatants.map((c) =>
        c.tokenId === tokenId ? { ...c, hp, tempHp } : c
      ),
    })),

  addCondition: (tokenId, conditions) =>
    set((state) => ({
      combatants: state.combatants.map((c) =>
        c.tokenId === tokenId ? { ...c, conditions } : c
      ),
    })),

  removeCondition: (tokenId, conditions) =>
    set((state) => ({
      combatants: state.combatants.map((c) =>
        c.tokenId === tokenId ? { ...c, conditions } : c
      ),
    })),

  updateActionEconomy: (economy) => set({ actionEconomy: economy }),

  updateMovement: (tokenId, remaining) =>
    set((state) => ({
      actionEconomy:
        state.combatants[state.currentTurnIndex]?.tokenId === tokenId
          ? { ...state.actionEconomy, movementRemaining: remaining }
          : state.actionEconomy,
    })),

  setDeathSaves: (tokenId, deathSaves) =>
    set((state) => ({
      combatants: state.combatants.map((c) =>
        c.tokenId === tokenId ? { ...c, deathSaves } : c
      ),
    })),
}));
