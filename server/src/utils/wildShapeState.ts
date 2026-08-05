/**
 * Persisted Wild Shape state — the JSON stored in `characters.wild_shape`
 * (TEXT, NULL when the druid is not transformed). Every reader goes
 * through `readWildShapeColumn` so a malformed or tampered value can
 * never be silently trusted: it parses to `invalid`, and callers fail
 * closed (`!revert` is the recovery path that clears it).
 *
 * Form statistics are copied from a trusted compendium row at
 * transform time and re-validated on every read, so a value edited to
 * carry absurd numbers is rejected rather than replayed.
 */

export interface WildShapeState {
  /** compendium_monsters.slug the form came from. */
  formSlug: string;
  formName: string;
  /** Current form HP — always 1..formMaxHp while the state is active
   *  (a form at 0 HP ends atomically and the column goes NULL). */
  formHp: number;
  formMaxHp: number;
  formAc: number | null;
  formSpeed: Record<string, number>;
  formCr: number;
  /** True when the transform was made via Combat Wild Shape (Moon). */
  moon: boolean;
}

export type WildShapeColumn =
  | { status: 'none' }
  | { status: 'active'; state: WildShapeState }
  | { status: 'invalid' };

const MAX_FORM_HP = 999;
const MAX_CR = 30;
const MAX_SPEED = 500;

function asBoundedInt(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function readWildShapeColumn(raw: unknown): WildShapeColumn {
  if (raw === null || raw === undefined || raw === '') return { status: 'none' };
  if (typeof raw !== 'string') return { status: 'invalid' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid' };
  }
  if (parsed === null) return { status: 'none' };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
  const src = parsed as Record<string, unknown>;

  const formSlug = typeof src.formSlug === 'string' && src.formSlug.trim() ? src.formSlug : null;
  const formName = typeof src.formName === 'string' && src.formName.trim() ? src.formName : null;
  const formMaxHp = asBoundedInt(src.formMaxHp, 1, MAX_FORM_HP);
  const formHp = formMaxHp === null ? null : asBoundedInt(src.formHp, 1, formMaxHp);
  const formAc =
    src.formAc === null || src.formAc === undefined ? null : asBoundedInt(src.formAc, 1, 30);
  const formCr = Number(src.formCr);
  if (
    formSlug === null ||
    formName === null ||
    formMaxHp === null ||
    formHp === null ||
    (src.formAc !== null && src.formAc !== undefined && formAc === null) ||
    !Number.isFinite(formCr) ||
    formCr < 0 ||
    formCr > MAX_CR
  ) {
    return { status: 'invalid' };
  }
  const formSpeed: Record<string, number> = {};
  if (src.formSpeed !== undefined && src.formSpeed !== null) {
    if (typeof src.formSpeed !== 'object' || Array.isArray(src.formSpeed)) {
      return { status: 'invalid' };
    }
    for (const [key, value] of Object.entries(src.formSpeed as Record<string, unknown>)) {
      const speed = asBoundedInt(value, 0, MAX_SPEED);
      if (speed === null) return { status: 'invalid' };
      formSpeed[key] = speed;
    }
  }
  return {
    status: 'active',
    state: {
      formSlug,
      formName,
      formHp,
      formMaxHp,
      formAc,
      formSpeed,
      formCr,
      moon: src.moon === true,
    },
  };
}

export function serializeWildShapeState(state: WildShapeState | null): string | null {
  return state === null ? null : JSON.stringify(state);
}
