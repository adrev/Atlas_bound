import { describe, it, expect } from 'vitest';
import { resolveSpellSlug, SPELL_ALIASES } from './spell-aliases';

describe('resolveSpellSlug', () => {
  it('maps DDB creator-named slugs to the SRD slug', () => {
    expect(resolveSpellSlug('tashas-hideous-laughter')).toBe('hideous-laughter');
    expect(resolveSpellSlug('bigbys-hand')).toBe('arcane-hand');
    expect(resolveSpellSlug('leomunds-tiny-hut')).toBe('tiny-hut');
  });

  it('passes through slugs that have no alias', () => {
    expect(resolveSpellSlug('fireball')).toBe('fireball');
    expect(resolveSpellSlug('eldritch-blast')).toBe('eldritch-blast');
  });

  it('passes through an empty string unchanged', () => {
    expect(resolveSpellSlug('')).toBe('');
  });
});

describe('SPELL_ALIASES data sanity', () => {
  it('alias targets never equal their source (would be a no-op)', () => {
    for (const [from, to] of Object.entries(SPELL_ALIASES)) {
      expect(from).not.toBe(to);
    }
  });

  it('all slugs are lowercase + dash-separated', () => {
    const slugRE = /^[a-z0-9-]+$/;
    for (const [from, to] of Object.entries(SPELL_ALIASES)) {
      expect(slugRE.test(from), `from: ${from}`).toBe(true);
      expect(slugRE.test(to), `to: ${to}`).toBe(true);
    }
  });
});
