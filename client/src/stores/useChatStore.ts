import { create } from 'zustand';
import type { ChatMessage } from '@dnd-vtt/shared';

interface ChatState {
  messages: ChatMessage[];
  /** Number of unread messages (incremented when chat tab is not active). */
  unreadCount: number;
  /** Whether the chat tab is currently visible in the sidebar. */
  chatTabActive: boolean;
}

interface ChatActions {
  addMessage: (message: ChatMessage) => void;
  setHistory: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  incrementUnread: () => void;
  clearUnread: () => void;
  setChatTabActive: (active: boolean) => void;
}

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  messages: [],
  unreadCount: 0,
  chatTabActive: false,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  setHistory: (messages) => set({ messages }),

  clearMessages: () => set({ messages: [] }),

  incrementUnread: () =>
    set((state) => ({ unreadCount: state.unreadCount + 1 })),

  clearUnread: () => set({ unreadCount: 0 }),

  setChatTabActive: (active) =>
    set({ chatTabActive: active, ...(active ? { unreadCount: 0 } : {}) }),
}));
