import { describe, expect, it } from 'vitest';
import {
  PREBUILT_IMAGE_BY_NAME,
  PREBUILT_THUMBNAIL,
  normalizePrebuiltMapKey,
} from './prebuiltMaps';

describe('prebuilt map lookups', () => {
  it('normalizes display names into stable legacy lookup keys', () => {
    expect(normalizePrebuiltMapKey('The Elfsong Tavern')).toBe('the-elfsong-tavern');
    expect(normalizePrebuiltMapKey('Wizard’s Study')).toBe('wizards-study');
    expect(normalizePrebuiltMapKey('Apothecary & Cellar')).toBe('apothecary-and-cellar');
  });

  it('resolves current, legacy, and slugged Elfsong names', () => {
    const expected =
      'https://storage.googleapis.com/atlas-bound-public-assets-personal/maps/elfsong-tavern.png';

    expect(PREBUILT_IMAGE_BY_NAME['The Elfsong Tavern']).toBe(expected);
    expect(PREBUILT_IMAGE_BY_NAME['Elfsong Tavern']).toBe(expected);
    expect(PREBUILT_IMAGE_BY_NAME['elfsong-tavern']).toBe(expected);
    expect(PREBUILT_THUMBNAIL['Elfsong Tavern']).toBe(
      'https://storage.googleapis.com/atlas-bound-public-assets-personal/maps/thumbnails/elfsong-tavern.jpg'
    );
  });
});
