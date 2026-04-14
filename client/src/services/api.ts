const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || error.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

// --- Sessions ---
export function createSession(name: string, displayName: string) {
  return request<{ sessionId: string; roomCode: string; userId: string }>(
    '/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ name, displayName }),
    }
  );
}

export function joinSession(roomCode: string, displayName: string) {
  return request<{ sessionId: string; userId: string }>(
    `/sessions/join`,
    {
      method: 'POST',
      body: JSON.stringify({ roomCode, displayName }),
    }
  );
}

export function getSession(sessionId: string) {
  return request<{
    id: string;
    name: string;
    roomCode: string;
    dmUserId: string;
    currentMapId: string | null;
    combatActive: boolean;
    settings: Record<string, unknown>;
  }>(`/sessions/${sessionId}`);
}

// --- Maps ---
export function createMap(
  sessionId: string,
  data: {
    name: string;
    width: number;
    height: number;
    gridSize?: number;
    /** Set when loading a prebuilt map so the server dedups by name.
     *  The same session + same name returns the existing id instead
     *  of inserting a duplicate row, preserving walls/fog/tokens. */
    prebuiltKey?: string;
  }
) {
  return request<{ id: string; reused?: boolean }>(`/sessions/${sessionId}/maps`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getMaps(sessionId: string) {
  return request<{ id: string; name: string; createdAt: string }[]>(
    `/sessions/${sessionId}/maps`
  );
}

export function getMap(sessionId: string, mapId: string) {
  return request<Record<string, unknown>>(
    `/sessions/${sessionId}/maps/${mapId}`
  );
}

// --- Characters ---
export function createCharacter(data: Record<string, unknown>) {
  return request<{ id: string }>('/characters', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getCharacter(characterId: string) {
  return request<Record<string, unknown>>(`/characters/${characterId}`);
}

export function updateCharacter(
  characterId: string,
  data: Record<string, unknown>
) {
  return request<Record<string, unknown>>(`/characters/${characterId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function importDndBeyondJSON(json: Record<string, unknown>) {
  return request<Record<string, unknown>>('/characters/import/dndbeyond', {
    method: 'POST',
    body: JSON.stringify(json),
  });
}
