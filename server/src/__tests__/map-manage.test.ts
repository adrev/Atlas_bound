import { describe, it, expect } from 'vitest';
import {
  mapRenameSchema, mapDuplicateSchema, mapReorderSchema,
} from '../utils/validation.js';

// Schemas only — the socket handlers in sceneEvents.ts are integration-
// tested manually in prod; these tests catch the shape-validation bugs
// that cause silent drops (we learned that lesson from the hero-placement
// bug where a too-strict URL schema ate token-add events).

describe('mapRenameSchema', () => {
  it('accepts a normal rename', () => {
    expect(mapRenameSchema.safeParse({ mapId: 'm1', name: 'Throne Room' }).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const r = mapRenameSchema.safeParse({ mapId: 'm1', name: '  Throne Room  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe('Throne Room');
  });

  it('rejects empty name after trim', () => {
    expect(mapRenameSchema.safeParse({ mapId: 'm1', name: '   ' }).success).toBe(false);
  });

  it('rejects names longer than 80 chars', () => {
    expect(mapRenameSchema.safeParse({ mapId: 'm1', name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('rejects missing mapId', () => {
    expect(mapRenameSchema.safeParse({ name: 'oops' }).success).toBe(false);
  });
});

describe('mapDuplicateSchema', () => {
  it('accepts a non-empty mapId', () => {
    expect(mapDuplicateSchema.safeParse({ mapId: 'm1' }).success).toBe(true);
  });

  it('rejects empty mapId (would otherwise match any row on the DB)', () => {
    expect(mapDuplicateSchema.safeParse({ mapId: '' }).success).toBe(false);
  });
});

describe('mapReorderSchema', () => {
  it('accepts a list of map ids', () => {
    expect(mapReorderSchema.safeParse({ mapIds: ['a', 'b', 'c'] }).success).toBe(true);
  });

  it('rejects an empty list (no-op would waste a round-trip)', () => {
    expect(mapReorderSchema.safeParse({ mapIds: [] }).success).toBe(false);
  });

  it('rejects lists over 500 to cap server-side fan-out', () => {
    const big = Array.from({ length: 501 }, (_, i) => `m${i}`);
    expect(mapReorderSchema.safeParse({ mapIds: big }).success).toBe(false);
  });

  it('rejects entries with empty strings', () => {
    expect(mapReorderSchema.safeParse({ mapIds: ['a', '', 'c'] }).success).toBe(false);
  });

  it('rejects non-string entries', () => {
    expect(mapReorderSchema.safeParse({ mapIds: ['a', 2, 'c'] }).success).toBe(false);
  });
});
