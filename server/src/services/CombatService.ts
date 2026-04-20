import type { Combatant, CombatState, ActionEconomy, ActionType, Condition } from '@dnd-vtt/shared';
import { speedMultiplierFor } from '@dnd-vtt/shared';
import { getRoom, type RoomState } from '../utils/roomState.js';
import pool from '../db/connection.js';

/**
 * 5e movement cap for a combatant's turn. Pulls base speed from the
 * combatant row and then applies any condition / exhaustion level
 * that halves or zeros movement. Delegates to the shared
 * `speedMultiplierFor` helper so client + server + future handlers
 * agree on the same movement rules.
 */
function computeMovementCap(combatant: Combatant, room: RoomState): number {
  const token = room.tokens.get(combatant.tokenId);
  if (!token) return combatant.speed;
  const conditions = (token.conditions || []) as string[];
  // TODO: wire exhaustion level once the character row exposes it.
  const mul = speedMultiplierFor(conditions, 0);
  return Math.floor(combatant.speed * mul);
}

export function startCombat(sessionId: string, tokenIds: string[]): CombatState {
  const room = getRoom(sessionId);
  if (!room) throw new Error('Room not found');

  const combatants: Combatant[] = [];
  for (const tokenId of tokenIds) {
    const token = room.tokens.get(tokenId);
    if (!token) continue;

    if (/^(Light|Dancing Lights) \(/.test(token.name)) continue;
    if ((token.imageUrl ?? '').includes('/uploads/items/')) continue;
    if ((token.size as number) < 0.5 && !token.characterId) continue;

    let hp = 10, maxHp = 10, tempHp = 0, ac = 10, speed = 30, initBonus = 0;
    let portrait: string | null = null;
    let isNPC = !token.ownerUserId;

    if (token.characterId) {
      // NOTE: This is sync code in a sync function. We use a sync DB call pattern.
      // Since we moved to pg (async only), startCombat will need to be refactored to async.
      // For now, we defer the character lookup to be done before calling startCombat.
      // The room.tokens already has the data we need from the session join.
      // We'll make this async below.
    }

    combatants.push({
      tokenId, characterId: token.characterId, name: token.name,
      initiative: 0, initiativeBonus: initBonus,
      hp, maxHp, tempHp, armorClass: ac, speed, isNPC,
      conditions: [...token.conditions],
      deathSaves: { successes: 0, failures: 0 },
      portraitUrl: portrait ?? token.imageUrl,
    });
  }

  // Auto-roll initiative
  const npcGroupInitiatives = new Map<string, number>();
  for (const combatant of combatants) {
    if (!Number.isFinite(combatant.initiativeBonus)) combatant.initiativeBonus = 0;
    if (combatant.isNPC) {
      if (!npcGroupInitiatives.has(combatant.name)) {
        const dieValue = Math.floor(Math.random() * 20) + 1;
        npcGroupInitiatives.set(combatant.name, dieValue + combatant.initiativeBonus);
      }
      combatant.initiative = npcGroupInitiatives.get(combatant.name)!;
    } else {
      const dieValue = Math.floor(Math.random() * 20) + 1;
      combatant.initiative = dieValue + combatant.initiativeBonus;
    }
    if (!Number.isFinite(combatant.initiative) || combatant.initiative === 0) {
      combatant.initiative = Math.floor(Math.random() * 20) + 1 + combatant.initiativeBonus;
    }
  }

  combatants.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return b.initiativeBonus - a.initiativeBonus;
  });

  const combatState: CombatState = {
    sessionId, active: true, roundNumber: 1, currentTurnIndex: 0,
    combatants, startedAt: new Date().toISOString(),
  };

  room.combatState = combatState;
  room.gameMode = 'combat';

  // Persist to DB (fire-and-forget async)
  pool.query(
    `INSERT INTO combat_state (session_id, round_number, current_turn_index, combatants, started_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET round_number=$2, current_turn_index=$3, combatants=$4, started_at=$5`,
    [sessionId, 1, 0, JSON.stringify(combatants), combatState.startedAt],
  ).catch(err => console.error('[CombatService] persist combat_state failed:', err));

  pool.query("UPDATE sessions SET combat_active = 1, game_mode = 'combat' WHERE id = $1", [sessionId])
    .catch(err => console.error('[CombatService] update session failed:', err));

  room.actionEconomies.clear();
  return combatState;
}

/**
 * Async version of startCombat that properly loads character data from Postgres.
 */
export async function startCombatAsync(sessionId: string, tokenIds: string[]): Promise<CombatState> {
  const room = getRoom(sessionId);
  if (!room) throw new Error('Room not found');

  const combatants: Combatant[] = [];
  for (const tokenId of tokenIds) {
    const token = room.tokens.get(tokenId);
    if (!token) continue;

    if (/^(Light|Dancing Lights) \(/.test(token.name)) continue;
    if ((token.imageUrl ?? '').includes('/uploads/items/')) continue;
    if ((token.size as number) < 0.5 && !token.characterId) continue;

    let hp = 10, maxHp = 10, tempHp = 0, ac = 10, speed = 30, initBonus = 0;
    let portrait: string | null = null;
    let isNPC = !token.ownerUserId;

    if (token.characterId) {
      const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [token.characterId]);
      const charRow = rows[0] as Record<string, unknown> | undefined;
      if (charRow) {
        hp = (charRow.hit_points as number) ?? 10;
        maxHp = (charRow.max_hit_points as number) ?? 10;
        tempHp = (charRow.temp_hit_points as number) ?? 0;
        ac = (charRow.armor_class as number) ?? 10;
        speed = (charRow.speed as number) ?? 30;
        portrait = charRow.portrait_url as string | null;
        // Prefer the character's precomputed initiative bonus — it's
        // what the character sheet shows and it already includes Alert
        // (+5), Jack of All Trades (half prof), and any other feat
        // modifiers applied during the import pipeline. Fall back to
        // DEX mod when the column is unset (missing / 0 / NaN), which
        // matches the old behaviour for unimported characters.
        const storedInit = Number(charRow.initiative);
        let baseFromDex = 0;
        try {
          const rawAbilities = charRow.ability_scores;
          const abilities = typeof rawAbilities === 'string' ? JSON.parse(rawAbilities) : (rawAbilities ?? {});
          const dex = Number(abilities?.dex ?? abilities?.dexterity ?? 10);
          baseFromDex = Number.isFinite(dex) ? Math.floor((dex - 10) / 2) : 0;
        } catch { baseFromDex = 0; }
        if (Number.isFinite(storedInit) && storedInit !== 0) {
          initBonus = storedInit;
        } else {
          initBonus = baseFromDex;
        }
        // Alert feat: +5 initiative. Check the character's features
        // blob directly — the DDB pipeline stamps `initiative` to
        // include Alert when importing, but homebrew / manually-created
        // characters only get the raw DEX mod. Scanning the features
        // here makes the bonus reliable regardless of provenance, and
        // protects against the DDB pipeline changing shape.
        try {
          const rawFeatures = charRow.features;
          const features = typeof rawFeatures === 'string' ? JSON.parse(rawFeatures) : (rawFeatures ?? []);
          const featureList: Array<{ name?: string }> = Array.isArray(features) ? features : [];
          const hasAlert = featureList.some((f) => typeof f?.name === 'string' && /^\s*alert\s*$/i.test(f.name));
          if (hasAlert) {
            // If storedInit already included Alert, we'd double-count.
            // Detect by comparing against the raw DEX mod — stored
            // >= DEX+5 means Alert is already baked in. Heuristic but
            // resilient.
            if (initBonus < baseFromDex + 5) {
              initBonus = baseFromDex + 5;
            }
          }
        } catch { /* features blob unparseable — skip */ }
        const charUserId = charRow.user_id as string | null;
        isNPC = !token.ownerUserId || charUserId === 'npc';
      }
    }

    combatants.push({
      tokenId, characterId: token.characterId, name: token.name,
      initiative: 0, initiativeBonus: initBonus,
      hp, maxHp, tempHp, armorClass: ac, speed, isNPC,
      conditions: [...token.conditions],
      deathSaves: { successes: 0, failures: 0 },
      portraitUrl: portrait ?? token.imageUrl,
    });
  }

  const npcGroupInitiatives = new Map<string, number>();
  for (const combatant of combatants) {
    if (!Number.isFinite(combatant.initiativeBonus)) combatant.initiativeBonus = 0;
    if (combatant.isNPC) {
      if (!npcGroupInitiatives.has(combatant.name)) {
        npcGroupInitiatives.set(combatant.name, Math.floor(Math.random() * 20) + 1 + combatant.initiativeBonus);
      }
      combatant.initiative = npcGroupInitiatives.get(combatant.name)!;
    } else {
      combatant.initiative = Math.floor(Math.random() * 20) + 1 + combatant.initiativeBonus;
    }
    if (!Number.isFinite(combatant.initiative) || combatant.initiative === 0) {
      combatant.initiative = Math.floor(Math.random() * 20) + 1 + combatant.initiativeBonus;
    }
  }

  console.log('[COMBAT START] rolled initiatives:',
    combatants.map((c) => `${c.name}${c.isNPC ? '' : ' (PC)'}=${c.initiative}(bonus ${c.initiativeBonus})`).join(', '),
  );

  combatants.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return b.initiativeBonus - a.initiativeBonus;
  });

  const combatState: CombatState = {
    sessionId, active: true, roundNumber: 1, currentTurnIndex: 0,
    combatants, startedAt: new Date().toISOString(),
  };

  room.combatState = combatState;
  room.gameMode = 'combat';

  await pool.query(
    `INSERT INTO combat_state (session_id, round_number, current_turn_index, combatants, started_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET round_number=$2, current_turn_index=$3, combatants=$4, started_at=$5`,
    [sessionId, 1, 0, JSON.stringify(combatants), combatState.startedAt],
  );
  await pool.query("UPDATE sessions SET combat_active = 1, game_mode = 'combat' WHERE id = $1", [sessionId]);

  room.actionEconomies.clear();
  return combatState;
}

/**
 * Add a token to the current initiative order mid-combat. Rolls an
 * initiative for it just like combat-start does and inserts it into
 * the sorted `combatants` list.
 *
 * Returns the new combatant, or null if the token can't be added
 * (combat not active, token missing, or token already in combat).
 */
export async function addCombatantAsync(sessionId: string, tokenId: string): Promise<Combatant | null> {
  const room = getRoom(sessionId);
  if (!room) return null;
  if (!room.combatState?.active) return null;
  // Deduplicate — nothing silly about having the same token twice in
  // combat, but it's almost never intentional.
  if (room.combatState.combatants.some((c) => c.tokenId === tokenId)) return null;

  const token = room.tokens.get(tokenId);
  if (!token) return null;

  // Same derivation as startCombatAsync — read HP / AC / init bonus
  // from the backing character row when there is one, else use
  // token defaults.
  let hp = 10, maxHp = 10, tempHp = 0, ac = 10, speed = 30, initBonus = 0;
  let portrait: string | null = null;
  let isNPC = !token.ownerUserId;
  if (token.characterId) {
    const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [token.characterId]);
    const charRow = rows[0] as Record<string, unknown> | undefined;
    if (charRow) {
      hp = (charRow.hit_points as number) ?? 10;
      maxHp = (charRow.max_hit_points as number) ?? 10;
      tempHp = (charRow.temp_hit_points as number) ?? 0;
      ac = (charRow.armor_class as number) ?? 10;
      speed = (charRow.speed as number) ?? 30;
      portrait = charRow.portrait_url as string | null;
      // Prefer precomputed character.initiative (includes Alert +5, etc.)
      // Fall back to DEX mod when unset.
      const storedInit = Number(charRow.initiative);
      if (Number.isFinite(storedInit) && storedInit !== 0) {
        initBonus = storedInit;
      } else {
        try {
          const rawAbilities = charRow.ability_scores;
          const abilities = typeof rawAbilities === 'string' ? JSON.parse(rawAbilities) : (rawAbilities ?? {});
          const dex = Number(abilities?.dex ?? abilities?.dexterity ?? 10);
          initBonus = Number.isFinite(dex) ? Math.floor((dex - 10) / 2) : 0;
        } catch { initBonus = 0; }
      }
      const charUserId = charRow.user_id as string | null;
      isNPC = !token.ownerUserId || charUserId === 'npc';
    }
  }

  const combatant: Combatant = {
    tokenId, characterId: token.characterId, name: token.name,
    initiative: Math.floor(Math.random() * 20) + 1 + initBonus,
    initiativeBonus: initBonus,
    hp, maxHp, tempHp, armorClass: ac, speed, isNPC,
    conditions: [...token.conditions],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: portrait ?? token.imageUrl,
  };

  // Insert into the sorted list while keeping the existing turn
  // pointer aligned to the same combatant. Use tokenId (unique) instead
  // of name to find the current combatant after re-sort — duplicate
  // names are common in encounters (Goblin ×3, Guard ×2, etc.) and
  // the old name-based lookup would silently shift the turn to the
  // wrong creature when names collided.
  const currentTokenId = room.combatState.combatants[room.combatState.currentTurnIndex]?.tokenId;
  room.combatState.combatants.push(combatant);
  room.combatState.combatants.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return b.initiativeBonus - a.initiativeBonus;
  });
  const newIdx = room.combatState.combatants.findIndex((c) => c.tokenId === currentTokenId);
  if (newIdx >= 0) room.combatState.currentTurnIndex = newIdx;

  await pool.query(
    'UPDATE combat_state SET combatants = $1, current_turn_index = $2 WHERE session_id = $3',
    [JSON.stringify(room.combatState.combatants), room.combatState.currentTurnIndex, sessionId],
  );
  return combatant;
}

export async function endCombat(sessionId: string): Promise<void> {
  const room = getRoom(sessionId);
  if (!room) throw new Error('Room not found');

  room.combatState = null;
  room.gameMode = 'free-roam';
  room.actionEconomies.clear();

  await pool.query('DELETE FROM combat_state WHERE session_id = $1', [sessionId]);
  await pool.query("UPDATE sessions SET combat_active = 0, game_mode = 'free-roam' WHERE id = $1", [sessionId]);
}

export function setInitiative(sessionId: string, tokenId: string, total: number): Combatant | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;
  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) return null;
  combatant.initiative = total;
  persistCombatState(room.combatState);
  return combatant;
}

export function sortInitiative(sessionId: string): Combatant[] {
  const room = getRoom(sessionId);
  if (!room?.combatState) return [];
  room.combatState.combatants.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return b.initiativeBonus - a.initiativeBonus;
  });
  persistCombatState(room.combatState);
  return room.combatState.combatants;
}

export function allInitiativesRolled(sessionId: string): boolean {
  const room = getRoom(sessionId);
  if (!room?.combatState) return false;
  return room.combatState.combatants.every(c => c.initiative !== 0);
}

export function nextTurn(sessionId: string): {
  currentTurnIndex: number; roundNumber: number; actionEconomy: ActionEconomy;
  skippedTokenIds: string[]; currentCombatant: Combatant;
} {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');

  const state = room.combatState;
  const skippedTokenIds: string[] = [];
  // Cap iterations at combatants.length to guarantee termination even
  // if every participant is dead (avoids infinite loops).
  let safety = state.combatants.length + 1;

  while (safety-- > 0) {
    state.currentTurnIndex++;
    if (state.currentTurnIndex >= state.combatants.length) { state.currentTurnIndex = 0; state.roundNumber++; }
    const candidate = state.combatants[state.currentTurnIndex];
    if (!candidate) break;

    // If the token no longer exists in the room (removed mid-combat)
    // skip it entirely — nothing to take a turn.
    const token = room.tokens.get(candidate.tokenId);
    if (!token) { skippedTokenIds.push(candidate.tokenId); continue; }

    const tokenConds = (token.conditions || []) as string[];
    const isExplicitlyDead = tokenConds.includes('dead');
    const isDown = candidate.hp <= 0;
    const hasDeathSaves = candidate.deathSaves && (candidate.deathSaves.successes > 0 || candidate.deathSaves.failures > 0);
    const isPlayerCharacter = !candidate.isNPC;

    // Explicit "dead" marker — skip regardless of PC/NPC.
    if (isExplicitlyDead) { skippedTokenIds.push(candidate.tokenId); continue; }

    // NPCs at 0 HP are simply dead and skipped.
    if (isDown && !isPlayerCharacter) { skippedTokenIds.push(candidate.tokenId); continue; }

    // Dead PCs (3 death-save failures) stay in initiative but don't
    // act. Stabilized PCs heal back to ≥1 HP so `isDown` is false and
    // this branch doesn't trigger.
    if (isDown && isPlayerCharacter && hasDeathSaves &&
        candidate.deathSaves.failures >= 3) {
      skippedTokenIds.push(candidate.tokenId); continue;
    }

    // Downed PC who still has death saves to roll — they get a turn
    // (to roll the death save). The per-action handlers block other
    // actions while HP is 0 so they can't attack/cast while unconscious.
    break;
  }

  const currentCombatant = state.combatants[state.currentTurnIndex];
  // Apply 5e movement penalties for conditions that land on a token
  // BEFORE their turn starts. Prone → half speed (representing the
  // cost of either crawling or standing up). Grappled / restrained →
  // speed 0. These are authoritative for the turn; standing up later
  // in the turn doesn't refund the movement.
  const moveCap = computeMovementCap(currentCombatant, room);
  const economy: ActionEconomy = {
    action: false, bonusAction: false, movementRemaining: moveCap,
    movementMax: moveCap, reaction: false,
  };
  room.actionEconomies.set(currentCombatant.tokenId, economy);
  persistCombatState(state);

  return { currentTurnIndex: state.currentTurnIndex, roundNumber: state.roundNumber, actionEconomy: economy, skippedTokenIds, currentCombatant };
}

export interface HpChangeResult {
  hp: number;
  tempHp: number;
  change: number;
  /** Populated when the combatant is backed by a player character.
   *  Callers should fan out `character:updated` so character sheet
   *  views stay in sync with the combat tracker. */
  characterId: string | null;
}

export async function applyDamage(sessionId: string, tokenId: string, amount: number): Promise<HpChangeResult> {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');
  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');

  let remaining = amount;
  if (combatant.tempHp > 0) {
    const tempAbsorbed = Math.min(combatant.tempHp, remaining);
    combatant.tempHp -= tempAbsorbed;
    remaining -= tempAbsorbed;
  }
  combatant.hp = Math.max(0, combatant.hp - remaining);

  if (combatant.characterId) {
    await pool.query('UPDATE characters SET hit_points = $1, temp_hit_points = $2 WHERE id = $3',
      [combatant.hp, combatant.tempHp, combatant.characterId]);
  }
  persistCombatState(room.combatState);
  return { hp: combatant.hp, tempHp: combatant.tempHp, change: -amount, characterId: combatant.characterId ?? null };
}

export async function applyHeal(sessionId: string, tokenId: string, amount: number): Promise<HpChangeResult> {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');
  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');

  combatant.hp = Math.min(combatant.maxHp, combatant.hp + amount);
  if (combatant.hp > 0) combatant.deathSaves = { successes: 0, failures: 0 };

  if (combatant.characterId) {
    await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [combatant.hp, combatant.characterId]);
  }
  persistCombatState(room.combatState);
  return { hp: combatant.hp, tempHp: combatant.tempHp, change: amount, characterId: combatant.characterId ?? null };
}

export function addCondition(sessionId: string, tokenId: string, condition: Condition): Condition[] {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');
  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');
  if (!combatant.conditions.includes(condition)) combatant.conditions.push(condition);
  const token = room.tokens.get(tokenId);
  if (token && !token.conditions.includes(condition)) token.conditions.push(condition);
  persistCombatState(room.combatState);
  // Persist to the token DB row so conditions survive a server restart
  // or map reload. Without this, condition badges disappear on refresh
  // because the token row still has the old conditions array.
  const conditionsJson = JSON.stringify(combatant.conditions);
  pool.query('UPDATE tokens SET conditions = $1 WHERE id = $2', [conditionsJson, tokenId]).catch(() => {});
  return combatant.conditions;
}

export function removeCondition(sessionId: string, tokenId: string, condition: Condition): Condition[] {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');
  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');
  combatant.conditions = combatant.conditions.filter(c => c !== condition);
  const token = room.tokens.get(tokenId);
  if (token) token.conditions = token.conditions.filter(c => c !== condition);
  persistCombatState(room.combatState);
  const conditionsJson = JSON.stringify(combatant.conditions);
  pool.query('UPDATE tokens SET conditions = $1 WHERE id = $2', [conditionsJson, tokenId]).catch(() => {});
  return combatant.conditions;
}

export function useAction(sessionId: string, actionType: ActionType): ActionEconomy | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;
  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return null;
  let economy = room.actionEconomies.get(current.tokenId);
  if (!economy) {
    economy = { action: false, bonusAction: false, movementRemaining: current.speed, movementMax: current.speed, reaction: false };
    room.actionEconomies.set(current.tokenId, economy);
  }
  economy[actionType] = true;
  return economy;
}

export function useDash(sessionId: string): ActionEconomy | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;
  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return null;
  let economy = room.actionEconomies.get(current.tokenId);
  if (!economy) {
    economy = { action: false, bonusAction: false, movementRemaining: current.speed, movementMax: current.speed, reaction: false };
    room.actionEconomies.set(current.tokenId, economy);
  }
  if (economy.action) return economy;
  economy.action = true;
  economy.movementRemaining = economy.movementRemaining + current.speed;
  economy.movementMax = current.speed * 2;
  return economy;
}

export function useMovement(sessionId: string, feet: number): number {
  const room = getRoom(sessionId);
  if (!room?.combatState) return 0;
  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return 0;
  let economy = room.actionEconomies.get(current.tokenId);
  if (!economy) {
    economy = { action: false, bonusAction: false, movementRemaining: current.speed, movementMax: current.speed, reaction: false };
    room.actionEconomies.set(current.tokenId, economy);
  }
  economy.movementRemaining = Math.max(0, economy.movementRemaining - feet);
  return economy.movementRemaining;
}

export function getActionEconomy(sessionId: string): ActionEconomy | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;
  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return null;
  return room.actionEconomies.get(current.tokenId) ?? {
    action: false, bonusAction: false, movementRemaining: current.speed, movementMax: current.speed, reaction: false,
  };
}

export function getCombatant(sessionId: string, tokenId: string): Combatant | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;
  return room.combatState.combatants.find(c => c.tokenId === tokenId) ?? null;
}

function persistCombatState(state: CombatState): void {
  pool.query(
    'UPDATE combat_state SET round_number = $1, current_turn_index = $2, combatants = $3 WHERE session_id = $4',
    [state.roundNumber, state.currentTurnIndex, JSON.stringify(state.combatants), state.sessionId],
  ).catch(err => console.error('[CombatService] persistCombatState failed:', err));
}
