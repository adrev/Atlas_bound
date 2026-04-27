// Types
export type {
  Session, SessionSettings, Player, GameMode,
  SessionVisibility, SessionBan, RuleSource, RuleSourceInfo,
} from './types/session.js';
export { DEFAULT_SESSION_SETTINGS, RULE_SOURCES } from './types/session.js';
export type {
  AbilityScores, AbilityName, SkillProficiency, Skills, SpellSlot,
  Spell, InventoryItem, DeathSaves, Character, Feature, HitDicePool,
  CharacterBackground, CharacterCharacteristics, CharacterPersonality,
  CharacterNotes, CharacterProficiencies, CharacterSenses,
  CharacterDefenses, CharacterCurrency,
} from './types/character.js';
export { abilityModifier, proficiencyBonusForLevel, SKILL_ABILITY_MAP } from './types/character.js';
export type {
  GameMap, WallSegment, FogPolygon, Token, TokenAura, TokenFaction,
  LightSource, Condition, MapZone, AmbientLight,
  PrebuiltMap, MapPing, MapSummary, MapFolder,
} from './types/map.js';
export type {
  Drawing, DrawingKind, DrawingVisibility, DrawingGeometry,
  DrawingStreamPayload,
} from './types/drawing.js';
export type {
  Combatant, CombatState, ActionEconomy, ActionType,
  InitiativeRollRequest, InitiativeRollResult, InitiativeBreakdown,
  SpellCastEvent,
} from './types/combat.js';
export type {
  ChatMessageType, DiceRollData, ChatMessage, RollTemplate,
  AttackBreakdown, AttackBreakdownModifier, AttackBreakdownDamageSource,
  SpellCastBreakdown, SpellTargetOutcome,
  SaveBreakdown, ActionBreakdown,
} from './types/chat.js';
export type {
  ClientToServerEvents, ServerToClientEvents,
  ClientSessionEvents, ServerSessionEvents,
  ClientMapEvents, ServerMapEvents,
  ClientCombatEvents, ServerCombatEvents,
  ClientChatEvents, ServerChatEvents,
  ClientDrawingEvents, ServerDrawingEvents,
} from './types/socket-events.js';

// Utils
export { calculateEquipmentBonuses } from './utils/equipmentBonuses.js';

// Constants
export { CONDITIONS, CONDITION_MAP } from './constants/conditions.js';
export {
  CONDITION_EFFECTS,
  PSEUDO_CONDITION_EFFECTS,
  effectForCondition,
  colorForCondition,
  computeAttackModifiers,
  computeSaveModifiers,
  computeEffectiveAC,
  computeEffectiveSpeed,
  speedMultiplierFor,
  blocksActions,
  blocksReactions,
  resolveAdvantage,
} from './rules/conditionEffects.js';
export type { Advantage, ConditionEffect, AttackModifierResult, SaveModifierResult, EffectiveStat, Ability } from './rules/conditionEffects.js';
export { RACE_TRAITS, traitsForRace } from './rules/raceFeatures.js';
export type { RaceTraits, SaveAdvantageFlag, InnateRacialSpell } from './rules/raceFeatures.js';
export { SPELL_CONDITIONS, SPELL_BUFFS } from './constants/spell-conditions.js';
export type { ConditionInfo } from './constants/conditions.js';
export { SPELL_ANIMATIONS, getSpellAnimation } from './constants/spell-animations.js';
export type { AnimationType, SpellAnimationConfig } from './constants/spell-animations.js';
export { LIGHT_SOURCE_PRESETS, findLightPresetForName } from './constants/light-sources.js';
export type { LightSourcePreset } from './constants/light-sources.js';
export {
  lightTierAt, effectiveVisionTier, canSeeTarget, visionAttackModifier, perceptionPenalty,
} from './utils/vision-tier.js';
export type { LightTier, TokenSenses } from './utils/vision-tier.js';

// Utils
export { parseDiceNotation, rollDice, rollWithAdvantage } from './utils/dice-parser.js';
export type { ParsedDice, ParsedRoll, RollResult } from './utils/dice-parser.js';
export {
  snapToGrid, pixelToGrid, gridToPixel, gridDistance,
  getReachableCells, findPath,
} from './utils/grid-math.js';
export {
  computeVisibilityPolygon, lineSegmentIntersection,
} from './utils/visibility.js';

// Compendium
export type {
  CompendiumCategory, ItemRarity, CompendiumSearchResult,
  CompendiumMonster, CompendiumSpell, CompendiumItem,
  CustomItem, LootEntry,
} from './types/compendium.js';
