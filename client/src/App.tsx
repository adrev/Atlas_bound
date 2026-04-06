import { Routes, Route } from 'react-router-dom';
import { SessionLobby } from './components/session/SessionLobby';
import { AppShell } from './components/layout/AppShell';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<SessionLobby />} />
      <Route path="/session/:roomCode" element={<AppShell />} />
    </Routes>
  );
}
