import { create } from 'zustand';
import type { Combatant, ActionEconomy, Condition } from '@dnd-vtt/shared';

export interface DamageLogEntry {
  round: number;
  attackerName: string;
  targetName: string;
  damage: number;
  damageType: string;
  source: string;
  timestamp: number;
}

interface InitiativePrompt {
  tokenId: string;
  bonus: number;
}

interface ReadyCheckState {
  active: boolean;
  playerIds: string[];
  responses: Record<string, boolean>;
  deadline: number;
}

interface CombatState {
  active: boolean;
  roundNumber: number;
  currentTurnIndex: number;
  combatants: Combatant[];
  actionEconomy: ActionEconomy;
  initiativeRolls: Map<string, number>;
  initiativePrompts: InitiativePrompt[];
  readyCheck: ReadyCheckState | null;
  damageLog: DamageLogEntry[];
  combatStartTime: number | null;
  /** The final recap data, preserved after combat ends so "View Again" works. */
  lastRecap: {
    damageLog: DamageLogEntry[];
    roundCount: number;
    durationMs: number;
  } | null;
  showRecap: boolean;
}

interface CombatActions {
  startCombat: (combatants: Combatant[], roundNumber: number) => void;
  /** Resync the entire combat state (used on reconnect/refresh). */
  syncCombatState: (args: {
    combatants: Combatant[];
    roundNumber: number;
    currentTurnIndex: number;
    actionEconomy: ActionEconomy;
  }) => void;
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
  setReadyCheck: (data: ReadyCheckState) => void;
  updateReadyResponses: (responses: Record<string, boolean>) => void;
  clearReadyCheck: () => void;
  addDamageLog: (entry: DamageLogEntry) => void;
  clearDamageLog: () => void;
  setShowRecap: (show: boolean) => void;
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
  readyCheck: null,
  damageLog: [],
  combatStartTime: null,
  lastRecap: null,
  showRecap: false,
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
      readyCheck: null,
      damageLog: [],
      combatStartTime: Date.now(),
    }),

  syncCombatState: ({ combatants, roundNumber, currentTurnIndex, actionEconomy }) =>
    set({
      active: true,
      combatants,
      roundNumber,
      currentTurnIndex,
      actionEconomy,
      initiativeRolls: new Map(),
      initiativePrompts: [],
    }),

  endCombat: () =>
    set((state) => ({
      active: false,
      roundNumber: 0,
      currentTurnIndex: 0,
      combatants: [],
      actionEconomy: defaultActionEconomy,
      initiativeRolls: new Map(),
      initiativePrompts: [],
      readyCheck: null,
      lastRecap: state.damageLog.length > 0
        ? {
            damageLog: [...state.damageLog],
            roundCount: state.roundNumber,
            durationMs: state.combatStartTime
              ? Date.now() - state.combatStartTime
              : 0,
          }
        : null,
      showRecap: state.damageLog.length > 0,
      damageLog: [],
      combatStartTime: null,
    })),

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
      // CRITICAL: also update the combatant's live initiative value in
      // the combatants array so the initiative tracker displays it.
      // Previously this only touched the orphaned initiativeRolls Map
      // and the tracker kept showing whatever the server broadcast with
      // combat:started (which was often 0 for player-owned tokens).
      const combatants = state.combatants.map((c) =>
        c.tokenId === tokenId ? { ...c, initiative: total } : c,
      );
      return { initiativeRolls: newRolls, combatants };
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

  setReadyCheck: (data) => set({ readyCheck: data }),

  updateReadyResponses: (responses) =>
    set((state) => ({
      readyCheck: state.readyCheck
        ? { ...state.readyCheck, responses }
        : null,
    })),

  clearReadyCheck: () => set({ readyCheck: null }),

  addDamageLog: (entry) =>
    set((state) => ({
      damageLog: [...state.damageLog, entry],
    })),

  clearDamageLog: () => set({ damageLog: [] }),

  setShowRecap: (show) => set({ showRecap: show }),
}));
