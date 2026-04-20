import type { Token } from '@dnd-vtt/shared';
import { getRoom } from '../utils/roomState.js';
import pool from '../db/connection.js';

export interface OAOpportunity {
  attackerTokenId: string;
  attackerName: string;
  attackerOwnerUserId: string | null;
  moverTokenId: string;
  moverName: string;
}

const CONDITIONS_THAT_PREVENT_OA = new Set([
  'incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified', 'prone', 'grappled',
]);

/**
 * Inventory item shape that OA cares about. We only read a handful
 * of fields (name, type, properties, damage, equipped, magicBonus),
 * so a narrow structural type is enough.
 */
interface InventoryWeapon {
  name?: string;
  type?: string;
  category?: string;
  properties?: string[];
  damage?: string;
  damageType?: string | null;
  equipped?: boolean;
  magicBonus?: number;
}

export function detectOpportunityAttacks(
  sessionId: string, moverTokenId: string,
  oldX: number, oldY: number, newX: number, newY: number,
): OAOpportunity[] {
  const room = getRoom(sessionId);
  if (!room) return [];
  const mover = room.tokens.get(moverTokenId);
  if (!mover) return [];
  if (!room.combatState || !room.combatState.active) return [];

  const moverConditions = new Set((mover.conditions || []) as string[]);
  if (moverConditions.has('disengaged')) return [];
  if (moverConditions.has('invisible') && !moverConditions.has('outlined')) return [];

  const gridSize = getGridSize(sessionId);
  if (!gridSize) return [];

  const opportunities: OAOpportunity[] = [];

  for (const enemy of room.tokens.values()) {
    if (enemy.id === moverTokenId) continue;
    if (!enemy.visible) continue;
    if (!isHostileTo(enemy, mover)) continue;

    const attackerConds = new Set((enemy.conditions || []) as string[]);
    let prevented: string | null = null;
    for (const cond of CONDITIONS_THAT_PREVENT_OA) {
      if (attackerConds.has(cond)) { prevented = cond; break; }
    }
    if (prevented) continue;

    const economy = room.actionEconomies.get(enemy.id);
    if (economy?.reaction) continue;

    const meleeAttack = findBestMeleeAttackSync(enemy);
    if (!meleeAttack) continue;

    // Mobile feat: skip OA from any creature the mover has melee-
    // attacked this turn. Populated by the combat:mobile-targeted
    // event earlier in the turn.
    if (room.mobileMeleeTargets.get(moverTokenId)?.has(enemy.id)) continue;

    const reachCells = meleeReachCells(sessionId, enemy);
    const reachPx = reachCells * gridSize;

    const wasDist = edgeDistance(enemy.x, enemy.y, (enemy.size as number) || 1, oldX, oldY, (mover.size as number) || 1, gridSize);
    const isDist = edgeDistance(enemy.x, enemy.y, (enemy.size as number) || 1, newX, newY, (mover.size as number) || 1, gridSize);
    const wasInReach = wasDist <= reachPx + 0.5;
    const isInReach = isDist <= reachPx + 0.5;

    if (wasInReach && !isInReach) {
      opportunities.push({
        attackerTokenId: enemy.id, attackerName: enemy.name,
        attackerOwnerUserId: enemy.ownerUserId, moverTokenId, moverName: mover.name,
      });
    } else if (!wasInReach && isInReach && room.polearmMasters.has(enemy.id)) {
      // Polearm Master: "While you are wielding a glaive, halberd,
      // pike, quarterstaff, or spear, other creatures provoke an
      // opportunity attack from you when they enter your reach."
      opportunities.push({
        attackerTokenId: enemy.id, attackerName: enemy.name,
        attackerOwnerUserId: enemy.ownerUserId, moverTokenId, moverName: mover.name,
      });
    }
  }

  return opportunities;
}

/**
 * Static-trigger opportunity attack detection. Unlike movement-based
 * OAs, this fires when the caster performs an action that provokes
 * (e.g. casting a spell while adjacent to a hostile melee combatant).
 *
 * A potential attacker is every token in the room that:
 *   • Is on a different side (different ownerUserId bucket),
 *   • Is visible,
 *   • Has no OA-preventing condition,
 *   • Has not already spent its reaction this round,
 *   • Is within melee reach of the caster.
 *
 * Mirrors the filters in `detectOpportunityAttacks` but without the
 * "was in reach, now isn't" distance delta — the caster hasn't moved.
 */
export function detectSpellCastingOA(
  sessionId: string,
  casterTokenId: string,
): OAOpportunity[] {
  const room = getRoom(sessionId);
  if (!room) return [];
  const caster = room.tokens.get(casterTokenId);
  if (!caster) return [];
  if (!room.combatState || !room.combatState.active) return [];

  const casterConds = new Set((caster.conditions || []) as string[]);
  if (casterConds.has('invisible') && !casterConds.has('outlined')) return [];

  const gridSize = getGridSize(sessionId);
  if (!gridSize) return [];

  const opportunities: OAOpportunity[] = [];

  for (const enemy of room.tokens.values()) {
    if (enemy.id === casterTokenId) continue;
    if (!enemy.visible) continue;
    if (!isHostileTo(enemy, caster)) continue;

    const attackerConds = new Set((enemy.conditions || []) as string[]);
    let prevented = false;
    for (const cond of CONDITIONS_THAT_PREVENT_OA) {
      if (attackerConds.has(cond)) { prevented = true; break; }
    }
    if (prevented) continue;

    const economy = room.actionEconomies.get(enemy.id);
    if (economy?.reaction) continue;

    const meleeAttack = findBestMeleeAttackSync(enemy);
    if (!meleeAttack) continue;

    const reachCells = meleeReachCells(sessionId, enemy);
    const reachPx = reachCells * gridSize;

    const dist = edgeDistance(
      enemy.x, enemy.y, (enemy.size as number) || 1,
      caster.x, caster.y, (caster.size as number) || 1,
      gridSize,
    );
    if (dist <= reachPx + 0.5) {
      opportunities.push({
        attackerTokenId: enemy.id, attackerName: enemy.name,
        attackerOwnerUserId: enemy.ownerUserId,
        moverTokenId: casterTokenId, moverName: caster.name,
      });
    }
  }

  return opportunities;
}

export interface OAExecutionResult {
  success: boolean;
  messages: string[];
  hpChange?: { tokenId: string; hp: number; tempHp: number };
  characterHpUpdated?: { characterId: string; hp: number };
}

export async function executeOpportunityAttack(
  sessionId: string, attackerTokenId: string, moverTokenId: string,
): Promise<OAExecutionResult> {
  const room = getRoom(sessionId);
  if (!room) return { success: false, messages: ['No room'] };
  const attacker = room.tokens.get(attackerTokenId);
  const mover = room.tokens.get(moverTokenId);
  if (!attacker || !mover) return { success: false, messages: ['Missing token'] };

  const economy = room.actionEconomies.get(attacker.id);
  if (economy?.reaction) return { success: false, messages: [`\u26A0 ${attacker.name} has already spent their reaction.`] };

  const attack = await findBestMeleeAttack(attacker);
  if (!attack) return { success: false, messages: [`\u26A0 ${attacker.name} has no melee attack available.`] };

  // Cache the reach for the next sync detector pass. Keeps the map
  // warm when a token picks up / swaps weapons mid-combat, without
  // waiting for another startCombat cycle.
  const reachFromAttack = attack.properties?.some((p) => /reach/i.test(String(p))) ? 2 : 1;
  room.tokenMeleeReach.set(attacker.id, reachFromAttack);

  const moverConds = (mover.conditions || []) as string[];
  const attackerConds = (attacker.conditions || []) as string[];
  let adv = 'normal' as 'advantage' | 'disadvantage' | 'normal';
  if (moverConds.includes('prone')) adv = 'advantage';
  if (attackerConds.includes('poisoned') || attackerConds.includes('frightened') ||
      attackerConds.includes('blinded') || attackerConds.includes('restrained') ||
      attackerConds.includes('prone')) {
    adv = adv === 'advantage' ? 'normal' : 'disadvantage';
  }

  const r1 = Math.floor(Math.random() * 20) + 1;
  const r2 = Math.floor(Math.random() * 20) + 1;
  const kept = adv === 'advantage' ? Math.max(r1, r2) : adv === 'disadvantage' ? Math.min(r1, r2) : r1;
  const advTag = adv === 'advantage' ? ' (adv)' : adv === 'disadvantage' ? ' (disadv)' : '';
  const isCrit = kept === 20;
  const isFumble = kept === 1;
  const total = kept + attack.attackBonus;

  let moverAC = 10;
  {
    const combatant = room.combatState?.combatants.find((c) => c.tokenId === moverTokenId);
    if (combatant) { moverAC = combatant.armorClass; }
    else if (mover.characterId) {
      const { rows } = await pool.query('SELECT armor_class FROM characters WHERE id = $1', [mover.characterId]);
      if (rows[0]) moverAC = rows[0].armor_class;
    }
  }
  const hit = isCrit || (!isFumble && total >= moverAC);

  const messages: string[] = [];
  const rollStr = adv !== 'normal' ? `[${r1},${r2}]` : `${kept}`;
  const modStr = attack.attackBonus >= 0 ? `+${attack.attackBonus}` : `${attack.attackBonus}`;
  messages.push(`\u26A1 ${attacker.name} makes an Opportunity Attack (${attack.name}) on ${mover.name}`);
  messages.push(`   d20=${rollStr}${advTag}${modStr}=${total} vs AC ${moverAC} \u2192 ${isCrit ? '\uD83D\uDCA5 CRIT' : hit ? '\u2713 HIT' : isFumble ? '\u2717 FUMBLE' : '\u2717 MISS'}`);

  let eco = room.actionEconomies.get(attacker.id);
  if (!eco) {
    eco = { action: false, bonusAction: false, movementRemaining: 30, movementMax: 30, reaction: false };
    room.actionEconomies.set(attacker.id, eco);
  }
  eco.reaction = true;

  const result: OAExecutionResult = { success: true, messages };

  if (hit) {
    const rolledDamage = rollDamageString(attack.damageDice, isCrit);
    const damage = Math.max(0, rolledDamage);
    let newHp: number | null = null;
    const combatant = room.combatState?.combatants.find((c) => c.tokenId === moverTokenId);
    if (combatant) { combatant.hp = Math.max(0, combatant.hp - damage); newHp = combatant.hp; }
    if (mover.characterId) {
      const { rows } = await pool.query('SELECT hit_points FROM characters WHERE id = $1', [mover.characterId]);
      if (rows[0]) {
        const updatedHp = Math.max(0, rows[0].hit_points - damage);
        await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [updatedHp, mover.characterId]);
        if (newHp === null) newHp = updatedHp;
        result.characterHpUpdated = { characterId: mover.characterId, hp: updatedHp };
      }
    }
    const dmgTypeWord = attack.damageType ? ` ${attack.damageType}` : '';
    messages.push(`   ${damage}${dmgTypeWord} damage${isCrit ? ' [CRIT]' : ''}`);
    if (newHp !== null) {
      messages.push(`   ${mover.name} HP \u2192 ${newHp}`);
      result.hpChange = { tokenId: moverTokenId, hp: newHp, tempHp: combatant?.tempHp ?? 0 };
      if (newHp <= 0) messages.push(`   \uD83D\uDC80 ${mover.name} is DOWN`);
    }

    // Sentinel feat: "When you hit a creature with an opportunity
    // attack, the creature's speed becomes 0 for the rest of the
    // turn." We zero out the mover's remaining movement so the
    // client's movement cap code refuses further motion.
    if (attacker.characterId) {
      try {
        const { rows: featRows } = await pool.query(
          'SELECT features FROM characters WHERE id = $1', [attacker.characterId],
        );
        const featRow = featRows[0] as Record<string, unknown> | undefined;
        const raw = featRow?.features;
        const feats = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
        const hasSentinel = Array.isArray(feats) && feats.some(
          (f: { name?: string }) => typeof f?.name === 'string' && /^\s*sentinel\s*$/i.test(f.name),
        );
        if (hasSentinel) {
          const moverEco = room.actionEconomies.get(moverTokenId);
          if (moverEco) {
            moverEco.movementRemaining = 0;
          }
          messages.push(`   \u26D4 Sentinel — ${mover.name}'s speed becomes 0 for the rest of this turn.`);
        }
      } catch { /* ignore */ }
    }
  }

  return result;
}

// ─── helpers ─────────────────────────────────────────────────────

function getGridSize(sessionId: string): number | null {
  const room = getRoom(sessionId);
  if (!room?.currentMapId) return null;
  // Read the cached grid size for the map the tokens are on. The map
  // loader writes the size into `room.mapGridSizes` whenever a map is
  // loaded, so the sync OA reach math no longer has to fall back to
  // a hard-coded 70 (which mis-calculated reach on any non-standard grid).
  const cached = room.mapGridSizes.get(room.currentMapId);
  if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) return cached;
  return 70;
}

/**
 * True when two tokens are on opposite combat sides and should
 * trigger Opportunity Attacks against each other.
 *
 * Faction takes precedence — only friendly vs hostile qualifies as
 * hostile. Neutral never triggers, friendly-vs-friendly never
 * triggers, hostile-vs-hostile never triggers (monsters don't OA
 * each other).
 *
 * For tokens created before faction existed (ownerUserId-based rows
 * that were never migrated), we fall back to the old PC-vs-NPC
 * two-team check so existing sessions keep working.
 */
function isHostileTo(attacker: Token, target: Token): boolean {
  const a = attacker.faction;
  const t = target.faction;
  if (a && t) {
    return (a === 'friendly' && t === 'hostile') ||
           (a === 'hostile' && t === 'friendly');
  }
  // Backward compatibility: PC (ownerUserId) vs NPC (null) are opposed.
  const aIsPC = !!attacker.ownerUserId;
  const bIsPC = !!target.ownerUserId;
  return aIsPC !== bIsPC;
}

function edgeDistance(
  ax: number, ay: number, aSize: number,
  bx: number, by: number, bSize: number, gridSize: number,
): number {
  const acx = ax + (gridSize * aSize) / 2;
  const acy = ay + (gridSize * aSize) / 2;
  const bcx = bx + (gridSize * bSize) / 2;
  const bcy = by + (gridSize * bSize) / 2;
  const dx = Math.abs(acx - bcx) - (aSize * gridSize) / 2 - (bSize * gridSize) / 2;
  const dy = Math.abs(acy - bcy) - (aSize * gridSize) / 2 - (bSize * gridSize) / 2;
  return Math.max(Math.max(dx, 0), Math.max(dy, 0));
}

function meleeReachCells(sessionId: string, attacker: Token): number {
  // Prefer the cached reach populated at combat start — that's the
  // only path that can see the full inventory synchronously.
  const room = getRoom(sessionId);
  const cached = room?.tokenMeleeReach.get(attacker.id);
  if (typeof cached === 'number' && cached > 0) return cached;

  const atk = findBestMeleeAttackSync(attacker);
  if (!atk) return 1;
  if (atk.properties?.some((p) => /reach/i.test(p))) return 2;
  return 1;
}

interface ResolvedMeleeAttack {
  name: string; attackBonus: number; damageDice: string;
  damageType: string | null; properties: string[];
}

/**
 * Sync version for detectOpportunityAttacks (which must be sync).
 * Falls back to unarmed strike since we can't do async DB lookups here.
 * The actual attack resolution uses the async version.
 */
function findBestMeleeAttackSync(_token: Token): ResolvedMeleeAttack | null {
  return { name: 'Unarmed Strike', attackBonus: 0, damageDice: '1', damageType: 'bludgeoning', properties: [] };
}

/**
 * Async version that actually loads character data.
 */
async function findBestMeleeAttack(token: Token): Promise<ResolvedMeleeAttack | null> {
  let strMod = 0, dexMod = 0, profBonus = 2;
  let abilitiesLoaded = false;

  if (token.characterId) {
    const { rows } = await pool.query('SELECT inventory, ability_scores, proficiency_bonus FROM characters WHERE id = $1', [token.characterId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row) {
      try {
        const abilities = JSON.parse((row.ability_scores as string) || '{}') as Record<string, number>;
        profBonus = (row.proficiency_bonus as number) || 2;
        strMod = Math.floor(((abilities.str ?? abilities.strength ?? 10) - 10) / 2);
        dexMod = Math.floor(((abilities.dex ?? abilities.dexterity ?? 10) - 10) / 2);
        abilitiesLoaded = true;

        const inv = JSON.parse((row.inventory as string) || '[]') as InventoryWeapon[];
        const meleeWeapons = inv.filter((i) => {
          const type = String(i?.type || i?.category || '').toLowerCase();
          if (type !== 'weapon') return false;
          const props = ((i.properties || []) as string[]).map((p) => String(p).toLowerCase());
          if (props.some((p) => p === 'ammunition' || p === 'ranged')) return false;
          return true;
        });

        const scoreWeapon = (w: InventoryWeapon) => {
          const props = ((w.properties || []) as string[]).map((p: string) => String(p).toLowerCase());
          const isFinesse = props.includes('finesse');
          const abMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
          return { equippedScore: w.equipped ? 1 : 0, atkBonus: abMod + profBonus + (w.magicBonus ?? 0), dieSize: parseInt(String(w.damage || '1d4').match(/d(\d+)/)?.[1] || '4', 10) };
        };

        meleeWeapons.sort((a, b) => {
          const sa = scoreWeapon(a), sb = scoreWeapon(b);
          if (sa.equippedScore !== sb.equippedScore) return sb.equippedScore - sa.equippedScore;
          if (sa.atkBonus !== sb.atkBonus) return sb.atkBonus - sa.atkBonus;
          return sb.dieSize - sa.dieSize;
        });

        if (meleeWeapons.length > 0) {
          const w = meleeWeapons[0];
          const props: string[] = w.properties || [];
          const isFinesse = props.some((p: string) => /finesse/i.test(String(p)));
          const abMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
          const attackBonus = abMod + profBonus + (w.magicBonus ?? 0);
          const baseRaw = String(w.damage || '1d4');
          const baseMatch = baseRaw.match(/^\s*(\d+d\d+)/);
          const baseDice = baseMatch ? baseMatch[1] : '1d4';
          const dmgDice = `${baseDice}${abMod >= 0 ? `+${abMod}` : abMod}`;
          return { name: w.name ?? 'Melee Weapon', attackBonus, damageDice: dmgDice, damageType: (w.damageType ?? null), properties: props };
        }
      } catch (err) { console.warn('[OA] inventory parse failed for', token.name, err); }
    }
  }

  if (token.characterId) {
    const { rows } = await pool.query('SELECT extras FROM characters WHERE id = $1', [token.characterId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row?.extras) {
      try {
        const extras = typeof row.extras === 'string' ? JSON.parse(row.extras) : row.extras;
        const actions = (extras?.actions ?? []) as Array<Record<string, unknown>>;
        for (const action of actions) {
          const desc = String(action.desc ?? action.description ?? '').toLowerCase();
          if (/melee weapon attack/i.test(desc) || /melee attack/i.test(desc)) {
            const attackBonus = (action.attack_bonus as number) ?? 0;
            const damageDice = String(action.damage_dice ?? action.damage ?? '1d4');
            let damageType: string | null = null;
            const m = desc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(\w+)\s+damage/);
            if (m) damageType = m[2];
            return { name: String(action.name ?? 'Melee Attack'), attackBonus, damageDice, damageType, properties: [] };
          }
        }
      } catch { /* ignore */ }
    }
  }

  return { name: 'Unarmed Strike', attackBonus: abilitiesLoaded ? strMod + profBonus : 0, damageDice: abilitiesLoaded ? `1+${Math.max(0, strMod)}` : '1', damageType: 'bludgeoning', properties: [] };
}

function rollDamageString(notation: string, isCrit: boolean): number {
  if (!notation) return 0;
  const cleaned = notation.replace(/\s+/g, '');
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
