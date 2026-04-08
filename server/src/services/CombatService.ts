import type { Combatant, CombatState, ActionEconomy, ActionType, Condition } from '@dnd-vtt/shared';
import type { Token } from '@dnd-vtt/shared';
import { getRoom } from '../utils/roomState.js';
import db from '../db/connection.js';

export function startCombat(sessionId: string, tokenIds: string[]): CombatState {
  const room = getRoom(sessionId);
  if (!room) throw new Error('Room not found');

  const combatants: Combatant[] = [];
  for (const tokenId of tokenIds) {
    const token = room.tokens.get(tokenId);
    if (!token) continue;

    // Skip utility markers — light spell tokens, loot drops, and any
    // tiny non-character object. The client also filters these out
    // before calling combat:start, but we double-check here in case
    // a stale or malformed request slips through.
    if (/^(Light|Dancing Lights) \(/.test(token.name)) continue;
    if ((token.imageUrl ?? '').includes('/uploads/items/')) continue;
    if ((token.size as number) < 0.5 && !token.characterId) continue;

    let hp = 10;
    let maxHp = 10;
    let tempHp = 0;
    let ac = 10;
    let speed = 30;
    let initBonus = 0;
    let portrait: string | null = null;
    // Determine NPC status: tokens with no owner are NPCs,
    // and creature characters created with userId 'npc' are also NPCs
    let isNPC = !token.ownerUserId;

    if (token.characterId) {
      const charRow = db.prepare('SELECT * FROM characters WHERE id = ?').get(token.characterId) as Record<string, unknown> | undefined;
      if (charRow) {
        hp = (charRow.hit_points as number) ?? 10;
        maxHp = (charRow.max_hit_points as number) ?? 10;
        tempHp = (charRow.temp_hit_points as number) ?? 0;
        ac = (charRow.armor_class as number) ?? 10;
        speed = (charRow.speed as number) ?? 30;
        portrait = charRow.portrait_url as string | null;

        // DEX mod for initiative bonus. DDB imports sometimes store the
        // scores under full names ("dexterity") instead of "dex", so we
        // check both. Also guard against NaN — if the column is missing
        // entirely we just use 0 instead of producing NaN initiative.
        try {
          const rawAbilities = charRow.ability_scores;
          const abilities = typeof rawAbilities === 'string' ? JSON.parse(rawAbilities) : (rawAbilities ?? {});
          const dex = Number(abilities?.dex ?? abilities?.dexterity ?? 10);
          initBonus = Number.isFinite(dex) ? Math.floor((dex - 10) / 2) : 0;
        } catch {
          initBonus = 0;
        }

        // Characters created via creature library have userId 'npc'
        const charUserId = charRow.user_id as string | null;
        isNPC = !token.ownerUserId || charUserId === 'npc';
      }
    }

    combatants.push({
      tokenId,
      characterId: token.characterId,
      name: token.name,
      initiative: 0,
      initiativeBonus: initBonus,
      hp,
      maxHp,
      tempHp,
      armorClass: ac,
      speed,
      isNPC,
      conditions: [...token.conditions],
      deathSaves: { successes: 0, failures: 0 },
      portraitUrl: portrait ?? token.imageUrl,
    });
  }

  // Auto-roll initiative for ALL combatants
  // NPCs: group same-name creatures together (all Goblins share one roll)
  // Players: each rolls individually
  const npcGroupInitiatives = new Map<string, number>();
  for (const combatant of combatants) {
    // Ensure the bonus is a real number BEFORE we use it in the total,
    // otherwise a stale NaN bleeds into the final initiative and the
    // client shows the combatant as unsorted / zeroed.
    if (!Number.isFinite(combatant.initiativeBonus)) {
      combatant.initiativeBonus = 0;
    }
    if (combatant.isNPC) {
      // Grouped NPC initiative
      if (!npcGroupInitiatives.has(combatant.name)) {
        const dieValue = Math.floor(Math.random() * 20) + 1;
        npcGroupInitiatives.set(combatant.name, dieValue + combatant.initiativeBonus);
      }
      combatant.initiative = npcGroupInitiatives.get(combatant.name)!;
    } else {
      // Player auto-rolls individually
      const dieValue = Math.floor(Math.random() * 20) + 1;
      combatant.initiative = dieValue + combatant.initiativeBonus;
    }
    // Belt & braces: a combatant must never end this loop with a
    // 0/NaN/undefined initiative, or the downstream allInitiativesRolled
    // check skips the sort and the "initiative-set" broadcast filter
    // suppresses its row on the client.
    if (!Number.isFinite(combatant.initiative) || combatant.initiative === 0) {
      combatant.initiative = Math.floor(Math.random() * 20) + 1 + combatant.initiativeBonus;
    }
  }

  console.log('[COMBAT START] rolled initiatives:',
    combatants.map((c) => `${c.name}${c.isNPC ? '' : ' (PC)'}=${c.initiative}(bonus ${c.initiativeBonus})`).join(', '),
  );

  // Sort by initiative (highest first), break ties by DEX bonus
  combatants.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return b.initiativeBonus - a.initiativeBonus;
  });

  const combatState: CombatState = {
    sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants,
    startedAt: new Date().toISOString(),
  };

  room.combatState = combatState;
  room.gameMode = 'combat';

  // Persist to DB
  db.prepare(`
    INSERT OR REPLACE INTO combat_state (session_id, round_number, current_turn_index, combatants, started_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, 1, 0, JSON.stringify(combatants), combatState.startedAt);

  db.prepare("UPDATE sessions SET combat_active = 1, game_mode = 'combat' WHERE id = ?").run(sessionId);

  // Initialize action economies
  room.actionEconomies.clear();

  return combatState;
}

export function endCombat(sessionId: string): void {
  const room = getRoom(sessionId);
  if (!room) throw new Error('Room not found');

  room.combatState = null;
  room.gameMode = 'free-roam';
  room.actionEconomies.clear();

  db.prepare('DELETE FROM combat_state WHERE session_id = ?').run(sessionId);
  db.prepare("UPDATE sessions SET combat_active = 0, game_mode = 'free-roam' WHERE id = ?").run(sessionId);
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
    // Tie-break by DEX bonus (higher goes first)
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
  currentTurnIndex: number;
  roundNumber: number;
  actionEconomy: ActionEconomy;
  skippedTokenIds: string[];
  currentCombatant: Combatant;
} {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');

  const state = room.combatState;
  const skippedTokenIds: string[] = [];
  // Cap iterations at combatants.length so we can't infinite-loop if every
  // combatant is dead.
  let safety = state.combatants.length + 1;

  while (safety-- > 0) {
    state.currentTurnIndex++;

    if (state.currentTurnIndex >= state.combatants.length) {
      state.currentTurnIndex = 0;
      state.roundNumber++;
    }

    const candidate = state.combatants[state.currentTurnIndex];
    if (!candidate) break;

    // Skip dead / unconscious / petrified combatants — they can't act.
    // Death-saving characters (PCs at 0 HP) DO get a turn so they can roll
    // their death save, so we only skip if they're stably down (no death
    // save state) or marked unconscious permanently.
    const isDown = candidate.hp <= 0;
    const hasDeathSaves = candidate.deathSaves &&
      (candidate.deathSaves.successes > 0 || candidate.deathSaves.failures > 0);
    const isPlayerCharacter = !candidate.isNPC;

    // PCs at 0 HP get a turn for their death save UNTIL they stabilize or die.
    // NPCs at 0 HP just skip — they're either dead or unconscious-defeated.
    if (isDown && !isPlayerCharacter) {
      skippedTokenIds.push(candidate.tokenId);
      continue;
    }
    if (isDown && isPlayerCharacter && hasDeathSaves &&
        (candidate.deathSaves.failures >= 3 || candidate.deathSaves.successes >= 3)) {
      // Already resolved — dead or stable
      skippedTokenIds.push(candidate.tokenId);
      continue;
    }

    // Petrified / stunned / paralyzed creatures get their turn but can't
    // take actions. We still grant the turn so the DM can manually advance.
    break;
  }

  const currentCombatant = state.combatants[state.currentTurnIndex];

  // Reset action economy for the new current combatant
  const economy: ActionEconomy = {
    action: false,
    bonusAction: false,
    movementRemaining: currentCombatant.speed,
    movementMax: currentCombatant.speed,
    reaction: false,
  };
  room.actionEconomies.set(currentCombatant.tokenId, economy);

  persistCombatState(state);

  return {
    currentTurnIndex: state.currentTurnIndex,
    roundNumber: state.roundNumber,
    actionEconomy: economy,
    skippedTokenIds,
    currentCombatant,
  };
}

export function applyDamage(
  sessionId: string,
  tokenId: string,
  amount: number,
): { hp: number; tempHp: number; change: number } {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');

  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');

  let remaining = amount;

  // Damage temp HP first
  if (combatant.tempHp > 0) {
    const tempAbsorbed = Math.min(combatant.tempHp, remaining);
    combatant.tempHp -= tempAbsorbed;
    remaining -= tempAbsorbed;
  }

  // Then damage real HP
  combatant.hp = Math.max(0, combatant.hp - remaining);

  // Sync back to character in DB if applicable
  if (combatant.characterId) {
    db.prepare('UPDATE characters SET hit_points = ?, temp_hit_points = ? WHERE id = ?')
      .run(combatant.hp, combatant.tempHp, combatant.characterId);
  }

  persistCombatState(room.combatState);

  return { hp: combatant.hp, tempHp: combatant.tempHp, change: -amount };
}

export function applyHeal(
  sessionId: string,
  tokenId: string,
  amount: number,
): { hp: number; tempHp: number; change: number } {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');

  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');

  combatant.hp = Math.min(combatant.maxHp, combatant.hp + amount);

  // Reset death saves on healing from 0
  if (combatant.hp > 0) {
    combatant.deathSaves = { successes: 0, failures: 0 };
  }

  if (combatant.characterId) {
    db.prepare('UPDATE characters SET hit_points = ? WHERE id = ?')
      .run(combatant.hp, combatant.characterId);
  }

  persistCombatState(room.combatState);

  return { hp: combatant.hp, tempHp: combatant.tempHp, change: amount };
}

export function addCondition(
  sessionId: string,
  tokenId: string,
  condition: Condition,
): Condition[] {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');

  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');

  if (!combatant.conditions.includes(condition)) {
    combatant.conditions.push(condition);
  }

  // Also update the token
  const token = room.tokens.get(tokenId);
  if (token && !token.conditions.includes(condition)) {
    token.conditions.push(condition);
  }

  persistCombatState(room.combatState);
  return combatant.conditions;
}

export function removeCondition(
  sessionId: string,
  tokenId: string,
  condition: Condition,
): Condition[] {
  const room = getRoom(sessionId);
  if (!room?.combatState) throw new Error('No active combat');

  const combatant = room.combatState.combatants.find(c => c.tokenId === tokenId);
  if (!combatant) throw new Error('Combatant not found');

  combatant.conditions = combatant.conditions.filter(c => c !== condition);

  // Also update the token
  const token = room.tokens.get(tokenId);
  if (token) {
    token.conditions = token.conditions.filter(c => c !== condition);
  }

  persistCombatState(room.combatState);
  return combatant.conditions;
}

export function useAction(
  sessionId: string,
  actionType: ActionType,
): ActionEconomy | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;

  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return null;

  let economy = room.actionEconomies.get(current.tokenId);
  if (!economy) {
    economy = {
      action: false,
      bonusAction: false,
      movementRemaining: current.speed,
      movementMax: current.speed,
      reaction: false,
    };
    room.actionEconomies.set(current.tokenId, economy);
  }

  economy[actionType] = true;
  return economy;
}

/**
 * Take the Dash action for the current combatant. Consumes the Action
 * slot AND doubles the remaining movement. Returns the updated
 * economy or null if combat is inactive / no current combatant.
 */
export function useDash(sessionId: string): ActionEconomy | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;

  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return null;

  let economy = room.actionEconomies.get(current.tokenId);
  if (!economy) {
    economy = {
      action: false,
      bonusAction: false,
      movementRemaining: current.speed,
      movementMax: current.speed,
      reaction: false,
    };
    room.actionEconomies.set(current.tokenId, economy);
  }

  // Refuse if Action is already spent — the client does this gate too
  // but we enforce it here as a safety net.
  if (economy.action) return economy;

  // Spend the action slot and grant an extra speed worth of movement.
  // We add to remaining (not reset to double) so a creature that has
  // already moved 15 of 30 feet still gets 45 total (15 used + 30
  // remaining after dash = 45 feet of forward progress). Max is
  // bumped to speed * 2 so the UI bar reflects the boost.
  economy.action = true;
  economy.movementRemaining = economy.movementRemaining + current.speed;
  economy.movementMax = current.speed * 2;
  return economy;
}

export function useMovement(
  sessionId: string,
  feet: number,
): number {
  const room = getRoom(sessionId);
  if (!room?.combatState) return 0;

  const current = room.combatState.combatants[room.combatState.currentTurnIndex];
  if (!current) return 0;

  let economy = room.actionEconomies.get(current.tokenId);
  if (!economy) {
    economy = {
      action: false,
      bonusAction: false,
      movementRemaining: current.speed,
      movementMax: current.speed,
      reaction: false,
    };
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
    action: false,
    bonusAction: false,
    movementRemaining: current.speed,
    movementMax: current.speed,
    reaction: false,
  };
}

export function getCombatant(sessionId: string, tokenId: string): Combatant | null {
  const room = getRoom(sessionId);
  if (!room?.combatState) return null;
  return room.combatState.combatants.find(c => c.tokenId === tokenId) ?? null;
}

function persistCombatState(state: CombatState): void {
  db.prepare(`
    UPDATE combat_state
    SET round_number = ?, current_turn_index = ?, combatants = ?
    WHERE session_id = ?
  `).run(state.roundNumber, state.currentTurnIndex, JSON.stringify(state.combatants), state.sessionId);
}
