import type { Request } from 'express';
import { BASE_URL, CORS_ORIGINS } from '../../config.js';

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim();
}

const configuredOrigins = new Set(
  [BASE_URL, ...CORS_ORIGINS]
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin)),
);

const fallbackOrigin = normalizeOrigin(BASE_URL) ?? BASE_URL;

export function getOAuthOrigin(req: Request): string {
  const host = firstHeaderValue(req.headers['x-forwarded-host']) ?? req.get('host');
  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) ?? req.protocol;
  const requestOrigin = normalizeOrigin(host ? `${proto}://${host}` : undefined);

  if (requestOrigin && configuredOrigins.has(requestOrigin)) {
    return requestOrigin;
  }

  return fallbackOrigin;
}
