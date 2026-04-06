import { create } from 'zustand';
import type { Character, Spell } from '@dnd-vtt/shared';

export interface HotbarSlot {
  type: 'spell' | 'ability' | 'item';
  data: Spell | string | null;
}

function emptyHotbar(): HotbarSlot[] {
  return Array.from({ length: 10 }, () => ({ type: 'spell' as const, data: null }));
}

interface CharacterState {
  myCharacter: Character | null;
  allCharacters: Record<string, Character>;
  hotbarSlots: HotbarSlot[];
}

interface CharacterActions {
  setCharacter: (character: Character) => void;
  updateCharacter: (changes: Partial<Character>) => void;
  setAllCharacters: (characters: Record<string, Character>) => void;
  applyRemoteUpdate: (characterId: string, changes: Record<string, unknown>) => void;
  applyRemoteSync: (character: Record<string, unknown>) => void;
  setHotbarSlot: (index: number, slot: HotbarSlot) => void;
  clearHotbar: () => void;
}

export const useCharacterStore = create<CharacterState & CharacterActions>(
  (set) => ({
    myCharacter: null,
    allCharacters: {},
    hotbarSlots: emptyHotbar(),

    setCharacter: (character) =>
      set((state) => ({
        myCharacter: character,
        allCharacters: { ...state.allCharacters, [character.id]: character },
      })),

    updateCharacter: (changes) =>
      set((state) => {
        if (!state.myCharacter) return {};
        const updated = { ...state.myCharacter, ...changes };
        return {
          myCharacter: updated,
          allCharacters: { ...state.allCharacters, [updated.id]: updated },
        };
      }),

    setAllCharacters: (characters) => set({ allCharacters: characters }),

    applyRemoteUpdate: (characterId, changes) =>
      set((state) => {
        const existing = state.allCharacters[characterId];
        if (!existing) return {};
        const updated = { ...existing, ...changes } as Character;
        const result: Partial<CharacterState> = {
          allCharacters: { ...state.allCharacters, [characterId]: updated },
        };
        // If the updated character is our own, also update myCharacter
        if (state.myCharacter?.id === characterId) {
          result.myCharacter = updated;
        }
        return result;
      }),

    applyRemoteSync: (character) =>
      set((state) => {
        const char = character as unknown as Character;
        if (!char.id) return {};
        const result: Partial<CharacterState> = {
          allCharacters: { ...state.allCharacters, [char.id]: char },
        };
        // Set as myCharacter if it's already ours, OR if we don't have one yet
        // (handles auto-loading on session rejoin)
        if (state.myCharacter?.id === char.id || !state.myCharacter) {
          result.myCharacter = char;
        }
        return result;
      }),

    setHotbarSlot: (index, slot) =>
      set((state) => {
        const slots = [...state.hotbarSlots];
        if (index >= 0 && index < 10) {
          slots[index] = slot;
        }
        return { hotbarSlots: slots };
      }),

    clearHotbar: () => set({ hotbarSlots: emptyHotbar() }),
  })
);
