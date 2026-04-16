import { describe, it, expect } from 'vitest';
import {
  createSessionSchema, joinSessionSchema, patchSessionSchema,
  sessionBanSchema, sessionUnbanSchema,
  sessionPromoteSchema, sessionDemoteSchema, transferOwnershipSchema,
} from '../utils/validation.js';
import {
  hashSessionPassword, verifySessionPassword, generateInviteCode,
} from '../utils/sessionPassword.js';

// ---------------------------------------------------------------------------
// Schemas \u2014 the thin edge between client and server
// ---------------------------------------------------------------------------

describe('createSessionSchema', () => {
  it('accepts a minimal public session', () => {
    expect(createSessionSchema.safeParse({ name: 'My Game' }).success).toBe(true);
  });

  it('accepts a private session with password', () => {
    expect(createSessionSchema.safeParse({
      name: 'Secret', visibility: 'private', password: 'abcd',
    }).success).toBe(true);
  });

  it('rejects passwords under 4 chars', () => {
    expect(createSessionSchema.safeParse({
      name: 'x', visibility: 'private', password: 'abc',
    }).success).toBe(false);
  });

  it('rejects passwords over 64 chars', () => {
    expect(createSessionSchema.safeParse({
      name: 'x', visibility: 'private', password: 'a'.repeat(65),
    }).success).toBe(false);
  });
});

describe('joinSessionSchema', () => {
  it('accepts room code + password', () => {
    const r = joinSessionSchema.safeParse({ roomCode: 'ABC123', password: 'hunter' });
    expect(r.success).toBe(true);
  });
  it('accepts room code + invite token', () => {
    const r = joinSessionSchema.safeParse({ roomCode: 'ABC123', inviteToken: 'ABCDEFGHIJ' });
    expect(r.success).toBe(true);
  });
  it('accepts bare room code (public session)', () => {
    expect(joinSessionSchema.safeParse({ roomCode: 'ABC123' }).success).toBe(true);
  });
  it('rejects too-short invite token', () => {
    expect(joinSessionSchema.safeParse({ roomCode: 'x', inviteToken: 'short' }).success).toBe(false);
  });
});

describe('patchSessionSchema', () => {
  it('accepts a visibility-only patch', () => {
    expect(patchSessionSchema.safeParse({ visibility: 'private' }).success).toBe(true);
  });
  it('accepts an empty-string password (means "remove password")', () => {
    expect(patchSessionSchema.safeParse({ password: '' }).success).toBe(true);
  });
  it('rejects a 3-char password', () => {
    expect(patchSessionSchema.safeParse({ password: 'abc' }).success).toBe(false);
  });
  it('accepts regenerateInvite: true alone', () => {
    expect(patchSessionSchema.safeParse({ regenerateInvite: true }).success).toBe(true);
  });
});

describe('ban / role schemas', () => {
  const uid = '11111111-1111-1111-1111-111111111111';
  it('accepts ban with optional reason', () => {
    expect(sessionBanSchema.safeParse({ targetUserId: uid }).success).toBe(true);
    expect(sessionBanSchema.safeParse({ targetUserId: uid, reason: 'griefing' }).success).toBe(true);
  });
  it('rejects reason over 200 chars', () => {
    expect(sessionBanSchema.safeParse({ targetUserId: uid, reason: 'x'.repeat(201) }).success).toBe(false);
  });
  it('rejects a non-UUID targetUserId (prevents 500 on FK violation)', () => {
    expect(sessionBanSchema.safeParse({ targetUserId: 'not-a-uuid' }).success).toBe(false);
  });
  it('unban requires targetUserId', () => {
    expect(sessionUnbanSchema.safeParse({}).success).toBe(false);
    expect(sessionUnbanSchema.safeParse({ targetUserId: uid }).success).toBe(true);
  });
  it('promote / demote / transfer schemas smoke', () => {
    expect(sessionPromoteSchema.safeParse({ targetUserId: uid }).success).toBe(true);
    expect(sessionDemoteSchema.safeParse({ targetUserId: uid }).success).toBe(true);
    expect(transferOwnershipSchema.safeParse({ newOwnerId: uid }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Password helper round-trip
// ---------------------------------------------------------------------------

describe('session password hash/verify', () => {
  it('verify returns true for the same password', async () => {
    const hash = await hashSessionPassword('correct-horse-battery-staple');
    expect(await verifySessionPassword('correct-horse-battery-staple', hash)).toBe(true);
  });
  it('verify returns false for a wrong password', async () => {
    const hash = await hashSessionPassword('hunter');
    expect(await verifySessionPassword('not-hunter', hash)).toBe(false);
  });
  it('hash of the same password differs each time (salted)', async () => {
    const a = await hashSessionPassword('pw');
    const b = await hashSessionPassword('pw');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Invite code generator
// ---------------------------------------------------------------------------

describe('generateInviteCode', () => {
  it('produces URL-safe 22-char base64url strings', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeGreaterThanOrEqual(20);
  });
  it('is statistically unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateInviteCode());
    expect(seen.size).toBe(1000);
  });
});
