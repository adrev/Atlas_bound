import { describe, it, expect } from 'vitest';
import { validateConfig } from '../config.js';

/**
 * validateConfig is boot-time, warnings-only config sanity. It must NOT
 * throw (the hard-required DB connection is enforced elsewhere) and must
 * stay silent outside production so local dev isn't nagged.
 */
describe('validateConfig', () => {
  it('returns no warnings outside production', () => {
    expect(validateConfig({ NODE_ENV: 'development' })).toEqual([]);
    expect(validateConfig({})).toEqual([]);
  });

  it('warns on missing OAuth + localhost BASE_URL in production', () => {
    const w = validateConfig({ NODE_ENV: 'production', BASE_URL: 'http://localhost:5173' });
    expect(w.some((x) => /No OAuth provider/.test(x))).toBe(true);
    expect(w.some((x) => /BASE_URL/.test(x))).toBe(true);
    expect(w).toHaveLength(2);
  });

  it('flags an unset BASE_URL but not OAuth when a provider is configured', () => {
    const w = validateConfig({ NODE_ENV: 'production', GOOGLE_CLIENT_ID: 'g' });
    expect(w.some((x) => /BASE_URL/.test(x) && /unset/.test(x))).toBe(true);
    expect(w.some((x) => /No OAuth provider/.test(x))).toBe(false);
  });

  it('is silent when production is properly configured', () => {
    expect(validateConfig({
      NODE_ENV: 'production',
      DISCORD_CLIENT_ID: 'd',
      BASE_URL: 'https://dnd.kbrt.ai',
    })).toEqual([]);
  });
});
