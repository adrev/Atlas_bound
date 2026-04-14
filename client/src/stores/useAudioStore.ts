import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AudioState {
  masterVolume: number;     // 0-100
  musicVolume: number;      // 0-100
  sfxVolume: number;        // 0-100
  masterMuted: boolean;
  musicMuted: boolean;
  sfxMuted: boolean;
}

interface AudioActions {
  setMasterVolume: (v: number) => void;
  setMusicVolume: (v: number) => void;
  setSfxVolume: (v: number) => void;
  toggleMasterMute: () => void;
  toggleMusicMute: () => void;
  toggleSfxMute: () => void;
  getEffectiveVolume: (channel: 'music' | 'sfx') => number;
}

export const useAudioStore = create<AudioState & AudioActions>()(
  persist(
    (set, get) => ({
      masterVolume: 75,
      musicVolume: 80,
      sfxVolume: 60,
      masterMuted: false,
      musicMuted: false,
      sfxMuted: false,

      setMasterVolume: (v) => set({ masterVolume: v }),
      setMusicVolume: (v) => set({ musicVolume: v }),
      setSfxVolume: (v) => set({ sfxVolume: v }),

      toggleMasterMute: () => set((s) => ({ masterMuted: !s.masterMuted })),
      toggleMusicMute: () => set((s) => ({ musicMuted: !s.musicMuted })),
      toggleSfxMute: () => set((s) => ({ sfxMuted: !s.sfxMuted })),

      getEffectiveVolume: (channel) => {
        const s = get();
        if (s.masterMuted) return 0;
        if (channel === 'music' && s.musicMuted) return 0;
        if (channel === 'sfx' && s.sfxMuted) return 0;
        const channelVol = channel === 'music' ? s.musicVolume : s.sfxVolume;
        return (s.masterVolume / 100) * (channelVol / 100);
      },
    }),
    { name: 'dnd-vtt-audio' },
  ),
);
