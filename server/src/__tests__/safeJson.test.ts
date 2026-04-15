import { describe, it, expect, vi } from 'vitest';
import { safeParseJSON } from '../utils/safeJson.js';

describe('safeParseJSON', () => {
  it('parses a valid JSON string', () => {
    expect(safeParseJSON('[1,2,3]', [])).toEqual([1, 2, 3]);
    expect(safeParseJSON<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it('passes through already-parsed values (jsonb columns)', () => {
    const obj = { a: 1, b: [2] };
    expect(safeParseJSON(obj, null)).toBe(obj);
  });

  it('returns the fallback for null / undefined', () => {
    expect(safeParseJSON(null, [])).toEqual([]);
    expect(safeParseJSON(undefined, { x: 1 })).toEqual({ x: 1 });
  });

  it('returns the fallback for malformed JSON, logs the tag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = safeParseJSON<number[]>('[not-json', [], 'map.fog_state');
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    const msg = (warn.mock.calls[0] ?? []).join(' ');
    expect(msg).toContain('map.fog_state');
    warn.mockRestore();
  });

  it('handles corrupt JSON (empty object prepared statement artefact)', () => {
    const result = safeParseJSON('', [], 'features');
    expect(result).toEqual([]);
  });

  it('never throws — that\'s the whole point', () => {
    // Each of these has tripped up naive JSON.parse at some point in
    // the field. A crash inside a socket handler bubbles up to a 500
    // and takes the whole room's state with it; safeParseJSON must
    // never re-throw regardless of input shape.
    expect(() => safeParseJSON('{', [])).not.toThrow();
    expect(() => safeParseJSON('{"unterminated', null)).not.toThrow();
    expect(() => safeParseJSON('\x00\x01', null)).not.toThrow();
    expect(() => safeParseJSON(123 as unknown as string, [])).not.toThrow();
  });
});
