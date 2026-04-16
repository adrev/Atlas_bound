/**
 * JSON.parse() is unforgiving — any malformed string (from a corrupt
 * DB row, a partial write, or a schema drift) throws and crashes the
 * handler it runs in. For payloads that are data, not code, we almost
 * always prefer a fallback (empty array, empty object) over a 500.
 *
 * Use `safeParseJSON` whenever the source is a database column, a
 * file on disk, or anything else you don't fully control. Logs the
 * failure with a tag so bad rows are traceable.
 *
 * ```ts
 * const fog = safeParseJSON<FogPolygon[]>(rows[0].fog_state, [], 'map.fog_state');
 * ```
 */
export function safeParseJSON<T>(raw: unknown, fallback: T, tag?: string): T {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') {
    // Postgres `json`/`jsonb` columns come back already parsed. Accept.
    return raw as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(
      `[safeParseJSON] Failed to parse${tag ? ` ${tag}` : ''}:`,
      err instanceof Error ? err.message : err,
      '— raw preview:', raw.slice(0, 80),
    );
    return fallback;
  }
}
