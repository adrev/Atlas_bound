import type { Response } from 'express';

/**
 * Map a Postgres error to an actionable HTTP response instead of a blanket
 * 500. A failed INSERT is usually the caller's fault (duplicate, bad FK,
 * missing required field) — returning 4xx with a clear message lets the
 * client fix the input, and logging the real error (code + constraint)
 * keeps a generic 500 from blinding us in prod.
 *
 * `context` is a short label for the log line (e.g. the route/action).
 * `defaultMsg` is the user-facing message for genuine server errors.
 */
export function handleDbError(
  err: unknown,
  res: Response,
  defaultMsg: string,
  context = 'db',
): void {
  const pgErr = err as { code?: string; constraint?: string; message?: string; detail?: string };
  console.error(`[${context}] ${defaultMsg}:`, {
    code: pgErr?.code,
    constraint: pgErr?.constraint,
    message: pgErr?.message,
    detail: pgErr?.detail,
  });
  switch (pgErr?.code) {
    case '23505': // unique_violation
      res.status(409).json({ error: 'A record with these details already exists' });
      return;
    case '23503': // foreign_key_violation
      res.status(400).json({ error: 'Referenced session or resource does not exist' });
      return;
    case '23502': // not_null_violation
      res.status(400).json({ error: 'A required field is missing' });
      return;
    case '22P02': // invalid_text_representation
      res.status(400).json({ error: 'Invalid input format' });
      return;
    default:
      res.status(500).json({ error: defaultMsg });
  }
}
