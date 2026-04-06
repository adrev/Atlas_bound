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
