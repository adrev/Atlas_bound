import { create } from 'zustand';
import { disconnectSocket } from '../socket/client';

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
}

interface AuthActions {
  checkAuth: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, displayName: string) => Promise<boolean>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  user: null,
  loading: true,
  error: null,

  checkAuth: async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        set({ user: data.user, loading: false, error: null });
      } else {
        set({ user: null, loading: false });
      }
    } catch {
      set({ user: null, loading: false });
    }
  },

  login: async (email, password) => {
    set({ error: null });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const data = await res.json();
        set({ user: data.user, error: null });
        return true;
      }
      const err = await res.json().catch(() => ({ error: 'Login failed' }));
      const msg = err.details?.[0]?.message || err.error || err.message || 'Login failed';
      set({ error: msg });
      return false;
    } catch {
      set({ error: 'Network error — could not reach server' });
      return false;
    }
  },

  register: async (email, password, displayName) => {
    set({ error: null });
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, displayName }),
      });
      if (res.ok) {
        const data = await res.json();
        set({ user: data.user, error: null });
        return true;
      }
      const err = await res.json().catch(() => ({ error: 'Registration failed' }));
      const msg = err.details?.[0]?.message || err.error || err.message || 'Registration failed';
      set({ error: msg });
      return false;
    } catch {
      set({ error: 'Network error — could not reach server' });
      return false;
    }
  },

  logout: async () => {
    // Disconnect the WebSocket before clearing state
    disconnectSocket();
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Even if the server call fails, clear local state
    }
    set({ user: null, error: null });
  },

  setUser: (user) => set({ user }),

  clearError: () => set({ error: null }),
}));
