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
