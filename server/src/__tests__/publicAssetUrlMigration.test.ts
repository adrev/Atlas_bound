import { describe, expect, it } from 'vitest';
import {
  CURRENT_PUBLIC_ASSET_PREFIX,
  LEGACY_PUBLIC_ASSET_PREFIX,
  PUBLIC_ASSET_URL_MIGRATION_TARGETS,
  countLegacyPublicAssetUrls,
  quoteSqlIdentifier,
  replaceLegacyPublicAssetUrls,
} from '../utils/publicAssetUrlMigration.js';

describe('public asset URL migration helpers', () => {
  it('replaces every exact legacy public asset prefix', () => {
    const oldMap = `${LEGACY_PUBLIC_ASSET_PREFIX}maps/forest.png`;
    const oldThumb = `${LEGACY_PUBLIC_ASSET_PREFIX}maps/thumbnails/forest.jpg`;

    expect(replaceLegacyPublicAssetUrls(`${oldMap} ${oldThumb}`)).toBe(
      `${CURRENT_PUBLIC_ASSET_PREFIX}maps/forest.png ${CURRENT_PUBLIC_ASSET_PREFIX}maps/thumbnails/forest.jpg`
    );
  });

  it('does not rewrite private upload paths or similarly named buckets', () => {
    const value = [
      '/uploads/maps/custom.png',
      'https://storage.googleapis.com/atlas-bound-data-personal/uploads/maps/custom.png',
      'https://storage.googleapis.com/someone-elses-bucket/maps/forest.png',
    ].join(' ');

    expect(replaceLegacyPublicAssetUrls(value)).toBe(value);
    expect(countLegacyPublicAssetUrls(value)).toBe(0);
  });

  it('counts legacy prefixes inside JSON text without parsing row contents', () => {
    const value = JSON.stringify([
      { imageUrl: `${LEGACY_PUBLIC_ASSET_PREFIX}tokens/goblin.png` },
      { imageUrl: `${LEGACY_PUBLIC_ASSET_PREFIX}items/potion.png` },
    ]);

    expect(countLegacyPublicAssetUrls(value)).toBe(2);
  });

  it('covers URL-bearing gameplay and content columns', () => {
    expect(PUBLIC_ASSET_URL_MIGRATION_TARGETS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'maps', column: 'image_url' }),
        expect.objectContaining({ table: 'maps', column: 'thumbnail_url' }),
        expect.objectContaining({ table: 'tokens', column: 'image_url' }),
        expect.objectContaining({ table: 'characters', column: 'portrait_url' }),
        expect.objectContaining({ table: 'characters', column: 'inventory' }),
        expect.objectContaining({ table: 'custom_items', column: 'image_url' }),
        expect.objectContaining({ table: 'custom_monsters', column: 'image_url' }),
        expect.objectContaining({ table: 'custom_spells', column: 'image_url' }),
        expect.objectContaining({ table: 'encounter_presets', column: 'creatures' }),
        expect.objectContaining({ table: 'session_notes', column: 'image_url' }),
      ])
    );
  });

  it('quotes only expected SQL identifiers', () => {
    expect(quoteSqlIdentifier('session_notes')).toBe('"session_notes"');
    expect(() => quoteSqlIdentifier('session_notes;DROP TABLE users')).toThrow(
      'Unsafe SQL identifier'
    );
  });
});
