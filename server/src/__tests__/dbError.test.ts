import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';
import { handleDbError } from '../utils/dbError.js';

// Pins the Postgres-error → HTTP-status mapping behind the customContent
// create routes (T1.7). A constraint violation is the caller's fault, so it
// should surface as an actionable 4xx, not a blanket 500.

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDbError — Postgres code → HTTP status', () => {
  const cases: Array<[string, number, RegExp]> = [
    ['23505', 409, /already exists/i],   // unique_violation
    ['23503', 400, /does not exist/i],   // foreign_key_violation
    ['23502', 400, /required field/i],   // not_null_violation
    ['22P02', 400, /invalid input/i],    // invalid_text_representation
  ];

  for (const [code, expectedStatus, msgPattern] of cases) {
    it(`maps ${code} → ${expectedStatus}`, () => {
      const { res, status, json } = mockRes();
      handleDbError({ code }, res, 'Failed to create monster');
      expect(status).toHaveBeenCalledWith(expectedStatus);
      expect(json.mock.calls[0][0].error).toMatch(msgPattern);
    });
  }

  it('falls back to 500 with the default message for unknown / non-PG errors', () => {
    const { res, status, json } = mockRes();
    handleDbError(new Error('boom'), res, 'Failed to create spell');
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'Failed to create spell' });
  });

  it('logs the underlying error context instead of swallowing it', () => {
    const { res } = mockRes();
    handleDbError({ code: '23505', constraint: 'custom_monsters_slug_key' }, res, 'Failed to create monster', 'customContent');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0];
    expect(String(logged[0])).toContain('customContent');
    expect(logged[1]).toMatchObject({ code: '23505', constraint: 'custom_monsters_slug_key' });
  });
});
