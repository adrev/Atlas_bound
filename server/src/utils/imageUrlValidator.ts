import { z } from 'zod';

/**
 * Allowlist of external hostnames that may be used as image sources.
 *
 * Anything outside this list (including arbitrary third-party hosts) is
 * rejected to prevent:
 *   - privacy tracking via image loads leaking user IPs
 *   - mixed-content / http: downgrades
 *   - content injection from arbitrary external hosts
 */
const ALLOWED_HOSTS = [
  'storage.googleapis.com',        // our GCS bucket (atlas-bound-data)
  'cdn.discordapp.com',            // Discord avatars
  'lh3.googleusercontent.com',     // Google avatars
  'www.dndbeyond.com',             // D&D Beyond character portraits
  'media-waterdeep.cursecdn.com',  // D&D Beyond image CDN
  'i.ibb.co',                      // imgbb (common community host)
];

/**
 * Accepts:
 *  - empty string / undefined (caller decides whether empty is valid)
 *  - relative paths under /uploads/ or /maps/
 *  - data:image/ URIs (inline SVG / PNG used by compendium icons)
 *  - https: absolute URLs whose host matches (exactly or as a subdomain)
 *    an entry in ALLOWED_HOSTS
 *
 * Rejects plain http:, javascript:, file:, arbitrary external hosts,
 * and anything that doesn't parse as a URL.
 */
export const safeImageUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      if (!value) return true; // empty allowed — let caller use .optional()/.nullable()
      if (value.startsWith('/uploads/')) return true;
      if (value.startsWith('/maps/')) return true;
      // data:image URIs are allowed only for raster formats we know
      // the browser renders without script execution. SVG in
      // particular would let an attacker smuggle <script> into the
      // token portrait pipeline — so even though we HAVE an inline
      // SVG letter-avatar shipped by the client, those are
      // regenerated at the server boundary, not persisted here.
      if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(value)) return true;
      // DDB portraits are stored as `/api/dndbeyond/proxy-image?url=...`
      // so the browser loads them through our origin (fixes CORS +
      // keeps the user's IP from leaking to DDB). The proxy endpoint
      // itself validates the target hostname, so allowing this prefix
      // here doesn't widen the attack surface. Without it, tokens with
      // a DDB-proxied portrait silently fail map:token-add validation.
      if (value.startsWith('/api/dndbeyond/proxy-image?')) return true;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') return false;
        return ALLOWED_HOSTS.some(
          (h) => url.hostname === h || url.hostname.endsWith('.' + h),
        );
      } catch {
        return false;
      }
    },
    { message: 'Image URL must be a relative upload path or on an approved host' },
  );

export { ALLOWED_HOSTS };
