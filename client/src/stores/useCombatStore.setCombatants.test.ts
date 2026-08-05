import { beforeEach, describe, expect, it } from 'vitest';
import { useCombatStore } from './useCombatStore';
import type { Combatant } from '@dnd-vtt/shared';

function combatant(overrides: Partial<Combatant> & { tokenId: string }): Combatant {
  return {
    characterId: null,
    name: 'Creature',
    initiative: 10,
    initiativeBonus: 0,
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

/**
 * combat:all-initiatives-ready replaces the whole sorted combatants
 * list. These cover the store-side anchoring: review resets to the
 * sorted top, live combat preserves the active combatant by tokenId.
 */
describe('useCombatStore.setCombatants turn anchoring', () => {
  beforeEach(() => {
    useCombatStore.setState({
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [],
      reviewPhase: false,
    });
  });

  it('resets the pointer to index 0 while in the review phase', () => {
    useCombatStore.setState({
      reviewPhase: true,
      currentTurnIndex: 2,
      combatants: [
        combatant({ tokenId: 't-a', name: 'Aria', initiative: 18 }),
        combatant({ tokenId: 't-b', name: 'Borin', initiative: 12 }),
        combatant({ tokenId: 't-c', name: 'Cleric', initiative: 5 }),
      ],
    });

    // DM hand-edits the Cleric to the top roll during review.
    useCombatStore
      .getState()
      .setCombatants([
        combatant({ tokenId: 't-c', name: 'Cleric', initiative: 21 }),
        combatant({ tokenId: 't-a', name: 'Aria', initiative: 18 }),
        combatant({ tokenId: 't-b', name: 'Borin', initiative: 12 }),
      ]);

    expect(useCombatStore.getState().currentTurnIndex).toBe(0);
    expect(useCombatStore.getState().combatants[0].tokenId).toBe('t-c');
  });

  it('preserves the round-1 live opener by tokenId when a correction reorders the list', () => {
    // Live combat right after lock-initiative: round 1, opener at index 0.
    useCombatStore.setState({
      reviewPhase: false,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [
        combatant({ tokenId: 't-opener', name: 'Rogue', initiative: 20 }),
        combatant({ tokenId: 't-b', name: 'Borin', initiative: 12 }),
      ],
    });

    // DM corrects the opener's roll downward; server re-sorts and
    // broadcasts — the opener slides to the bottom but keeps the turn.
    useCombatStore
      .getState()
      .setCombatants([
        combatant({ tokenId: 't-b', name: 'Borin', initiative: 12 }),
        combatant({ tokenId: 't-opener', name: 'Rogue', initiative: 8 }),
      ]);

    const state = useCombatStore.getState();
    expect(state.combatants[state.currentTurnIndex].tokenId).toBe('t-opener');
    expect(state.currentTurnIndex).toBe(1);
  });

  it('preserves the mid-combat active combatant when another creature is rerolled', () => {
    useCombatStore.setState({
      reviewPhase: false,
      roundNumber: 3,
      currentTurnIndex: 1,
      combatants: [
        combatant({ tokenId: 't-a', name: 'Aria', initiative: 18 }),
        combatant({ tokenId: 't-active', name: 'Borin', initiative: 12 }),
        combatant({ tokenId: 't-c', name: 'Cleric', initiative: 5 }),
      ],
    });

    // The Cleric rerolls above everyone; Borin's turn must not move.
    useCombatStore
      .getState()
      .setCombatants([
        combatant({ tokenId: 't-c', name: 'Cleric', initiative: 22 }),
        combatant({ tokenId: 't-a', name: 'Aria', initiative: 18 }),
        combatant({ tokenId: 't-active', name: 'Borin', initiative: 12 }),
      ]);

    const state = useCombatStore.getState();
    expect(state.combatants[state.currentTurnIndex].tokenId).toBe('t-active');
    expect(state.currentTurnIndex).toBe(2);
  });

  it('anchors by tokenId, not name, when duplicate names reorder', () => {
    useCombatStore.setState({
      reviewPhase: false,
      roundNumber: 2,
      currentTurnIndex: 1,
      combatants: [
        combatant({ tokenId: 't-gob-1', name: 'Goblin', initiative: 15 }),
        combatant({ tokenId: 't-gob-2', name: 'Goblin', initiative: 11 }),
        combatant({ tokenId: 't-gob-3', name: 'Goblin', initiative: 7 }),
      ],
    });

    // Goblin 3 rerolls to the top; the active Goblin 2 keeps its turn
    // even though a same-named creature now sits at the old index.
    useCombatStore
      .getState()
      .setCombatants([
        combatant({ tokenId: 't-gob-3', name: 'Goblin', initiative: 19 }),
        combatant({ tokenId: 't-gob-1', name: 'Goblin', initiative: 15 }),
        combatant({ tokenId: 't-gob-2', name: 'Goblin', initiative: 11 }),
      ]);

    const state = useCombatStore.getState();
    expect(state.combatants[state.currentTurnIndex].tokenId).toBe('t-gob-2');
    expect(state.currentTurnIndex).toBe(2);
  });

  it('leaves the pointer untouched when the anchor is missing from the new list', () => {
    // The active combatant is hidden from this client (visibility-
    // filtered list): currentTurnIndex is -1, no anchor resolvable.
    useCombatStore.setState({
      reviewPhase: false,
      roundNumber: 2,
      currentTurnIndex: -1,
      combatants: [
        combatant({ tokenId: 't-a', name: 'Aria', initiative: 18 }),
        combatant({ tokenId: 't-b', name: 'Borin', initiative: 12 }),
      ],
    });

    useCombatStore
      .getState()
      .setCombatants([
        combatant({ tokenId: 't-b', name: 'Borin', initiative: 20 }),
        combatant({ tokenId: 't-a', name: 'Aria', initiative: 18 }),
      ]);

    const state = useCombatStore.getState();
    expect(state.currentTurnIndex).toBe(-1);
    expect(state.combatants.map((c) => c.tokenId)).toEqual(['t-b', 't-a']);
  });
});
