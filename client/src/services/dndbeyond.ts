/**
 * Client-side service for fetching D&D Beyond character data.
 * Proxies requests through our server to avoid CORS issues.
 */

export interface DndBeyondCharacterResult {
  id: number;
  name: string;
  race: { fullName: string };
  classes: Array<{ definition: { name: string }; level: number }>;
  [key: string]: unknown;
}

/**
 * Fetch a D&D Beyond character by its numeric character ID.
 * Requests go through our server proxy at /api/dndbeyond/character/:id.
 */
export async function fetchDndBeyondCharacter(characterId: string): Promise<DndBeyondCharacterResult> {
  const response = await fetch(`/api/dndbeyond/character/${characterId}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || `Failed to fetch character (${response.status})`);
  }
  return response.json();
}

/**
 * Import a fetched D&D Beyond character JSON into our system.
 * Sends to /api/dndbeyond/import which parses and saves to DB.
 */
export async function importDndBeyondCharacter(
  characterJson: Record<string, unknown>,
  userId: string,
): Promise<{ id: string }> {
  const response = await fetch('/api/dndbeyond/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterJson, userId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || `Failed to import character (${response.status})`);
  }
  return response.json();
}
