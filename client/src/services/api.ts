const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'include',
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

export interface CreateSessionOptions {
  name: string;
  displayName: string;
  visibility?: 'public' | 'private';
  /** Required only for private sessions. Omit for invite-only private. */
  password?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  roomCode: string;
  userId: string;
  visibility: 'public' | 'private';
  hasPassword: boolean;
  inviteCode: string | null;
}

export function createSession(opts: CreateSessionOptions) {
  return request<CreateSessionResult>('/sessions', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

/**
 * Result shapes for POST /sessions/join. The server can return:
 *  \u2022 200 + JoinOk                 \u2014 user is in
 *  \u2022 401 + requiresPassword: true  \u2014 private session, try again with pw/token
 *  \u2022 403 + error: 'banned'         \u2014 rejected with reason
 *  \u2022 404                           \u2014 room code didn't match
 * We model each explicitly so the caller can render the right UI
 * without parsing error strings.
 */
export type JoinSessionResult =
  | { ok: true; sessionId: string; userId: string; sessionName: string; roomCode: string }
  | { ok: false; kind: 'requires-password'; hasPassword: boolean }
  | { ok: false; kind: 'banned'; reason: string | null; bannedBy: string | null; bannedAt: string }
  | { ok: false; kind: 'not-found' }
  | { ok: false; kind: 'error'; message: string };

export async function joinSession(args: {
  roomCode: string;
  displayName?: string;
  password?: string;
  inviteToken?: string;
}): Promise<JoinSessionResult> {
  const res = await fetch('/api/sessions/join', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

  if (res.ok) {
    const data = await res.json();
    return { ok: true, ...data };
  }

  if (res.status === 404) return { ok: false, kind: 'not-found' };

  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.requiresPassword) {
    return { ok: false, kind: 'requires-password', hasPassword: !!body.hasPassword };
  }
  if (res.status === 403 && body.error === 'banned') {
    return {
      ok: false, kind: 'banned',
      reason: body.reason ?? null,
      bannedBy: body.bannedBy ?? null,
      bannedAt: body.bannedAt,
    };
  }
  return { ok: false, kind: 'error', message: body.error ?? `HTTP ${res.status}` };
}

export function getInviteInfo(token: string) {
  return request<{ sessionId: string; sessionName: string; roomCode: string }>(
    `/sessions/invites/${encodeURIComponent(token)}`,
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
    visibility: 'public' | 'private';
    hasPassword: boolean;
    inviteCode: string | null;
  }>(`/sessions/${sessionId}`);
}

export function patchSession(
  sessionId: string,
  patch: {
    name?: string;
    visibility?: 'public' | 'private';
    password?: string;               // empty string removes the password
    regenerateInvite?: boolean;
  },
) {
  return request<{ visibility: 'public' | 'private'; hasPassword: boolean; inviteCode: string | null }>(
    `/sessions/${sessionId}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
}

// --- Bans / role management ---
export interface BanEntry {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  bannedBy: string | null;
  bannedByUserId: string;
  bannedAt: string;
  reason: string | null;
}

export function getBans(sessionId: string) {
  return request<BanEntry[]>(`/sessions/${sessionId}/bans`);
}

export function banUser(sessionId: string, targetUserId: string, reason?: string) {
  return fetch(`/api/sessions/${sessionId}/bans`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUserId, reason }),
  }).then((r) => {
    if (!r.ok) throw new Error(`Ban failed: ${r.status}`);
  });
}

export function unbanUser(sessionId: string, targetUserId: string) {
  return fetch(`/api/sessions/${sessionId}/bans/${encodeURIComponent(targetUserId)}`, {
    method: 'DELETE',
    credentials: 'include',
  }).then((r) => {
    if (!r.ok) throw new Error(`Unban failed: ${r.status}`);
  });
}

export function promoteToDM(sessionId: string, targetUserId: string) {
  return fetch(`/api/sessions/${sessionId}/promote`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUserId }),
  }).then((r) => { if (!r.ok) throw new Error(`Promote failed: ${r.status}`); });
}

export function demoteFromDM(sessionId: string, targetUserId: string) {
  return fetch(`/api/sessions/${sessionId}/demote`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUserId }),
  }).then((r) => { if (!r.ok) throw new Error(`Demote failed: ${r.status}`); });
}

export function deleteSession(sessionId: string) {
  return fetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
    credentials: 'include',
  }).then((r) => { if (!r.ok) throw new Error(`Delete failed: ${r.status}`); });
}

export function transferOwnership(sessionId: string, newOwnerId: string) {
  return fetch(`/api/sessions/${sessionId}/transfer-ownership`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newOwnerId }),
  }).then((r) => { if (!r.ok) throw new Error(`Transfer failed: ${r.status}`); });
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
