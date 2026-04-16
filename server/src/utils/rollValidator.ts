import type { ParsedRoll } from '@dnd-vtt/shared';

/**
 * Validate a client-reported roll against the notation it claims to
 * have rolled. Used by chat:roll to decide whether to trust the 3D
 * dice's payload or fall back to a server-authoritative re-roll.
 *
 * The client SHOULD send:
 *   - the notation (e.g. "2d6+3")
 *   - one entry in `dice` per physical die rolled, with `type` =
 *     number of sides and `value` = face result
 *   - the claimed `total`
 *
 * We insist that:
 *   1. the parser actually understood the notation (so we have a
 *      ground-truth dice+modifier breakdown to compare against)
 *   2. every reported die is within [1, sides]
 *   3. the multiset of reported (sides, count) matches the notation's
 *      declared dice bag, with signs collapsed to absolute counts
 *      (we don't care whether the client labelled dice as positive or
 *      negative — the server owns the sign via the notation's parse)
 *   4. sum(signed_dice) + modifier === reported_total
 *
 * On any failure we return false; the caller re-rolls server-side.
 */
export type ReportedRoll = {
  dice: Array<{ type: number; value: number }>;
  total: number;
};

export function validateReportedRoll(
  parsed: ParsedRoll | null,
  reported: ReportedRoll,
): boolean {
  if (!parsed) return false;

  // (2) face-count sanity
  for (const d of reported.dice) {
    if (!Number.isFinite(d.type) || !Number.isFinite(d.value)) return false;
    if (d.type < 2) return false;
    if (d.value < 1 || d.value > d.type) return false;
  }

  // (3) dice-bag match — count how many dice of each `sides` the
  // notation declared vs how many the client reported.
  const expected = new Map<number, number>();
  for (const d of parsed.dice) {
    expected.set(d.sides, (expected.get(d.sides) ?? 0) + Math.abs(d.count));
  }
  const actual = new Map<number, number>();
  for (const d of reported.dice) {
    actual.set(d.type, (actual.get(d.type) ?? 0) + 1);
  }
  if (expected.size !== actual.size) return false;
  for (const [sides, count] of expected) {
    if (actual.get(sides) !== count) return false;
  }

  // (4) total matches sum(signed dice) + notation modifier.
  //
  // If the notation has mixed signs for the same sides (e.g. `2d6-1d6`)
  // we can't tell which reported die goes on which side. Accept the
  // total iff the reported sum falls inside the valid envelope of
  // sum(signed-dice) + modifier for ALL sign assignments — in
  // practice just by checking the sum against the single contiguous
  // range [min_total, max_total] bounded by the notation's parse. For
  // the common case of all-positive dice this collapses to exact
  // equality, which is what we want.
  //
  // Cheap implementation: rebuild the total from the reported dice
  // using the notation's sign for that die-sides bucket. If the bucket
  // has mixed signs we can't recover the arrangement, so fall back to
  // a range check.
  const signBySides = new Map<number, number | 'mixed'>();
  for (const d of parsed.dice) {
    const existing = signBySides.get(d.sides);
    const thisSign = d.count < 0 ? -1 : 1;
    if (existing === undefined) {
      signBySides.set(d.sides, thisSign);
    } else if (existing !== thisSign) {
      signBySides.set(d.sides, 'mixed');
    }
  }

  const hasMixed = [...signBySides.values()].includes('mixed');
  if (!hasMixed) {
    let expectedTotal = parsed.modifier;
    for (const d of reported.dice) {
      const sign = signBySides.get(d.type) as number;
      expectedTotal += d.value * sign;
    }
    return expectedTotal === reported.total;
  }

  // Mixed-sign fallback: the reported total must be within the
  // min/max envelope the notation allows.
  let minTotal = parsed.modifier;
  let maxTotal = parsed.modifier;
  for (const d of parsed.dice) {
    const c = Math.abs(d.count);
    if (d.count >= 0) {
      minTotal += c * 1;
      maxTotal += c * d.sides;
    } else {
      minTotal -= c * d.sides;
      maxTotal -= c * 1;
    }
  }
  return reported.total >= minTotal && reported.total <= maxTotal;
}
