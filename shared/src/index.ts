// Types
export type { Session, SessionSettings, Player, GameMode } from './types/session.js';
export { DEFAULT_SESSION_SETTINGS } from './types/session.js';
export type {
  AbilityScores, AbilityName, SkillProficiency, Skills, SpellSlot,
  Spell, InventoryItem, DeathSaves, Character, Feature, HitDicePool,
  CharacterBackground, CharacterCharacteristics, CharacterPersonality,
  CharacterNotes, CharacterProficiencies, CharacterSenses,
  CharacterDefenses, CharacterCurrency,
} from './types/character.js';
export { abilityModifier, proficiencyBonusForLevel, SKILL_ABILITY_MAP } from './types/character.js';
export type {
  GameMap, WallSegment, FogPolygon, Token, LightSource, Condition,
  PrebuiltMap, MapPing, MapSummary,
} from './types/map.js';
export type {
  Drawing, DrawingKind, DrawingVisibility, DrawingGeometry,
  DrawingStreamPayload,
} from './types/drawing.js';
export type {
  Combatant, CombatState, ActionEconomy, ActionType,
  InitiativeRollRequest, InitiativeRollResult, SpellCastEvent,
} from './types/combat.js';
export type { ChatMessageType, DiceRollData, ChatMessage } from './types/chat.js';
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
export { SPELL_CONDITIONS, SPELL_BUFFS } from './constants/spell-conditions.js';
export type { ConditionInfo } from './constants/conditions.js';
export { SPELL_ANIMATIONS, getSpellAnimation } from './constants/spell-animations.js';
export type { AnimationType, SpellAnimationConfig } from './constants/spell-animations.js';

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
