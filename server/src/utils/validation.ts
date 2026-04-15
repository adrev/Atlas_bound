import { z } from 'zod';
import { safeImageUrlSchema } from './imageUrlValidator.js';

// --- Shared primitive schemas (P3.14) ---
// Tight bounds prevent DoS / off-map spawns / non-finite coordinate poisoning.
// Typical map sizes are up to 4000x4000 pixels; we allow generous padding for
// off-map tokens, snapshots, and future growth without letting callers send
// arbitrary Infinity / 1e308 values.
const coord = z.number().finite().min(-10000).max(20000);
const colorHex = z.string().regex(/^#[0-9A-Fa-f]{3,8}$/).max(9);
// `pointsFlat` as a flat [x0, y0, x1, y1, …] number array (used by fog / walls
// legacy shape). Bounded to 2000 numbers = 1000 points, same DoS ceiling.
const pointsFlat = z.array(z.number().finite()).max(2000);
const conditions = z.array(z.string().max(50)).max(30);
const faction = z.enum(['friendly', 'hostile', 'neutral']);

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
  showTokenLabels: z.boolean().optional(),
  turnTimerEnabled: z.boolean().optional(),
  turnTimerSeconds: z.number().int().min(15).max(300).optional(),
});

// --- Map event schemas ---
export const mapLoadSchema = z.object({
  mapId: z.string().min(1),
});

export const tokenMoveSchema = z.object({
  tokenId: z.string().min(1),
  x: coord,
  y: coord,
});

export const tokenAddSchema = z.object({
  mapId: z.string().min(1),
  characterId: z.string().nullable().optional(),
  name: z.string().min(1).max(100),
  x: coord,
  y: coord,
  size: z.number().finite().min(0.25).max(4).default(1),
  imageUrl: safeImageUrlSchema.nullable().optional(),
  color: colorHex.default('#666666'),
  layer: z.enum(['token', 'object', 'effect']).default('token'),
  visible: z.boolean().default(true),
  hasLight: z.boolean().default(false),
  lightRadius: z.number().finite().min(0).max(1000).default(0),
  lightDimRadius: z.number().finite().min(0).max(1000).default(0),
  lightColor: colorHex.default('#ffcc44'),
  conditions: conditions.default([]),
  ownerUserId: z.string().nullable().optional(),
  faction: faction.optional(),
});

export const tokenRemoveSchema = z.object({
  tokenId: z.string().min(1),
});

export const tokenUpdateSchema = z.object({
  tokenId: z.string().min(1),
  changes: z.object({
    name: z.string().min(1).max(100).optional(),
    x: coord.optional(),
    y: coord.optional(),
    size: z.number().finite().min(0.25).max(4).optional(),
    imageUrl: safeImageUrlSchema.nullable().optional(),
    color: colorHex.optional(),
    layer: z.enum(['token', 'object', 'effect']).optional(),
    visible: z.boolean().optional(),
    hasLight: z.boolean().optional(),
    lightRadius: z.number().finite().min(0).max(1000).optional(),
    lightDimRadius: z.number().finite().min(0).max(1000).optional(),
    lightColor: colorHex.optional(),
    conditions: conditions.optional(),
    ownerUserId: z.string().nullable().optional(),
    faction: faction.optional(),
    aura: z.object({
      radiusFeet: z.number().finite().min(5).max(120),
      color: colorHex,
      opacity: z.number().finite().min(0).max(1),
      shape: z.enum(['circle', 'square']),
    }).nullable().optional(),
  }),
});

export const fogRevealHideSchema = z.object({
  points: pointsFlat,
});

export const wallAddSchema = z.object({
  x1: coord,
  y1: coord,
  x2: coord,
  y2: coord,
});

export const wallRemoveSchema = z.object({
  index: z.number().int().min(0),
});

export const mapPingSchema = z.object({
  x: coord,
  y: coord,
});

// --- Map zone (encounter spawn region) schemas ---
const dim = z.number().finite().min(0).max(30000);
export const zoneAddSchema = z.object({
  name: z.string().min(1).max(64),
  x: coord,
  y: coord,
  width: dim,
  height: dim,
});
export const zoneUpdateSchema = z.object({
  zoneId: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  x: coord.optional(),
  y: coord.optional(),
  width: dim.optional(),
  height: dim.optional(),
});
export const zoneDeleteSchema = z.object({
  zoneId: z.string().min(1),
});

// --- Scene Manager (Player Ribbon) schemas ---
export const mapListSchema = z.object({}).passthrough();
export const mapPreviewLoadSchema = z.object({ mapId: z.string().min(1) });
export const mapActivateForPlayersSchema = z.object({ mapId: z.string().min(1) });
export const mapDeleteSchema = z.object({ mapId: z.string().min(1) });
export const mapRenameSchema = z.object({
  mapId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
});
export const mapDuplicateSchema = z.object({ mapId: z.string().min(1) });
export const mapReorderSchema = z.object({
  // Cap at 500 so a malformed client can't trigger an unbounded number
  // of UPDATEs in one socket frame.
  mapIds: z.array(z.string().min(1)).min(1).max(500),
});

// --- Drawing event schemas ---

const drawingKindSchema = z.enum([
  'freehand', 'rect', 'circle', 'line', 'arrow', 'text', 'ephemeral',
]);
const drawingVisibilitySchema = z.enum(['shared', 'dm-only', 'player-only']);

const drawingGeometrySchema = z.object({
  points: pointsFlat.optional(),
  rect: z.object({
    x: coord,
    y: coord,
    width: z.number().finite().min(0).max(30000),
    height: z.number().finite().min(0).max(30000),
  }).optional(),
  circle: z.object({
    x: coord,
    y: coord,
    radius: z.number().finite().min(0).max(30000),
  }).optional(),
  text: z.object({
    x: coord,
    y: coord,
    content: z.string().max(500),
    fontSize: z.number().finite().min(6).max(120),
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
  amount: z.number().int().min(0).max(9999),
});

export const combatHealSchema = z.object({
  tokenId: z.string().min(1),
  amount: z.number().int().min(0).max(9999),
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
  spellName: z.string().min(1).max(200),
  targetIds: z.array(z.string().min(1).max(100)).max(50),
  targetPosition: z.object({ x: coord, y: coord }).nullable(),
  animationType: z.enum(['projectile', 'aoe', 'buff', 'melee']),
  animationColor: colorHex,
  aoeType: z.enum(['cone', 'sphere', 'line', 'cube']).optional(),
  aoeSize: z.number().finite().min(0).max(1000).optional(),
  aoeDirection: z.number().finite().min(-720).max(720).optional(),
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
  /** Token of the counterspeller — used for server-side ownership check. */
  counterCasterTokenId: z.string().min(1).optional(),
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
  /** Token of the defender casting Shield — used for server-side ownership check. */
  defenderTokenId: z.string().min(1).optional(),
});

export const damageSideEffectsSchema = z.object({
  tokenId: z.string().min(1),
  damageAmount: z.number().min(0).max(9999),
});

export const concentrationDroppedSchema = z.object({
  casterTokenId: z.string().min(1),
  spellName: z.string().min(1).max(200),
});

// --- Scene Manager staged positions schema ---
export const stagedPositionSchema = z.object({
  characterId: z.string().min(1),
  name: z.string().min(1).max(200),
  x: coord,
  y: coord,
  imageUrl: safeImageUrlSchema.nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
});

export const mapActivateSchema = z.object({
  mapId: z.string().min(1),
  stagedPositions: z.array(stagedPositionSchema).max(50).optional(),
});

// --- Music sync schema ---
export const musicChangeSchema = z.object({
  track: z.string().max(50).nullable(),  // null = stop
  fileIndex: z.number().int().min(0).max(20).optional(),
});

export const musicActionSchema = z.object({
  action: z.enum(['pause', 'resume', 'next', 'prev']),
});

// --- Handout schema ---
export const handoutSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(5000).optional(),
  imageUrl: safeImageUrlSchema.optional(),
  targetUserIds: z.array(z.string()).max(20).optional(),
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
  // Client-reported result from the 3D dice animation. If present,
  // the server trusts it instead of re-rolling randomly — this is what
  // keeps the 3D dice face in sync with the chat card (dice-box can't
  // be forced to land on a predetermined value, so we let it be
  // authoritative instead). Omitted for server-initiated rolls (NPC
  // actions, auto-rolls, offline clients).
  reported: z.object({
    dice: z.array(z.object({
      type: z.number().int().min(2).max(1000),
      value: z.number().int().min(0).max(1000),
    })).min(1).max(100),
    total: z.number().int().min(-10000).max(10000),
  }).optional(),
});

// --- REST API schemas ---
const sessionPassword = z.string().min(4).max(64);
const banReason = z.string().max(200);

export const createSessionSchema = z.object({
  name: z.string().min(1).max(100),
  displayName: z.string().min(1).max(50).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  /** Only meaningful when visibility === 'private'. Min 4 chars, max 64. */
  password: sessionPassword.optional(),
});

export const joinSessionSchema = z.object({
  roomCode: z.string().min(1).max(20),
  displayName: z.string().min(1).max(50).optional(),
  /** Private sessions: plaintext password. */
  password: z.string().max(64).optional(),
  /** Private sessions: shareable invite token (alternative to password). */
  inviteToken: z.string().min(10).max(64).optional(),
});

export const patchSessionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  /** Set a new password. Empty string = remove password. */
  password: z.union([sessionPassword, z.literal('')]).optional(),
  /** Trigger: rotate the invite_code. Any truthy value regenerates. */
  regenerateInvite: z.boolean().optional(),
});

// Target user IDs are always Lucia-generated UUIDs; tighten from
// `z.string().min(1)` so a malformed id fails with 400 instead of
// falling through to an FK-violation 500.
const userIdField = z.string().uuid();

export const sessionBanSchema = z.object({
  targetUserId: userIdField,
  reason: banReason.optional(),
});

export const sessionUnbanSchema = z.object({
  targetUserId: userIdField,
});

export const sessionPromoteSchema = z.object({
  targetUserId: userIdField,
});

export const sessionDemoteSchema = z.object({
  targetUserId: userIdField,
});

export const transferOwnershipSchema = z.object({
  newOwnerId: userIdField,
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
  portraitUrl: safeImageUrlSchema.nullable().optional(),
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
  isNpc: z.boolean().optional(),
  // Required when isNpc === true: the DM must prove they are the DM of
  // this session before a global NPC can be created.
  sessionId: z.string().min(1).optional(),
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
  imageUrl: safeImageUrlSchema.nullable().optional(),
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
  imageUrl: safeImageUrlSchema.nullable().optional(),
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
  imageUrl: safeImageUrlSchema.nullable().optional(),
  range: z.string().max(100).optional(),
  ac: z.number().min(0).max(99).optional(),
  acType: z.string().max(50).optional(),
  magicBonus: z.number().min(0).max(10).optional(),
});

export const updateCustomItemSchema = createCustomItemSchema.partial().omit({ sessionId: true });

// --- Encounter preset schemas ---
export const createEncounterSchema = z.object({
  name: z.string().min(1).max(100),
  creatures: z.array(z.object({
    slug: z.string().min(1),
    name: z.string().min(1).max(200),
    count: z.number().int().min(1).max(20),
  })).min(1).max(50),
});

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
