/**
 * 5e Vision and Light tier resolver.
 *
 * The companion to the visual lighting layer: tells the rest of the
 * engine *what mechanical effects apply* at a given map position
 * for a given observer. Wraps PHB p.183 + p.194-195 + p.291 plus
 * the SRD obscurement rules so attack rolls / Perception checks /
 * Stealth attempts pick up the correct advantage / disadvantage
 * automatically instead of relying on the DM remembering to tell
 * the table.
 *
 * Definitions (RAW):
 *   bright    Normal vision. No obscurement.
 *   dim       Lightly obscured. Disadvantage on Perception (sight)
 *             checks made to spot a creature in the dim area. Doesn't
 *             affect attack rolls on its own.
 *   dark      Heavily obscured = effectively blinded looking IN.
 *             Attack rolls against a creature you can't see have
 *             disadvantage; attacks from a creature that can't see
 *             you have advantage. Both apply at once → cancel.
 *
 * Senses that upgrade the perceived tier:
 *   darkvision    Within range, dim → bright and dark → dim. Sees
 *                 only in shades of grey but mechanically equivalent
 *                 to the upgraded tier.
 *   blindsight    Sees normally without relying on light at all,
 *                 within range. Ignores obscurement of any kind.
 *   truesight     Same as blindsight, plus sees through magical
 *                 darkness + invisibility + illusions.
 */

import type { Token } from '../types/map.js';
import type { AmbientLight } from '../types/map.js';

export type LightTier = 'bright' | 'dim' | 'dark';

export interface TokenSenses {
  /** Range in feet. 0 = none. */
  darkvision: number;
  blindsight: number;
  truesight: number;
  tremorsense: number;
}

/** Convert feet → grid pixels at the given grid size. */
function feetToPx(feet: number, gridSize: number): number {
  return (feet / 5) * gridSize;
}

/**
 * Determine the raw light tier (no observer senses applied) at a given
 * map position. Walks every visible light-emitting token and picks the
 * brightest tier that reaches this point. The map's ambient tier sets
 * the floor when no light source covers the spot.
 *
 * `walls` is accepted for API parity with the visibility-polygon code
 * but not used here — straight-line distance is sufficient for the
 * lighting tier check; line-of-sight blocking is handled separately
 * by the renderer's polygon clipping. We can fold walls into this if
 * sessions report dim leaking past corners.
 */
export function lightTierAt(
  x: number,
  y: number,
  ambient: AmbientLight,
  ambientOpacity: number | undefined,
  lightTokens: Token[],
): LightTier {
  // Ambient floor.
  let best: LightTier = 'dark';
  if (ambient === 'bright') best = 'bright';
  else if (ambient === 'dim') best = 'dim';
  else if (ambient === 'dark') best = 'dark';
  else if (ambient === 'custom') {
    // Custom slider — we approximate by mapping opacity bands to
    // tiers (mirrors the visual `resolveAmbient` in FogLayer):
    //   ≤ 0.25 → bright; 0.25-0.7 → dim; > 0.7 → dark.
    const a = ambientOpacity ?? 0;
    if (a <= 0.25) best = 'bright';
    else if (a <= 0.7) best = 'dim';
    else best = 'dark';
  }

  // Light sources upgrade the tier.
  for (const t of lightTokens) {
    if (!t.hasLight || !t.visible) continue;
    const dx = t.x - x;
    const dy = t.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= t.lightRadius) {
      // Within bright — can't beat bright; short-circuit.
      return 'bright';
    }
    if (dist <= t.lightDimRadius && best !== 'bright') {
      best = 'dim';
    }
  }
  return best;
}

/**
 * Apply an observer's senses to upgrade the raw tier they perceive.
 * Distance from observer to target matters for darkvision / blindsight
 * / truesight range checks.
 *
 * @param raw       The raw tier at the target's position.
 * @param senses    The observer's senses bundle.
 * @param distancePx  Distance from observer to target in pixels.
 * @param gridSize  Grid pitch (px per cell).
 */
export function effectiveVisionTier(
  raw: LightTier,
  senses: TokenSenses,
  distancePx: number,
  gridSize: number,
): LightTier {
  // Truesight + Blindsight ignore lighting entirely within their
  // range — the observer perceives the target as if in bright light.
  // Truesight goes further (sees through magical darkness, invisible,
  // illusions) but for the bright/dim/dark axis the rule is the same.
  const truesightPx = feetToPx(senses.truesight, gridSize);
  if (truesightPx > 0 && distancePx <= truesightPx) return 'bright';
  const blindsightPx = feetToPx(senses.blindsight, gridSize);
  if (blindsightPx > 0 && distancePx <= blindsightPx) return 'bright';

  // Darkvision: dim → bright, dark → dim. Outside range, no effect.
  const dvPx = feetToPx(senses.darkvision, gridSize);
  if (dvPx > 0 && distancePx <= dvPx) {
    if (raw === 'dim') return 'bright';
    if (raw === 'dark') return 'dim';
  }
  return raw;
}

/**
 * Can `observer` see `target` clearly enough to attack without the
 * heavily-obscured penalty? In RAW terms: is the observer's effective
 * tier looking at the target NOT 'dark'?
 *
 * Note that lightly obscured (dim) does NOT prevent attacks in 5e —
 * it only imposes disadvantage on Perception checks. So this returns
 * true for both bright and dim; only dark blocks visibility.
 */
export function canSeeTarget(
  observer: { x: number; y: number; senses: TokenSenses },
  target: { x: number; y: number },
  ambient: AmbientLight,
  ambientOpacity: number | undefined,
  lightTokens: Token[],
  gridSize: number,
): boolean {
  const rawAtTarget = lightTierAt(target.x, target.y, ambient, ambientOpacity, lightTokens);
  const dx = target.x - observer.x;
  const dy = target.y - observer.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const fromObserver = effectiveVisionTier(rawAtTarget, observer.senses, dist, gridSize);
  return fromObserver !== 'dark';
}

/**
 * Compute attack-roll modifiers from the 5e RAW "you can't see"
 * cause. Returns `'advantage'` / `'disadvantage'` / `'normal'` plus
 * a human-readable note for the chat card.
 *
 * RAW (PHB p.194-195):
 *   - Attacker can't see target  → disadvantage on attack roll
 *   - Target can't see attacker  → advantage on attacker's attack
 *     roll (target is effectively a "hidden" target's reverse case)
 *   - Both apply  → cancel (general advantage/disadvantage rule).
 */
export function visionAttackModifier(
  attacker: { x: number; y: number; senses: TokenSenses },
  target: { x: number; y: number; senses: TokenSenses },
  ambient: AmbientLight,
  ambientOpacity: number | undefined,
  lightTokens: Token[],
  gridSize: number,
): { advantage: 'advantage' | 'disadvantage' | 'normal'; note: string | null } {
  const aSeesT = canSeeTarget(attacker, target, ambient, ambientOpacity, lightTokens, gridSize);
  const tSeesA = canSeeTarget(target, attacker, ambient, ambientOpacity, lightTokens, gridSize);

  if (aSeesT && tSeesA) return { advantage: 'normal', note: null };
  if (!aSeesT && !tSeesA) {
    return {
      advantage: 'normal',
      note: 'Both blind to each other (heavily obscured) — advantage + disadvantage cancel',
    };
  }
  if (!aSeesT) {
    return {
      advantage: 'disadvantage',
      note: 'Target heavily obscured (dark / no darkvision) → disadvantage on attack',
    };
  }
  // !tSeesA
  return {
    advantage: 'advantage',
    note: 'Attacker hidden in heavy obscurement → advantage on attack',
  };
}

/**
 * Whether a Perception (sight) check looking AT the given position
 * has disadvantage from obscurement. Dim = lightly obscured =
 * disadvantage on Perception (sight) per RAW. Dark = heavily
 * obscured = effectively blinded; calling code may want to fail the
 * check outright instead of just imposing disadvantage.
 */
export function perceptionPenalty(
  tierFromObserver: LightTier,
): 'normal' | 'disadvantage' | 'auto-fail' {
  if (tierFromObserver === 'bright') return 'normal';
  if (tierFromObserver === 'dim') return 'disadvantage';
  return 'auto-fail';
}
