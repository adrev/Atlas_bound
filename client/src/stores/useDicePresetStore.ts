import { create } from 'zustand';

export interface DicePreset {
  id: string;
  label: string;        // "Longsword Attack"
  notation: string;     // "1d20+7"
  damageNotation?: string; // "1d8+4"
  damageType?: string;  // "slashing"
}

interface DicePresetState {
  presets: DicePreset[];
}

interface DicePresetActions {
  loadPresets: (characterId: string) => void;
  addPreset: (characterId: string, preset: Omit<DicePreset, 'id'>) => void;
  removePreset: (characterId: string, presetId: string) => void;
}

function storageKey(characterId: string): string {
  return `dnd-vtt-dice-presets-${characterId}`;
}

function readFromStorage(characterId: string): DicePreset[] {
  try {
    const raw = localStorage.getItem(storageKey(characterId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeToStorage(characterId: string, presets: DicePreset[]): void {
  localStorage.setItem(storageKey(characterId), JSON.stringify(presets));
}

export const useDicePresetStore = create<DicePresetState & DicePresetActions>(
  (set, get) => ({
    presets: [],

    loadPresets: (characterId) => {
      set({ presets: readFromStorage(characterId) });
    },

    addPreset: (characterId, preset) => {
      const id = crypto.randomUUID();
      const newPreset: DicePreset = { ...preset, id };
      const updated = [...get().presets, newPreset];
      writeToStorage(characterId, updated);
      set({ presets: updated });
    },

    removePreset: (characterId, presetId) => {
      const updated = get().presets.filter((p) => p.id !== presetId);
      writeToStorage(characterId, updated);
      set({ presets: updated });
    },
  })
);
