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
  /**
   * Per-source breakdown of the initiative roll. Populated by
   * CombatService.startCombatAsync so the initiative review modal can
   * show the DM *why* a combatant's total is what it is — DEX mod,
   * Alert feat, Jack of All Trades, Remarkable Athlete, Rakish
   * Audacity, Dread Ambusher, Feral Instinct, etc.
   *
   * Shape mirrors AttackBreakdown's `attackRoll` so the rendering can
   * reuse the same per-source pill list; the card vocabulary stays
   * consistent with the rest of the transparency pipeline.
   *
   * Optional because older combat state (pre-schema) won't have it,
   * and mid-combat `addCombatantAsync` paths may or may not populate
   * depending on whether the add used the breakdown builder.
   */
  initiativeBreakdown?: InitiativeBreakdown;
}

export interface InitiativeBreakdown {
  /** Kept d20 value. With advantage/disadvantage this is the max/min
   *  of the two rolls. */
  d20: number;
  /** Both d20 faces when the roll was made with advantage or
   *  disadvantage (e.g. Feral Instinct Barbarian L7). */
  d20Rolls?: number[];
  advantage: 'normal' | 'advantage' | 'disadvantage';
  /** Per-source modifier lines. Each modifier pairs a human label
   *  ("DEX", "Alert", "Rakish Audacity", "Remarkable Athlete") with
   *  the signed integer contribution. Labels render in the modal
   *  so the DM sees exactly what built the bonus. */
  modifiers: Array<{
    label: string;
    value: number;
    /** Optional tag for grouping / coloring in the UI. */
    source?: 'ability' | 'feat' | 'class' | 'subclass' | 'spell' | 'other';
  }>;
  /** Final d20 + sum(modifiers). Matches Combatant.initiative when
   *  the DM hasn't hand-edited the total yet. */
  total: number;
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
