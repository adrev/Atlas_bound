import { describe, it, expect } from 'vitest';
import { safeImageUrlSchema } from '../utils/imageUrlValidator.js';

describe('safeImageUrlSchema', () => {
  it('accepts relative /uploads/ path', () => {
    expect(safeImageUrlSchema.safeParse('/uploads/portraits/abc.png').success).toBe(true);
  });

  it('accepts relative /maps/ path', () => {
    expect(safeImageUrlSchema.safeParse('/maps/forest.png').success).toBe(true);
  });

  it('accepts data: image URI', () => {
    expect(safeImageUrlSchema.safeParse('data:image/svg+xml,<svg></svg>').success).toBe(true);
  });

  it('accepts https URL on our GCS bucket', () => {
    const url = 'https://storage.googleapis.com/atlas-bound-data/maps/forest.png';
    expect(safeImageUrlSchema.safeParse(url).success).toBe(true);
  });

  it('accepts https URL on Discord CDN', () => {
    expect(safeImageUrlSchema.safeParse('https://cdn.discordapp.com/avatars/1/abc.png').success).toBe(true);
  });

  it('accepts https URL on DnDBeyond', () => {
    expect(safeImageUrlSchema.safeParse('https://www.dndbeyond.com/avatars/abc.png').success).toBe(true);
  });

  it('rejects http (non-TLS) URL', () => {
    expect(safeImageUrlSchema.safeParse('http://example.com/img.png').success).toBe(false);
  });

  it('rejects arbitrary external https host', () => {
    expect(safeImageUrlSchema.safeParse('https://evil.example.com/track.gif').success).toBe(false);
  });

  it('rejects javascript: scheme', () => {
    expect(safeImageUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });

  it('rejects file: scheme', () => {
    expect(safeImageUrlSchema.safeParse('file:///etc/passwd').success).toBe(false);
  });

  it('accepts empty string (let .optional()/.nullable() handle policy)', () => {
    expect(safeImageUrlSchema.safeParse('').success).toBe(true);
  });

  it('rejects hostnames that look like suffix matches but are not', () => {
    // Would be a bug if 'notstorage.googleapis.com' was accepted.
    expect(safeImageUrlSchema.safeParse('https://notstorage.googleapis.com/foo.png').success).toBe(false);
  });

  it('rejects string longer than 2000 chars', () => {
    const big = '/uploads/' + 'a'.repeat(2500);
    expect(safeImageUrlSchema.safeParse(big).success).toBe(false);
  });
});
