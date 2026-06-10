/**
 * Post-login return path for OAuth flows.
 *
 * The login page can send users into a provider flow with `?next=<path>`
 * (e.g. a Discord invite link: a logged-out player opens /join/<token>,
 * clicks "Continue with Discord", and must land back on /join/<token> —
 * previously every callback hard-redirected to `/?auth=success`, dropping
 * the invite and dead-ending the most common new-player funnel).
 *
 * The path rides an httpOnly cookie between the start handler and the
 * callback (same lifetime/flags as the providers' state cookies) and is
 * validated on BOTH ends: only same-origin absolute-path references are
 * accepted — no schemes, no protocol-relative `//host`, no backslash
 * tricks, no control characters — so the redirect can never leave the
 * app's origin (open-redirect safe).
 */

const COOKIE_NAME = 'oauth_return_to';
const MAX_LENGTH = 512;

/** Accept only a same-origin absolute-path reference; otherwise null. */
export function sanitizeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith('/')) return null;
  // Protocol-relative ("//evil.com") and backslash-confusable ("/\evil.com")
  // references must not pass.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // No control characters, raw spaces (invalid in a Location header),
  // or scheme smuggling anywhere in the value.
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x21 || ch.charCodeAt(0) === 0x7f)) return null;
  if (raw.includes('://') || raw.toLowerCase().includes('javascript:')) return null;
  return raw;
}

/** Set-Cookie line stashing a validated return path for the callback. */
export function returnPathSetCookie(next: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}

/** Set-Cookie line clearing the return-path cookie. */
export function returnPathClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`;
}

/** Read + re-validate the stashed path from parsed request cookies. */
export function readReturnPath(cookies: Record<string, string>): string | null {
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  try {
    return sanitizeReturnPath(decodeURIComponent(raw));
  } catch {
    return null;
  }
}
