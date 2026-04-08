import type { Token } from '@dnd-vtt/shared';
import { getRoom } from '../utils/roomState.js';
import db from '../db/connection.js';

/**
 * Opportunity Attack detection + execution.
 *
 * Per D&D 5e: when a hostile creature you can see moves out of your
 * reach (normally 5 ft, 10 ft with Reach weapons) you can use your
 * Reaction to make one melee attack against it. The mover can avoid
 * this by taking the Disengage action, and certain conditions
 * (Incapacitated / Paralyzed / Stunned / Unconscious / Petrified /
 * Prone) prevent the reaction.
 */

export interface OAOpportunity {
  attackerTokenId: string;
  attackerName: string;
  attackerOwnerUserId: string | null;
  moverTokenId: string;
  moverName: string;
}

const CONDITIONS_THAT_PREVENT_OA = new Set([
  'incapacitated',
  'paralyzed',
  'stunned',
  'unconscious',
  'petrified',
  'prone',       // Prone creatures can't make opportunity attacks (they'd need to stand up first)
  'grappled',    // Can move but attack rolls are not prevented — actually OA still works. Remove if incorrect.
]);

/**
 * Given a token's OLD and NEW position, find every enemy that had
 * the token in its melee reach at the old position but NOT at the new
 * position, AND has a valid reaction to spend. Each returned entry is
 * a candidate for an Opportunity Attack prompt.
 */
export function detectOpportunityAttacks(
  sessionId: string,
  moverTokenId: string,
  oldX: number,
  oldY: number,
  newX: number,
  newY: number,
): OAOpportunity[] {
  const room = getRoom(sessionId);
  if (!room) {
    console.log('[OA] no room');
    return [];
  }
  const mover = room.tokens.get(moverTokenId);
  if (!mover) {
    console.log('[OA] no mover token', moverTokenId);
    return [];
  }

  // Must be in combat for reaction tracking to mean anything.
  if (!room.combatState || !room.combatState.active) {
    console.log('[OA] not in combat');
    return [];
  }

  // Mover with Disengaged / Invisible doesn't provoke (Disengaged
  // exempts from all OAs; Invisible targets can't be targeted by an
  // OA unless the attacker can see through invisibility — we
  // conservatively skip).
  const moverConditions = new Set((mover.conditions || []) as string[]);
  if (moverConditions.has('disengaged')) {
    console.log('[OA] mover', mover.name, 'is Disengaged — no OA');
    return [];
  }
  if (moverConditions.has('invisible') && !moverConditions.has('outlined')) {
    console.log('[OA] mover', mover.name, 'is Invisible — no OA');
    return [];
  }

  const gridSize = getGridSize(sessionId);
  if (!gridSize) {
    console.log('[OA] no grid size');
    return [];
  }

  console.log(`[OA] checking — mover=${mover.name} (owner=${mover.ownerUserId ?? 'NPC'}) from (${oldX},${oldY}) → (${newX},${newY}), gridSize=${gridSize}`);

  const opportunities: OAOpportunity[] = [];

  for (const enemy of room.tokens.values()) {
    if (enemy.id === moverTokenId) continue;
    if (!enemy.visible) continue;

    // Skip friendlies: any token-owned token vs unowned token = different sides.
    if (sameSide(enemy, mover)) {
      // console.log(`[OA] skip ${enemy.name}: same side as ${mover.name}`);
      continue;
    }

    // Skip attackers whose conditions prevent them from taking a
    // reaction at all.
    const attackerConds = new Set((enemy.conditions || []) as string[]);
    let prevented: string | null = null;
    for (const cond of CONDITIONS_THAT_PREVENT_OA) {
      if (attackerConds.has(cond)) { prevented = cond; break; }
    }
    if (prevented) {
      console.log(`[OA] skip ${enemy.name}: has condition ${prevented}`);
      continue;
    }

    // Skip attackers who have already spent their reaction this round.
    const economy = room.actionEconomies.get(enemy.id);
    if (economy?.reaction) {
      console.log(`[OA] skip ${enemy.name}: reaction already spent`);
      continue;
    }

    // Skip attackers with no melee attack at all (very rare now —
    // findBestMeleeAttack falls back to unarmed strike).
    const meleeAttack = findBestMeleeAttack(enemy);
    if (!meleeAttack) {
      console.log(`[OA] skip ${enemy.name}: no melee attack found`);
      continue;
    }

    // Distance check: was within reach, is no longer.
    // Reach defaults to 1 square (5 ft). A Reach weapon gives 2.
    const reachCells = meleeReachCells(enemy);
    const reachPx = reachCells * gridSize;

    const wasDist = edgeDistance(
      enemy.x, enemy.y, (enemy.size as number) || 1,
      oldX, oldY, (mover.size as number) || 1,
      gridSize,
    );
    const isDist = edgeDistance(
      enemy.x, enemy.y, (enemy.size as number) || 1,
      newX, newY, (mover.size as number) || 1,
      gridSize,
    );
    const wasInReach = wasDist <= reachPx + 0.5;
    const isInReach = isDist <= reachPx + 0.5;

    console.log(`[OA] candidate ${enemy.name} (owner=${enemy.ownerUserId ?? 'NPC'}): reachPx=${reachPx} wasDist=${wasDist.toFixed(1)} (${wasInReach ? 'IN' : 'out'}) → isDist=${isDist.toFixed(1)} (${isInReach ? 'IN' : 'out'})`);

    if (wasInReach && !isInReach) {
      console.log(`[OA] ✅ ${enemy.name} gets an OA opportunity on ${mover.name}`);
      opportunities.push({
        attackerTokenId: enemy.id,
        attackerName: enemy.name,
        attackerOwnerUserId: enemy.ownerUserId,
        moverTokenId,
        moverName: mover.name,
      });
    }
  }

  console.log(`[OA] result: ${opportunities.length} opportunities`);
  return opportunities;
}

/**
 * Resolve an Opportunity Attack: roll the attacker's best melee
 * attack against the mover, apply damage, and consume the attacker's
 * reaction slot. Returns a structured result the caller broadcasts.
 */
export interface OAExecutionResult {
  success: boolean;
  /** Chat-friendly summary lines for the combat log. */
  messages: string[];
  /** Updated HP if damage was applied. */
  hpChange?: { tokenId: string; hp: number; tempHp: number };
  /** The mover's character id if we updated their HP in the DB. */
  characterHpUpdated?: { characterId: string; hp: number };
}

export function executeOpportunityAttack(
  sessionId: string,
  attackerTokenId: string,
  moverTokenId: string,
): OAExecutionResult {
  const room = getRoom(sessionId);
  if (!room) return { success: false, messages: ['No room'] };
  const attacker = room.tokens.get(attackerTokenId);
  const mover = room.tokens.get(moverTokenId);
  if (!attacker || !mover) return { success: false, messages: ['Missing token'] };
  // Everything below uses the `room` handle we already have — no
  // additional getRoom calls required.

  // Re-check the reaction slot — the attacker could have used it
  // between the prompt and the click.
  const economy = room.actionEconomies.get(attacker.id);
  if (economy?.reaction) {
    return { success: false, messages: [`⚠ ${attacker.name} has already spent their reaction.`] };
  }

  const attack = findBestMeleeAttack(attacker);
  if (!attack) return { success: false, messages: [`⚠ ${attacker.name} has no melee attack available.`] };

  // Roll d20 + attack bonus. Crit on 20, fumble on 1. Advantage from
  // the target being Prone in melee reach, disadvantage from attacker
  // Blinded / Poisoned / Frightened / Restrained.
  const moverConds = (mover.conditions || []) as string[];
  const attackerConds = (attacker.conditions || []) as string[];
  let adv = 'normal' as 'advantage' | 'disadvantage' | 'normal';
  if (moverConds.includes('prone')) adv = 'advantage';
  if (
    attackerConds.includes('poisoned') ||
    attackerConds.includes('frightened') ||
    attackerConds.includes('blinded') ||
    attackerConds.includes('restrained') ||
    attackerConds.includes('prone')
  ) {
    adv = adv === 'advantage' ? 'normal' : 'disadvantage';
  }

  const r1 = Math.floor(Math.random() * 20) + 1;
  const r2 = Math.floor(Math.random() * 20) + 1;
  const kept = adv === 'advantage' ? Math.max(r1, r2)
    : adv === 'disadvantage' ? Math.min(r1, r2)
    : r1;
  const advTag = adv === 'advantage' ? ' (adv)' : adv === 'disadvantage' ? ' (disadv)' : '';
  const isCrit = kept === 20;
  const isFumble = kept === 1;
  const total = kept + attack.attackBonus;

  // Read the mover's effective AC — prefer the combatant snapshot
  // (which reflects the current combat state), fall back to the
  // character row's armor_class, else 10.
  let moverAC = 10;
  {
    const combatant = room.combatState?.combatants.find((c) => c.tokenId === moverTokenId);
    if (combatant) {
      moverAC = combatant.armorClass;
    } else if (mover.characterId) {
      const row = db.prepare('SELECT armor_class FROM characters WHERE id = ?').get(mover.characterId) as { armor_class: number } | undefined;
      if (row) moverAC = row.armor_class;
    }
  }
  const hit = isCrit || (!isFumble && total >= moverAC);

  const messages: string[] = [];
  const rollStr = adv !== 'normal' ? `[${r1},${r2}]` : `${kept}`;
  const modStr = attack.attackBonus >= 0 ? `+${attack.attackBonus}` : `${attack.attackBonus}`;
  const header = `⚡ ${attacker.name} makes an Opportunity Attack (${attack.name}) on ${mover.name}`;
  const rollLine = `   d20=${rollStr}${advTag}${modStr}=${total} vs AC ${moverAC} → ${
    isCrit ? '💥 CRIT' : hit ? '✓ HIT' : isFumble ? '✗ FUMBLE' : '✗ MISS'
  }`;

  messages.push(header);
  messages.push(rollLine);

  // Always consume the reaction, even on miss.
  let eco = room.actionEconomies.get(attacker.id);
  if (!eco) {
    eco = {
      action: false,
      bonusAction: false,
      movementRemaining: (attacker as any).speed ?? 30,
      movementMax: (attacker as any).speed ?? 30,
      reaction: false,
    };
    room.actionEconomies.set(attacker.id, eco);
  }
  eco.reaction = true;

  const result: OAExecutionResult = { success: true, messages };

  if (hit) {
    // Roll damage. Crit doubles the dice (not the modifier).
    const rolledDamage = rollDamageString(attack.damageDice, isCrit);
    const damage = Math.max(0, rolledDamage);

    // Apply to combatant HP if present, else character HP, else just log.
    let newHp: number | null = null;
    const combatant = room.combatState?.combatants.find((c) => c.tokenId === moverTokenId);
    if (combatant) {
      combatant.hp = Math.max(0, combatant.hp - damage);
      newHp = combatant.hp;
    }
    if (mover.characterId) {
      const row = db.prepare('SELECT hit_points FROM characters WHERE id = ?').get(mover.characterId) as { hit_points: number } | undefined;
      if (row) {
        const updatedHp = Math.max(0, row.hit_points - damage);
        db.prepare('UPDATE characters SET hit_points = ? WHERE id = ?').run(updatedHp, mover.characterId);
        if (newHp === null) newHp = updatedHp;
        result.characterHpUpdated = { characterId: mover.characterId, hp: updatedHp };
      }
    }

    const dmgTypeWord = attack.damageType ? ` ${attack.damageType}` : '';
    messages.push(`   ${damage}${dmgTypeWord} damage${isCrit ? ' [CRIT]' : ''}`);
    if (newHp !== null) {
      messages.push(`   ${mover.name} HP → ${newHp}`);
      result.hpChange = { tokenId: moverTokenId, hp: newHp, tempHp: combatant?.tempHp ?? 0 };
      if (newHp <= 0) messages.push(`   💀 ${mover.name} is DOWN`);
    }
  }

  return result;
}

// ─── helpers ─────────────────────────────────────────────────────

function getGridSize(sessionId: string): number | null {
  const room = getRoom(sessionId);
  if (!room?.currentMapId) return null;
  const row = db.prepare('SELECT grid_size FROM maps WHERE id = ?').get(room.currentMapId) as { grid_size: number } | undefined;
  return row?.grid_size ?? 70;
}

function sameSide(a: Token, b: Token): boolean {
  // Two-team model: any player-owned token is on the "PC team",
  // any unowned token is on the "NPC team". This prevents the
  // false-positive where Player A walking past Player B in a
  // multi-PC party would trigger an Opportunity Attack from B
  // (they're allies, not hostile creatures).
  const aIsPC = !!a.ownerUserId;
  const bIsPC = !!b.ownerUserId;
  return aIsPC === bIsPC;
}

/**
 * Chebyshev edge-to-edge distance in pixels on the grid. This matches
 * the D&D 5e "reach is 5 ft" rule where diagonal movement still costs
 * 5 ft per square.
 */
function edgeDistance(
  ax: number, ay: number, aSize: number,
  bx: number, by: number, bSize: number,
  gridSize: number,
): number {
  const acx = ax + (gridSize * aSize) / 2;
  const acy = ay + (gridSize * aSize) / 2;
  const bcx = bx + (gridSize * bSize) / 2;
  const bcy = by + (gridSize * bSize) / 2;
  const dx = Math.abs(acx - bcx) - (aSize * gridSize) / 2 - (bSize * gridSize) / 2;
  const dy = Math.abs(acy - bcy) - (aSize * gridSize) / 2 - (bSize * gridSize) / 2;
  return Math.max(Math.max(dx, 0), Math.max(dy, 0));
}

/** How many grid cells the attacker's best melee weapon can reach. */
function meleeReachCells(attacker: Token): number {
  const atk = findBestMeleeAttack(attacker);
  if (!atk) return 1;
  // Reach weapons (pike, glaive, halberd, whip) get 2 squares (10 ft)
  if (atk.properties?.some((p) => /reach/i.test(p))) return 2;
  return 1;
}

interface ResolvedMeleeAttack {
  name: string;
  attackBonus: number;
  damageDice: string;
  damageType: string | null;
  properties: string[];
}

/**
 * Find the attacker's best melee weapon for an OA. Looks at:
 *   • Character inventory (for player characters) — equipped melee weapons
 *   • Compendium actions (for creatures)
 * Returns the first one that looks like a melee attack.
 */
function findBestMeleeAttack(token: Token): ResolvedMeleeAttack | null {
  let strMod = 0;
  let dexMod = 0;
  let profBonus = 2;
  let abilitiesLoaded = false;

  // 1. Try the character's equipped melee weapons if they have a char record.
  if (token.characterId) {
    const row = db.prepare('SELECT inventory, ability_scores, proficiency_bonus FROM characters WHERE id = ?').get(token.characterId) as Record<string, unknown> | undefined;
    if (row) {
      try {
        const abilities = JSON.parse((row.ability_scores as string) || '{}') as Record<string, number>;
        profBonus = (row.proficiency_bonus as number) || 2;
        strMod = Math.floor(((abilities.str ?? abilities.strength ?? 10) - 10) / 2);
        dexMod = Math.floor(((abilities.dex ?? abilities.dexterity ?? 10) - 10) / 2);
        abilitiesLoaded = true;

        const inv = JSON.parse((row.inventory as string) || '[]') as any[];
        // Be lenient on the equipped flag — many imported characters
        // don't set `equipped: true` even when the weapon is in their
        // active loadout. Treat any melee weapon in inventory as
        // available for OA. Pick the weapon with the highest EXPECTED
        // attack roll for THIS character (so a Finesse dagger beats
        // a non-finesse 2d12 club for a low-STR/high-DEX caster), and
        // tiebreak by damage die size.
        const meleeWeapons = inv.filter((i) => {
          const type = String(i?.type || i?.category || '').toLowerCase();
          if (type !== 'weapon') return false;
          const props = ((i.properties || []) as string[]).map((p) => String(p).toLowerCase());
          // Exclude obvious ranged-only weapons.
          if (props.some((p) => p === 'ammunition' || p === 'ranged')) return false;
          return true;
        });

        // Score each candidate. Higher = better.
        const scoreWeapon = (w: any) => {
          const props = ((w.properties || []) as string[]).map((p: string) => String(p).toLowerCase());
          const isFinesse = props.includes('finesse');
          const abMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
          const atkBonus = abMod + profBonus + (w.magicBonus ?? 0);
          const dieSize = parseInt(String(w.damage || '1d4').match(/d(\d+)/)?.[1] || '4', 10);
          return {
            equippedScore: w.equipped ? 1 : 0,
            atkBonus,
            dieSize,
          };
        };

        meleeWeapons.sort((a, b) => {
          const sa = scoreWeapon(a);
          const sb = scoreWeapon(b);
          // 1) Equipped wins
          if (sa.equippedScore !== sb.equippedScore) return sb.equippedScore - sa.equippedScore;
          // 2) Higher attack bonus wins (so a Finesse dagger beats a
          //    non-finesse 2d12 weapon for a high-DEX / low-STR caster)
          if (sa.atkBonus !== sb.atkBonus) return sb.atkBonus - sa.atkBonus;
          // 3) Tiebreak: larger damage die
          return sb.dieSize - sa.dieSize;
        });

        if (meleeWeapons.length > 0) {
          const w = meleeWeapons[0];
          const props: string[] = w.properties || [];
          const isFinesse = props.some((p: string) => /finesse/i.test(String(p)));
          const abMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
          const attackBonus = abMod + profBonus + (w.magicBonus ?? 0);
          // Strip any pre-existing modifier off w.damage so we don't
          // double up.
          const baseRaw = String(w.damage || '1d4');
          const baseMatch = baseRaw.match(/^\s*(\d+d\d+)/);
          const baseDice = baseMatch ? baseMatch[1] : '1d4';
          const dmgDice = `${baseDice}${abMod >= 0 ? `+${abMod}` : abMod}`;
          return {
            name: w.name,
            attackBonus,
            damageDice: dmgDice,
            damageType: (w.damageType ?? null) as string | null,
            properties: props,
          };
        }
      } catch (err) {
        console.warn('[OA] inventory parse failed for', token.name, err);
      }
    }
  }

  // 2. Try the compendium actions for creatures.
  if (token.characterId) {
    const row = db.prepare('SELECT extras FROM characters WHERE id = ?').get(token.characterId) as Record<string, unknown> | undefined;
    if (row?.extras) {
      try {
        const extras = typeof row.extras === 'string' ? JSON.parse(row.extras) : row.extras;
        const actions = (extras?.actions ?? []) as any[];
        for (const action of actions) {
          const desc = (action.desc || action.description || '').toLowerCase();
          if (/melee weapon attack/i.test(desc) || /melee attack/i.test(desc)) {
            const attackBonus = (action.attack_bonus as number) ?? 0;
            const damageDice = (action.damage_dice as string) || action.damage || '1d4';
            let damageType: string | null = null;
            const m = desc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(\w+)\s+damage/);
            if (m) damageType = m[2];
            return {
              name: action.name || 'Melee Attack',
              attackBonus,
              damageDice,
              damageType,
              properties: [],
            };
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 3. Fallback: unarmed strike. Per RAW you can take an OA with an
  // unarmed strike if you have no melee weapon. We use STR for the
  // attack and damage so the player still gets a real swing instead
  // of being silently denied the OA opportunity. If we couldn't even
  // load abilities (no character row), default to flat +0.
  return {
    name: 'Unarmed Strike',
    attackBonus: abilitiesLoaded ? strMod + profBonus : 0,
    damageDice: abilitiesLoaded ? `1+${Math.max(0, strMod)}` : '1',
    damageType: 'bludgeoning',
    properties: [],
  };
}

/**
 * Roll a damage dice string and return the sum. Supports the
 * compendium's slightly messy formats:
 *   • "1d8+3"  (single dice term + flat mod)
 *   • "2d6"
 *   • "1d6+1d4+2" (multiple dice terms — Hex / Hunter's Mark)
 *   • "5"     (flat number — unarmed default)
 *
 * If `isCrit` is true, double EVERY dice term's count (not the flat mod).
 */
function rollDamageString(notation: string, isCrit: boolean): number {
  if (!notation) return 0;
  // Strip whitespace
  const cleaned = notation.replace(/\s+/g, '');
  // Tokenize: any "[+-]?\d*d\d+" or "[+-]?\d+" pieces.
  // First normalize to start with a sign so the regex catches the
  // leading term too.
  const normalized = /^[+-]/.test(cleaned) ? cleaned : `+${cleaned}`;
  const tokens = normalized.match(/[+-]\d*d\d+|[+-]\d+/g) ?? [];
  let total = 0;
  for (const tok of tokens) {
    const sign = tok[0] === '-' ? -1 : 1;
    const body = tok.slice(1);
    const m = body.match(/^(\d*)d(\d+)$/);
    if (m) {
      let count = parseInt(m[1] || '1', 10);
      const sides = parseInt(m[2], 10);
      if (isCrit) count *= 2;
      let sum = 0;
      for (let i = 0; i < count; i++) sum += Math.floor(Math.random() * sides) + 1;
      total += sign * sum;
    } else {
      const n = parseInt(body, 10);
      if (Number.isFinite(n)) total += sign * n;
    }
  }
  return total;
}
