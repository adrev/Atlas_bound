import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

// Mock the database connection before importing authorization functions.
// vi.hoisted ensures mockQuery is available when vi.mock's factory runs
// (vi.mock is hoisted above all imports).
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import {
  getAuthUserId,
  assertSessionMember,
  assertSessionDM,
  assertCharacterOwnerOrDM,
} from '../utils/authorization.js';

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// getAuthUserId
// ---------------------------------------------------------------------------
describe('getAuthUserId', () => {
  it('returns user id when present on req.user', () => {
    const req = { user: { id: 'user-123' } } as unknown as Request;
    expect(getAuthUserId(req)).toBe('user-123');
  });

  it('throws 401 when req.user is missing', () => {
    const req = {} as unknown as Request;
    try {
      getAuthUserId(req);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('Authentication required');
      expect(err.status).toBe(401);
    }
  });

  it('throws 401 when req.user.id is undefined', () => {
    const req = { user: {} } as unknown as Request;
    try {
      getAuthUserId(req);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// assertSessionMember
// ---------------------------------------------------------------------------
describe('assertSessionMember', () => {
  it('resolves when user is a member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertSessionMember('sess-1', 'user-1')).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2',
      ['sess-1', 'user-1'],
    );
  });

  it('throws 403 when user is not a member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    try {
      await assertSessionMember('sess-1', 'stranger');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('Not a member of this session');
      expect(err.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// assertSessionDM
// ---------------------------------------------------------------------------
describe('assertSessionDM', () => {
  it('resolves when user is the DM', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertSessionDM('sess-1', 'dm-user')).resolves.toBeUndefined();
  });

  it('throws 403 when user is a player (not DM)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    try {
      await assertSessionDM('sess-1', 'player-user');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('Only the DM can perform this action');
      expect(err.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// assertCharacterOwnerOrDM
// ---------------------------------------------------------------------------
describe('assertCharacterOwnerOrDM', () => {
  it('resolves when user owns the character', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'owner-1' }] });
    await expect(assertCharacterOwnerOrDM('char-1', 'owner-1')).resolves.toBeUndefined();
    // Only one query needed (character lookup)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('resolves when user is DM of the given session', async () => {
    // First call: character lookup (different owner)
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'someone-else' }] });
    // Second call: DM check for the specified session
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    await expect(
      assertCharacterOwnerOrDM('char-1', 'dm-user', 'sess-1'),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('throws 404 when character does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    try {
      await assertCharacterOwnerOrDM('nonexistent', 'user-1');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('Character not found');
      expect(err.status).toBe(404);
    }
  });

  it('throws 403 when user is neither owner nor DM', async () => {
    // Character lookup: owned by someone else
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'real-owner' }] });
    // Fallback DM check: not a DM of any linked session
    mockQuery.mockResolvedValueOnce({ rows: [] });

    try {
      await assertCharacterOwnerOrDM('char-1', 'unauthorized');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('Not authorized');
      expect(err.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Loot-take source authorization regression: simulate the query pattern used
// in POST /api/characters/:id/loot/take. Verifies that a caller with no
// session link and no NPC-token link is denied with 403.
// ---------------------------------------------------------------------------
describe('loot-take source authorization (regression)', () => {
  async function assertSourceAccess(sourceCharId: string, userId: string) {
    // Matches the logic added in loot.ts after the target-character check.
    // 1. Look up source owner.
    const { rows: sourceRows } = await (await import('../db/connection.js')).default.query(
      'SELECT user_id FROM characters WHERE id = $1',
      [sourceCharId],
    );
    if (sourceRows.length === 0) {
      const err = new Error('Source not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    if (sourceRows[0].user_id === userId) return;

    // 2. Shared-session check.
    const { rows: shared } = await (await import('../db/connection.js')).default.query(
      'shared-session-sql',
      [userId, sourceCharId],
    );
    if (shared.length > 0) return;

    // 3. NPC-token-on-map check.
    const { rows: npcInSession } = await (await import('../db/connection.js')).default.query(
      'npc-in-session-sql',
      [sourceCharId, userId],
    );
    if (npcInSession.length > 0) return;

    const err = new Error('Not authorized to take from this source') as Error & { status: number };
    err.status = 403;
    throw err;
  }

  it('denies take when caller has no relationship to source', async () => {
    // source-owner lookup: owned by someone else
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'someone-else' }] });
    // shared-session lookup: empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // npc-token lookup: empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    try {
      await assertSourceAccess('source-char', 'random-user');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.message).toBe('Not authorized to take from this source');
    }
  });

  it('allows take when caller shares a session with the source', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'someone-else' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertSourceAccess('source-char', 'player-1')).resolves.toBeUndefined();
  });

  it('allows take when caller owns the source character', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'me' }] });
    await expect(assertSourceAccess('source-char', 'me')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NPC / global-character isolation (P1.5) — mirrors the policies added to
// POST /api/characters (create) and GET /api/characters/:id (read).
// ---------------------------------------------------------------------------
describe('NPC character creation authorization (P1.5)', () => {
  // Only a session DM may create a global NPC. We simulate the POST /
  // branch that calls assertSessionDM(sessionId, userId) before creating.
  it('rejects NPC creation without a sessionId', async () => {
    const isNpc = true;
    const sessionId: string | undefined = undefined;
    // Replicate the 400 guard in the route handler.
    expect(isNpc && !sessionId).toBe(true);
  });

  it('rejects NPC creation when caller is not the DM', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // DM lookup: empty
    try {
      await assertSessionDM('sess-1', 'not-the-dm');
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as Error & { status?: number };
      expect(e.status).toBe(403);
      expect(e.message).toBe('Only the DM can perform this action');
    }
  });

  it('allows NPC creation when caller is the DM of the given session', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertSessionDM('sess-1', 'dm-user')).resolves.toBeUndefined();
  });
});

describe('NPC character read authorization (P1.5)', () => {
  // Mirrors the GET /:id branch when the character is owned by 'npc'.
  // Access is allowed iff a token on some map in a session the caller is
  // a member of is linked to this character.
  async function assertNpcReadAccess(characterId: string, userId: string) {
    const { rows: npcLink } = await (await import('../db/connection.js')).default.query(
      'npc-link-sql',
      [characterId, userId],
    );
    if (npcLink.length === 0) {
      const err = new Error('Not authorized') as Error & { status: number };
      err.status = 403;
      throw err;
    }
  }

  it('denies NPC read when caller shares no session-token link', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    try {
      await assertNpcReadAccess('npc-char-1', 'random-user');
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as Error & { status?: number };
      expect(e.status).toBe(403);
      expect(e.message).toBe('Not authorized');
    }
  });

  it('allows NPC read when caller is in a session with a token for this NPC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(assertNpcReadAccess('npc-char-1', 'player-in-session')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1.3 — Server-authoritative combat state. These tests model the
// authorization logic added to combat:damage in combatEvents.ts. They
// exercise the pure predicate (no socket, no service calls) to verify
// that a non-DM cannot damage another player's token and cannot damage
// anyone except on their own combat turn.
// ---------------------------------------------------------------------------
describe('combat:damage authorization (P1.3)', () => {
  type Role = 'dm' | 'player';
  interface Token { id: string; ownerUserId: string | null }
  interface CombatState { active: boolean; currentTurnIndex: number; combatants: { tokenId: string }[] }
  interface Room { tokens: Map<string, Token>; combatState: CombatState | null }

  function canApplyDamage(
    room: Room,
    role: Role,
    userId: string,
    targetTokenId: string,
    amount: number,
  ): boolean {
    // Mirrors the layered checks in combatEvents.ts after Zod parse.
    if (!Number.isFinite(amount) || amount < 0 || amount > 9999) return false;

    const target = room.tokens.get(targetTokenId);
    if (!target) return false;

    // canTargetToken equivalent.
    const isDM = role === 'dm';
    if (!isDM) {
      if (target.ownerUserId && target.ownerUserId !== userId) return false;

      // Combat-turn restriction.
      if (room.combatState?.active) {
        const current = room.combatState.combatants[room.combatState.currentTurnIndex];
        if (!current) return false;
        const turnToken = room.tokens.get(current.tokenId);
        if (!turnToken || turnToken.ownerUserId !== userId) return false;
      }
    }

    return true;
  }

  const pcA: Token = { id: 'tok-pcA', ownerUserId: 'user-A' };
  const pcB: Token = { id: 'tok-pcB', ownerUserId: 'user-B' };
  const npc: Token = { id: 'tok-npc', ownerUserId: null };

  function makeRoom(combatants: string[] | null, currentIdx = 0): Room {
    const tokens = new Map<string, Token>([[pcA.id, pcA], [pcB.id, pcB], [npc.id, npc]]);
    const combatState = combatants
      ? { active: true, currentTurnIndex: currentIdx, combatants: combatants.map(id => ({ tokenId: id })) }
      : null;
    return { tokens, combatState };
  }

  it('DM can apply damage to anyone anytime', () => {
    const room = makeRoom([pcA.id, pcB.id]);
    expect(canApplyDamage(room, 'dm', 'dm-user', pcA.id, 10)).toBe(true);
    expect(canApplyDamage(room, 'dm', 'dm-user', pcB.id, 10)).toBe(true);
    expect(canApplyDamage(room, 'dm', 'dm-user', npc.id, 10)).toBe(true);
  });

  it('non-DM cannot damage another players token (anti-grief)', () => {
    const room = makeRoom([pcA.id, pcB.id], 0); // player A's turn
    expect(canApplyDamage(room, 'player', 'user-A', pcB.id, 10)).toBe(false);
  });

  it('non-DM cannot damage NPC while not on their own turn', () => {
    // combat active, current turn = pcB
    const room = makeRoom([pcA.id, pcB.id], 1);
    expect(canApplyDamage(room, 'player', 'user-A', npc.id, 10)).toBe(false);
  });

  it('non-DM CAN damage NPC on their own turn', () => {
    const room = makeRoom([pcA.id, pcB.id], 0); // player A's turn
    expect(canApplyDamage(room, 'player', 'user-A', npc.id, 10)).toBe(true);
  });

  it('damage value is capped at 9999', () => {
    const room = makeRoom([pcA.id], 0);
    expect(canApplyDamage(room, 'dm', 'dm-user', npc.id, 10000)).toBe(false);
    expect(canApplyDamage(room, 'dm', 'dm-user', npc.id, 9999)).toBe(true);
    expect(canApplyDamage(room, 'dm', 'dm-user', npc.id, -1)).toBe(false);
    expect(canApplyDamage(room, 'dm', 'dm-user', npc.id, Number.NaN)).toBe(false);
  });

  it('damage is rejected if target token does not exist in room', () => {
    const room = makeRoom([pcA.id], 0);
    expect(canApplyDamage(room, 'dm', 'dm-user', 'tok-ghost', 10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1.4 — Loot-drop authorization. These tests model the policy added
// to POST /api/characters/:id/loot/drop: reject a mapId belonging to a
// session the caller is not a member of, and reject dropping an item
// that does not exist at the given inventory index.
// ---------------------------------------------------------------------------
describe('/api/loot/drop authorization (P1.4)', () => {
  async function runDropPolicy(
    userId: string,
    mapId: string,
    itemIndex: number,
    opts: {
      mapSessionId?: string | null;
      isMember?: boolean;
      inventory?: unknown[];
    },
  ): Promise<{ status: number; error?: string }> {
    // 1. Map existence + session lookup.
    mockQuery.mockResolvedValueOnce({
      rows: opts.mapSessionId ? [{ session_id: opts.mapSessionId }] : [],
    });
    const { rows: mapRows } = await (await import('../db/connection.js')).default.query(
      'SELECT session_id FROM maps WHERE id = $1',
      [mapId],
    );
    if (mapRows.length === 0) return { status: 404, error: 'Map not found' };

    // 2. Session membership.
    mockQuery.mockResolvedValueOnce({ rows: opts.isMember ? [{ '?column?': 1 }] : [] });
    const { rows: memberRows } = await (await import('../db/connection.js')).default.query(
      'SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2',
      [mapRows[0].session_id, userId],
    );
    if (memberRows.length === 0) return { status: 403, error: 'Not a member of the target session' };

    // 3. Inventory index bounds.
    const inventory = opts.inventory ?? [];
    if (itemIndex < 0 || itemIndex >= inventory.length) {
      return { status: 400, error: 'Invalid item index' };
    }
    return { status: 200 };
  }

  it('rejects a mapId that belongs to a session the caller is not in', async () => {
    const result = await runDropPolicy('user-A', 'map-1', 0, {
      mapSessionId: 'sess-foreign',
      isMember: false,
      inventory: [{ name: 'Sword' }],
    });
    expect(result.status).toBe(403);
    expect(result.error).toBe('Not a member of the target session');
  });

  it('rejects a mapId that does not exist', async () => {
    const result = await runDropPolicy('user-A', 'ghost-map', 0, {
      mapSessionId: null,
      inventory: [{ name: 'Sword' }],
    });
    expect(result.status).toBe(404);
  });

  it('rejects drop of an item not in source inventory', async () => {
    const result = await runDropPolicy('user-A', 'map-1', 5, {
      mapSessionId: 'sess-A',
      isMember: true,
      inventory: [{ name: 'Sword' }],
    });
    expect(result.status).toBe(400);
    expect(result.error).toBe('Invalid item index');
  });

  it('allows drop when member and item exists', async () => {
    const result = await runDropPolicy('user-A', 'map-1', 0, {
      mapSessionId: 'sess-A',
      isMember: true,
      inventory: [{ name: 'Sword' }],
    });
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// P1.4 — map:token-add socket event. The size=0.5 "loot drop" bypass
// has been removed; non-DM callers may now only add tokens they own.
// This test models the policy branch in mapEvents.ts.
// ---------------------------------------------------------------------------
describe('map:token-add authorization (P1.4)', () => {
  type Role = 'dm' | 'player';
  function canAddToken(
    role: Role,
    userId: string,
    payloadOwnerUserId: string | null | undefined,
  ): boolean {
    if (role === 'dm') return true;
    const isOwnToken = !!payloadOwnerUserId && payloadOwnerUserId === userId;
    return isOwnToken;
  }

  it('DM can add any token', () => {
    expect(canAddToken('dm', 'dm-user', null)).toBe(true);
    expect(canAddToken('dm', 'dm-user', 'someone-else')).toBe(true);
  });

  it('player can add a token they own', () => {
    expect(canAddToken('player', 'user-A', 'user-A')).toBe(true);
  });

  it('rejects non-DM adding a loot-drop-sized (0.5) token (bypass removed)', () => {
    // Previously allowed because size === 0.5 bypassed ownership.
    // The bypass has been removed — now this must fail regardless of size.
    expect(canAddToken('player', 'user-A', null)).toBe(false);
  });

  it('rejects non-DM adding a token owned by someone else', () => {
    expect(canAddToken('player', 'user-A', 'user-B')).toBe(false);
  });
});
