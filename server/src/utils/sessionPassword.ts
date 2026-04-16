import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

/**
 * Session passwords sit alongside Lucia's account passwords but are
 * a much lower-stakes secret (shared with a whole table of players).
 * We still bcrypt them so a leaked DB dump doesn't expose plaintext
 * passwords that players may have reused.
 *
 * Cost factor matches the auth login path (`bcrypt.hash(pw, 10)`),
 * since verify latency shows up on every join attempt.
 */
const BCRYPT_COST = 10;

export async function hashSessionPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifySessionPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a URL-safe shareable invite token. 16 bytes of crypto-random
 * → 22 base64url chars. Collision probability inside a reasonable-sized
 * atlas is astronomically low; the DB has a UNIQUE index on invite_code
 * as a belt-and-braces check.
 */
export function generateInviteCode(): string {
  return randomBytes(16).toString('base64url');
}
