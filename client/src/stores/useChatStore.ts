import { create } from 'zustand';
import type { ChatMessage } from '@dnd-vtt/shared';

interface ChatState {
  messages: ChatMessage[];
}

interface ChatActions {
  addMessage: (message: ChatMessage) => void;
  setHistory: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  messages: [],

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  setHistory: (messages) => set({ messages }),

  clearMessages: () => set({ messages: [] }),
}));
