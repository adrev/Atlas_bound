import { describe, it, expect } from 'vitest';
import {
  getSpellImageUrl, getItemImageUrl, getCreatureImageUrl,
  getCompendiumImageUrl,
} from './compendiumIcons';

// These tests lock in the exact URL shape so a refactor of
// compendiumIcons.ts can't silently change the GCS paths we use.
// They also document the slug-vs-name contract: if the caller has
// the authoritative slug, pass it through as-is; bare names get
// slugified as a best-effort fallback.

const CDN = 'https://storage.googleapis.com/atlas-bound-data';

describe('getSpellImageUrl', () => {
  it('passes an authoritative slug through unchanged', () => {
    expect(getSpellImageUrl('altered-strike-a5e'))
      .toBe(`${CDN}/spells/altered-strike-a5e.png`);
  });

  it('handles apostrophed DB slugs without mangling', () => {
    // This was the exact failure mode in the field — the slug
    // "black-goats-blessing" used to come out as
    // "black-goat-s-blessing" because slugify treated the apostrophe
    // as a separator.
    expect(getSpellImageUrl('black-goats-blessing'))
      .toBe(`${CDN}/spells/black-goats-blessing.png`);
  });

  it('slugifies a raw name only when a slug wasn\'t provided', () => {
    expect(getSpellImageUrl('Fire Ball'))
      .toBe(`${CDN}/spells/fire-ball.png`);
  });
});

describe('getItemImageUrl', () => {
  it('passes a slug through', () => {
    expect(getItemImageUrl('flame-tongue'))
      .toBe(`${CDN}/items/flame-tongue.png`);
  });

  it('slugifies a name fallback', () => {
    expect(getItemImageUrl("Ranger's Bow"))
      .toBe(`${CDN}/items/ranger-s-bow.png`);
  });
});

describe('getCreatureImageUrl', () => {
  it('passes a slug through', () => {
    expect(getCreatureImageUrl('adult-red-dragon'))
      .toBe(`${CDN}/tokens/adult-red-dragon.png`);
  });
});

describe('getCompendiumImageUrl', () => {
  it('routes by category', () => {
    expect(getCompendiumImageUrl('fireball', 'spells'))
      .toBe(`${CDN}/spells/fireball.png`);
    expect(getCompendiumImageUrl('goblin', 'monsters'))
      .toBe(`${CDN}/tokens/goblin.png`);
    expect(getCompendiumImageUrl('bag-of-holding', 'items'))
      .toBe(`${CDN}/items/bag-of-holding.png`);
  });

  it('unknown category produces a data: SVG letter-avatar fallback', () => {
    const url = getCompendiumImageUrl('Something', 'other');
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
  });
});
