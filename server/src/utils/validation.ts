import { z } from 'zod';

// --- Session event schemas ---
export const sessionJoinSchema = z.object({
  roomCode: z.string().min(1).max(20),
});

export const sessionKickSchema = z.object({
  targetUserId: z.string().uuid(),
});

export const sessionUpdateSettingsSchema = z.object({
  gridSize: z.number().int().min(20).max(200).optional(),
  gridOpacity: z.number().min(0).max(1).optional(),
  gridType: z.enum(['square', 'hex']).optional(),
  enableFogOfWar: z.boolean().optional(),
  enableDynamicLighting: z.boolean().optional(),
});

// --- Map event schemas ---
export const mapLoadSchema = z.object({
  mapId: z.string().min(1),
});

export const tokenMoveSchema = z.object({
  tokenId: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

export const tokenAddSchema = z.object({
  mapId: z.string().min(1),
  characterId: z.string().nullable().optional(),
  name: z.string().min(1).max(100),
  x: z.number(),
  y: z.number(),
  size: z.number().min(0.25).max(4).default(1),
  imageUrl: z.string().nullable().optional(),
  color: z.string().default('#666666'),
  layer: z.enum(['token', 'object', 'effect']).default('token'),
  visible: z.boolean().default(true),
  hasLight: z.boolean().default(false),
  lightRadius: z.number().min(0).default(0),
  lightDimRadius: z.number().min(0).default(0),
  lightColor: z.string().default('#ffcc44'),
  conditions: z.array(z.string()).default([]),
  ownerUserId: z.string().nullable().optional(),
});

export const tokenRemoveSchema = z.object({
  tokenId: z.string().min(1),
});

export const tokenUpdateSchema = z.object({
  tokenId: z.string().min(1),
  changes: z.object({
    name: z.string().min(1).max(100).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    size: z.number().min(0.25).max(4).optional(),
    imageUrl: z.string().nullable().optional(),
    color: z.string().optional(),
    layer: z.enum(['token', 'object', 'effect']).optional(),
    visible: z.boolean().optional(),
    hasLight: z.boolean().optional(),
    lightRadius: z.number().min(0).optional(),
    lightDimRadius: z.number().min(0).optional(),
    lightColor: z.string().optional(),
    conditions: z.array(z.string()).optional(),
    ownerUserId: z.string().nullable().optional(),
  }),
});

export const fogRevealHideSchema = z.object({
  points: z.array(z.number()),
});

export const wallAddSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});

export const wallRemoveSchema = z.object({
  index: z.number().int().min(0),
});

export const mapPingSchema = z.object({
  x: z.number(),
  y: z.number(),
});

// --- Scene Manager (Player Ribbon) schemas ---
export const mapListSchema = z.object({}).passthrough();
export const mapPreviewLoadSchema = z.object({ mapId: z.string().min(1) });
export const mapActivateForPlayersSchema = z.object({ mapId: z.string().min(1) });
export const mapDeleteSchema = z.object({ mapId: z.string().min(1) });

// --- Drawing event schemas ---

const drawingKindSchema = z.enum([
  'freehand', 'rect', 'circle', 'line', 'arrow', 'text', 'ephemeral',
]);
const drawingVisibilitySchema = z.enum(['shared', 'dm-only', 'player-only']);

const drawingGeometrySchema = z.object({
  points: z.array(z.number()).optional(),
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional(),
  circle: z.object({
    x: z.number(),
    y: z.number(),
    radius: z.number().min(0),
  }).optional(),
  text: z.object({
    x: z.number(),
    y: z.number(),
    content: z.string().max(500),
    fontSize: z.number().min(6).max(120),
  }).optional(),
});

export const drawingCreateSchema = z.object({
  drawing: z.object({
    // `id`, `createdAt`, `creatorUserId`, `creatorRole` are set server-side,
    // but we accept them from the client so undo/redo can preserve IDs
    // when re-creating a previously deleted drawing.
    id: z.string().min(1),
    mapId: z.string().min(1),
    creatorUserId: z.string().min(1),
    creatorRole: z.enum(['dm', 'player']),
    kind: drawingKindSchema,
    visibility: drawingVisibilitySchema,
    color: z.string().min(1).max(32),
    strokeWidth: z.number().min(0.5).max(64),
    geometry: drawingGeometrySchema,
    gridSnapped: z.boolean(),
    createdAt: z.number().int(),
    fadeAfterMs: z.number().int().nullable(),
  }),
});

export const drawingDeleteSchema = z.object({
  drawingId: z.string().min(1),
});

export const drawingClearAllSchema = z.object({
  scope: z.enum(['all', 'mine']),
});

export const drawingStreamSchema = z.object({
  tempId: z.string().min(1),
  creatorUserId: z.string().min(1),
  kind: drawingKindSchema,
  visibility: drawingVisibilitySchema,
  color: z.string().min(1).max(32),
  strokeWidth: z.number().min(0.5).max(64),
  geometry: drawingGeometrySchema,
});

export const drawingStreamEndSchema = z.object({
  tempId: z.string().min(1),
});

// --- Combat event schemas ---
export const combatStartSchema = z.object({
  tokenIds: z.array(z.string().min(1)).min(1),
});

export const combatRollInitiativeSchema = z.object({
  tokenId: z.string().min(1),
  bonus: z.number(),
});

export const combatSetInitiativeSchema = z.object({
  tokenId: z.string().min(1),
  total: z.number(),
});

export const combatDamageSchema = z.object({
  tokenId: z.string().min(1),
  amount: z.number().int().min(0),
});

export const combatHealSchema = z.object({
  tokenId: z.string().min(1),
  amount: z.number().int().min(0),
});

export const combatConditionSchema = z.object({
  tokenId: z.string().min(1),
  condition: z.enum([
    'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
    'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
    'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion',
  ]),
});

/**
 * Schema for the metadata-aware condition application event. Unlike
 * combat:condition-add, this accepts ANY condition string (so buffs
 * like 'blessed', 'hasted' work) plus optional duration / save retry
 * metadata. Used by the cast resolver to register Bless's 10-round
 * timer, Hold Person's WIS save retry, etc.
 */
export const conditionWithMetaSchema = z.object({
  targetTokenId: z.string().min(1),
  conditionName: z.string().min(1).max(40),
  source: z.string().min(1).max(80),
  casterTokenId: z.string().optional(),
  expiresAfterRound: z.number().int().optional(),
  saveAtEndOfTurn: z.object({
    ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']),
    dc: z.number().int().min(1).max(40),
    advantage: z.boolean().optional(),
  }).optional(),
  endsOnDamage: z.boolean().optional(),
});

export const combatDeathSaveSchema = z.object({
  tokenId: z.string().min(1),
});

export const combatUseActionSchema = z.object({
  actionType: z.enum(['action', 'bonusAction', 'reaction']),
});

export const combatUseMovementSchema = z.object({
  feet: z.number().min(0),
});

export const combatCastSpellSchema = z.object({
  casterId: z.string().min(1),
  spellName: z.string().min(1),
  targetIds: z.array(z.string()),
  targetPosition: z.object({ x: z.number(), y: z.number() }).nullable(),
  animationType: z.enum(['projectile', 'aoe', 'buff', 'melee']),
  animationColor: z.string(),
  aoeType: z.enum(['cone', 'sphere', 'line', 'cube']).optional(),
  aoeSize: z.number().optional(),
  aoeDirection: z.number().optional(),
});

// --- Combat relay/unvalidated event schemas ---
export const combatReadyCheckSchema = z.object({
  tokenIds: z.array(z.string().min(1)),
});

export const combatReadyResponseSchema = z.object({
  ready: z.boolean(),
});

export const combatOaExecuteSchema = z.object({
  attackerTokenId: z.string().min(1),
  moverTokenId: z.string().min(1),
});

export const combatSpellCastAttemptSchema = z.object({
  castId: z.string().min(1),
  casterTokenId: z.string().min(1).optional(),
  casterName: z.string().max(200).optional(),
  spellName: z.string().min(1).max(200),
  spellLevel: z.number().int().min(0).max(9),
});

export const combatSpellCounterspelledSchema = z.object({
  castId: z.string().min(1),
  counterCasterName: z.string().max(200).optional(),
  counterSlotLevel: z.number().int().min(1).max(9).optional(),
});

export const combatAttackHitAttemptSchema = z.object({
  attackId: z.string().min(1),
  targetTokenId: z.string().min(1),
  attackerName: z.string().max(200).optional(),
  attackTotal: z.number().optional(),
  currentAC: z.number().optional(),
});

export const combatShieldCastSchema = z.object({
  attackId: z.string().min(1),
  defenderName: z.string().max(200).optional(),
});

export const damageSideEffectsSchema = z.object({
  tokenId: z.string().min(1),
  damageAmount: z.number(),
});

export const concentrationDroppedSchema = z.object({
  casterTokenId: z.string().min(1),
  spellName: z.string().min(1).max(200),
});

// --- Scene Manager staged positions schema ---
export const stagedPositionSchema = z.object({
  characterId: z.string().min(1),
  name: z.string().min(1).max(200),
  x: z.number(),
  y: z.number(),
  imageUrl: z.string().max(1000).nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
});

export const mapActivateSchema = z.object({
  mapId: z.string().min(1),
  stagedPositions: z.array(stagedPositionSchema).max(50).optional(),
});

// --- Music sync schema ---
export const musicChangeSchema = z.object({
  track: z.string().max(50).nullable(),  // null = stop
});

// --- Session viewing schema ---
export const sessionViewingSchema = z.object({
  tab: z.string().min(1).max(50),
});

// --- Chat event schemas ---
export const chatMessageSchema = z.object({
  type: z.enum(['ic', 'ooc', 'system']),
  content: z.string().min(1).max(2000),
  characterName: z.string().max(100).optional(),
});

export const chatWhisperSchema = z.object({
  targetUserId: z.string().min(1),
  content: z.string().min(1).max(2000),
});

export const chatRollSchema = z.object({
  notation: z.string().min(1).max(200),
  reason: z.string().max(200).optional(),
  hidden: z.boolean().optional(),
});

// --- REST API schemas ---
export const createSessionSchema = z.object({
  name: z.string().min(1).max(100),
  displayName: z.string().min(1).max(50).optional(),
});

export const joinSessionSchema = z.object({
  roomCode: z.string().min(1).max(20),
  displayName: z.string().min(1).max(50).optional(),
});

const backgroundSchema = z.object({
  name: z.string(),
  description: z.string(),
  feature: z.string(),
}).optional();

const characteristicsSchema = z.object({
  alignment: z.string(),
  gender: z.string(),
  eyes: z.string(),
  hair: z.string(),
  skin: z.string(),
  height: z.string(),
  weight: z.string(),
  age: z.string(),
  faith: z.string(),
  size: z.string(),
}).optional();

const personalitySchema = z.object({
  traits: z.string(),
  ideals: z.string(),
  bonds: z.string(),
  flaws: z.string(),
}).optional();

const notesSchema = z.object({
  organizations: z.string(),
  allies: z.string(),
  enemies: z.string(),
  backstory: z.string(),
  other: z.string(),
}).optional();

const proficienciesSchema = z.object({
  armor: z.array(z.string()),
  weapons: z.array(z.string()),
  tools: z.array(z.string()),
  languages: z.array(z.string()),
}).optional();

const sensesSchema = z.object({
  passivePerception: z.number(),
  passiveInvestigation: z.number(),
  passiveInsight: z.number(),
  darkvision: z.number(),
}).optional();

const defensesSchema = z.object({
  resistances: z.array(z.string()),
  immunities: z.array(z.string()),
  vulnerabilities: z.array(z.string()),
}).optional();

const currencySchema = z.object({
  cp: z.number(),
  sp: z.number(),
  ep: z.number(),
  gp: z.number(),
  pp: z.number(),
}).optional();

export const createCharacterSchema = z.object({
  name: z.string().min(1).max(100),
  race: z.string().max(50).default(''),
  class: z.string().max(50).default(''),
  level: z.number().int().min(1).max(20).default(1),
  hitPoints: z.number().int().min(0).default(10),
  maxHitPoints: z.number().int().min(1).default(10),
  tempHitPoints: z.number().int().min(0).optional(),
  armorClass: z.number().int().min(0).default(10),
  speed: z.number().int().min(0).default(30),
  abilityScores: z.object({
    str: z.number().int().min(1).max(30),
    dex: z.number().int().min(1).max(30),
    con: z.number().int().min(1).max(30),
    int: z.number().int().min(1).max(30),
    wis: z.number().int().min(1).max(30),
    cha: z.number().int().min(1).max(30),
  }).optional(),
  savingThrows: z.array(z.string()).optional(),
  skills: z.record(z.string()).optional(),
  spellSlots: z.record(z.any()).optional(),
  spells: z.array(z.any()).optional(),
  features: z.array(z.any()).optional(),
  inventory: z.array(z.any()).optional(),
  deathSaves: z.object({ successes: z.number(), failures: z.number() }).optional(),
  portraitUrl: z.string().nullable().optional(),
  background: backgroundSchema,
  characteristics: characteristicsSchema,
  personality: personalitySchema,
  notes: notesSchema,
  proficiencies: proficienciesSchema,
  senses: sensesSchema,
  defenses: defensesSchema,
  conditions: z.array(z.string()).optional(),
  currency: currencySchema,
  extras: z.array(z.string()).optional(),
  spellcastingAbility: z.string().optional(),
  spellAttackBonus: z.number().int().optional(),
  spellSaveDC: z.number().int().optional(),
  initiative: z.number().int().optional(),
  hitDice: z.array(z.object({
    dieSize: z.number().int(),
    total: z.number().int(),
    used: z.number().int(),
  })).optional(),
  concentratingOn: z.string().nullable().optional(),
  compendiumSlug: z.string().nullable().optional(),
});

export const updateCharacterSchema = createCharacterSchema.partial();

// --- Loot schemas ---
export const createLootSchema = z.object({
  itemName: z.string().min(1).max(200),
  itemSlug: z.string().max(200).optional(),
  customItemId: z.string().max(100).nullable().optional(),
  itemRarity: z.enum(['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact']).optional(),
  quantity: z.number().int().positive().max(9999).default(1),
});

// --- Custom content schemas ---
export const createCustomMonsterSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1).max(200),
  size: z.string().max(50).optional(),
  type: z.string().max(100).optional(),
  alignment: z.string().max(100).optional(),
  armorClass: z.number().int().min(0).max(99).optional(),
  hitPoints: z.number().int().min(0).max(99999).optional(),
  hitDice: z.string().max(50).optional(),
  speed: z.string().max(200).optional(),
  abilityScores: z.string().max(500).optional(),
  challengeRating: z.string().max(20).optional(),
  crNumeric: z.number().min(0).max(30).optional(),
  actions: z.string().max(10000).optional(),
  specialAbilities: z.string().max(10000).optional(),
  legendaryActions: z.string().max(10000).optional(),
  description: z.string().max(5000).optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
  senses: z.string().max(500).optional(),
  languages: z.string().max(500).optional(),
  damageResistances: z.string().max(500).optional(),
  damageImmunities: z.string().max(500).optional(),
  conditionImmunities: z.string().max(500).optional(),
});

export const updateCustomMonsterSchema = createCustomMonsterSchema.partial().omit({ sessionId: true });

export const createCustomSpellSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1).max(200),
  level: z.number().int().min(0).max(9).optional(),
  school: z.string().max(50).optional(),
  castingTime: z.string().max(100).optional(),
  range: z.string().max(100).optional(),
  components: z.string().max(200).optional(),
  duration: z.string().max(100).optional(),
  description: z.string().max(10000).optional(),
  concentration: z.boolean().optional(),
  ritual: z.boolean().optional(),
  classes: z.array(z.string().max(50)).max(20).optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
  higherLevels: z.string().max(5000).optional(),
  damage: z.string().max(100).optional(),
  damageType: z.string().max(50).optional(),
  savingThrow: z.string().max(50).optional(),
  attackType: z.string().max(50).optional(),
  aoeType: z.string().max(50).optional(),
  aoeSize: z.number().min(0).max(999).optional(),
  halfOnSave: z.boolean().optional(),
  pushDistance: z.number().min(0).max(999).optional(),
  appliesCondition: z.string().max(100).nullable().optional(),
  animationType: z.string().max(100).nullable().optional(),
  animationColor: z.string().max(50).nullable().optional(),
});

export const updateCustomSpellSchema = createCustomSpellSchema.partial().omit({ sessionId: true });

export const createCustomItemSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1).max(200),
  type: z.string().max(50).optional(),
  rarity: z.string().max(50).optional(),
  requiresAttunement: z.boolean().optional(),
  description: z.string().max(5000).optional(),
  weight: z.number().min(0).max(99999).optional(),
  valueGp: z.number().min(0).max(999999).optional(),
  damage: z.string().max(100).optional(),
  damageType: z.string().max(50).optional(),
  properties: z.array(z.string().max(100)).max(20).optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
  range: z.string().max(100).optional(),
  ac: z.number().min(0).max(99).optional(),
  acType: z.string().max(50).optional(),
  magicBonus: z.number().min(0).max(10).optional(),
});

export const updateCustomItemSchema = createCustomItemSchema.partial().omit({ sessionId: true });

export const createMapSchema = z.object({
  name: z.string().min(1).max(100),
  width: z.coerce.number().int().min(100).max(10000).default(1400),
  height: z.coerce.number().int().min(100).max(10000).default(1050),
  gridSize: z.coerce.number().int().min(20).max(200).default(70),
  gridType: z.enum(['square', 'hex']).default('square'),
  /**
   * Set by the PrebuiltMapGallery when loading a prebuilt map.
   * Tells the server "this is the same template as a prior request";
   * if the session already has a map matching this key (by exact name),
   * return the existing map id instead of inserting a new row.
   * Enables the DM to click a prebuilt twice without losing the
   * walls / fog / tokens they've already set up on it.
   */
  prebuiltKey: z.string().max(100).optional(),
});
