import type { Condition } from './map.js';
import type { DeathSaves } from './character.js';

export interface Combatant {
  tokenId: string;
  characterId: string | null;
  name: string;
  initiative: number;
  initiativeBonus: number;
  hp: number;
  maxHp: number;
  tempHp: number;
  armorClass: number;
  speed: number;
  isNPC: boolean;
  conditions: Condition[];
  deathSaves: DeathSaves;
  portraitUrl: string | null;
  /** 5e exhaustion level 0–6. Propagated from the character row at combat start. */
  exhaustionLevel?: number;
  /**
   * True when the combatant has the Alert feat. Stamped at combat
   * start by CombatService; used by InitiativeReviewModal to render
   * a small "Alert" chip next to the +5 bonus so the DM can see why
   * the number is higher than the DEX mod alone would explain.
   */
  hasAlert?: boolean;
  /**
   * 5e Surprise Round (PHB p.189): creatures that are surprised at
   * the start of combat can't move or take an action on their first
   * turn, and can't take a reaction until that turn ends. Cleared
   * automatically at the start of round 2. DM toggles this in the
   * InitiativeReviewModal before locking initiative. Never true for
   * combatants with Alert (feat grants immunity to surprise).
   */
  surprised?: boolean;
}

export interface CombatState {
  sessionId: string;
  active: boolean;
  roundNumber: number;
  currentTurnIndex: number;
  combatants: Combatant[];
  startedAt: string;
}

export interface ActionEconomy {
  action: boolean;
  bonusAction: boolean;
  movementRemaining: number;
  movementMax: number;
  reaction: boolean;
}

export type ActionType = 'action' | 'bonusAction' | 'reaction';

export interface InitiativeRollRequest {
  tokenId: string;
  bonus: number;
}

export interface InitiativeRollResult {
  tokenId: string;
  roll: number;
  bonus: number;
  total: number;
}

export interface SpellCastEvent {
  casterId: string;
  spellName: string;
  targetIds: string[];
  targetPosition: { x: number; y: number } | null;
  animationType: 'projectile' | 'aoe' | 'buff' | 'melee';
  animationColor: string;
  aoeType?: 'cone' | 'sphere' | 'line' | 'cube';
  aoeSize?: number;
  aoeDirection?: number;
}
