import { describe, it, expect } from 'vitest';
import {
  zoneAddSchema, zoneUpdateSchema, zoneDeleteSchema,
} from '../utils/validation.js';
import { safeParseJSON } from '../utils/safeJson.js';

// ---------------------------------------------------------------------------
// Encounter-spawn zone schemas
// ---------------------------------------------------------------------------

describe('zoneAddSchema', () => {
  it('accepts a well-formed zone', () => {
    const r = zoneAddSchema.safeParse({
      name: 'North woods',
      x: 100, y: 200,
      width: 300, height: 400,
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty names', () => {
    const r = zoneAddSchema.safeParse({ name: '', x: 0, y: 0, width: 100, height: 100 });
    expect(r.success).toBe(false);
  });

  it('rejects names longer than 64 chars', () => {
    const r = zoneAddSchema.safeParse({
      name: 'x'.repeat(65), x: 0, y: 0, width: 100, height: 100,
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative width', () => {
    const r = zoneAddSchema.safeParse({ name: 'x', x: 0, y: 0, width: -5, height: 10 });
    expect(r.success).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    const r = zoneAddSchema.safeParse({
      name: 'x', x: Infinity, y: 0, width: 10, height: 10,
    });
    expect(r.success).toBe(false);
  });

  it('rejects coordinates past the 20_000 cap', () => {
    const r = zoneAddSchema.safeParse({
      name: 'x', x: 25000, y: 0, width: 10, height: 10,
    });
    expect(r.success).toBe(false);
  });
});

describe('zoneUpdateSchema', () => {
  it('accepts a partial patch with just zoneId + name', () => {
    const r = zoneUpdateSchema.safeParse({ zoneId: 'abc-123', name: 'Renamed' });
    expect(r.success).toBe(true);
  });

  it('accepts a partial patch with geometry only', () => {
    const r = zoneUpdateSchema.safeParse({ zoneId: 'abc-123', width: 120 });
    expect(r.success).toBe(true);
  });

  it('rejects patch missing zoneId', () => {
    const r = zoneUpdateSchema.safeParse({ name: 'oops' });
    expect(r.success).toBe(false);
  });
});

describe('zoneDeleteSchema', () => {
  it('accepts a non-empty zoneId', () => {
    expect(zoneDeleteSchema.safeParse({ zoneId: 'abc' }).success).toBe(true);
  });
  it('rejects an empty zoneId', () => {
    expect(zoneDeleteSchema.safeParse({ zoneId: '' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safeParseJSON — defense against corrupt DB rows
// ---------------------------------------------------------------------------

describe('safeParseJSON', () => {
  it('parses valid JSON', () => {
    expect(safeParseJSON<number[]>('[1,2,3]', [])).toEqual([1, 2, 3]);
  });

  it('falls back cleanly on malformed JSON', () => {
    const fallback: unknown[] = [];
    expect(safeParseJSON('{not valid', fallback)).toBe(fallback);
  });

  it('falls back on null', () => {
    expect(safeParseJSON<number[]>(null, [])).toEqual([]);
  });

  it('passes through objects from jsonb columns', () => {
    // Postgres jsonb columns come back already-parsed.
    expect(safeParseJSON({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
