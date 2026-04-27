/**
 * Single source of truth for the running client build's "app version".
 * Used by:
 *   - FeedbackModal — auto-attaches to every feedback submission so
 *     admins can correlate reports with deploys.
 *   - Anything that wants to display the version (e.g. about screen,
 *     debug overlay).
 *
 * Bump this whenever a deploy ships material change. Mirroring the
 * package.json version manually here is intentional: keeping it in
 * the src tree means tsconfig (`include: ["src"]`) doesn't have to
 * widen to suck in package.json, and we don't introduce a Vite
 * `define` shim that other tools have to teach themselves about.
 */
export const APP_VERSION = '1.0.0';
