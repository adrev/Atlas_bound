import { useEffect } from 'react';
import { Routes, Route, useSearchParams } from 'react-router-dom';
import { SessionLobby } from './components/session/SessionLobby';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './components/auth/LoginPage';
import { useAuthStore } from './stores/useAuthStore';
import { theme } from './styles/theme';

export function App() {
  const { user, loading, checkAuth } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Handle ?auth=success redirect from OAuth flow
  useEffect(() => {
    if (searchParams.get('auth') === 'success') {
      checkAuth();
      // Strip the query param from the URL
      searchParams.delete('auth');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, checkAuth]);

  if (loading) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: theme.bg.deepest,
        }}
      >
        <p
          style={{
            fontFamily: theme.font.display,
            fontSize: 20,
            color: theme.gold.primary,
            letterSpacing: '3px',
          }}
        >
          Loading...
        </p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route path="/" element={<SessionLobby />} />
      <Route path="/session/:roomCode" element={<AppShell />} />
    </Routes>
  );
}
