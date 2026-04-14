import { describe, it, expect } from 'vitest';
import {
  sessionJoinSchema,
  createCharacterSchema,
  createLootSchema,
  createCustomMonsterSchema,
  mapLoadSchema,
  tokenAddSchema,
  tokenMoveSchema,
  chatMessageSchema,
  chatRollSchema,
  combatStartSchema,
  combatDamageSchema,
  sessionUpdateSettingsSchema,
  createSessionSchema,
  createMapSchema,
} from '../utils/validation.js';

// ---------------------------------------------------------------------------
// sessionJoinSchema
// ---------------------------------------------------------------------------
describe('sessionJoinSchema', () => {
  it('accepts valid room code', () => {
    const result = sessionJoinSchema.safeParse({ roomCode: 'ABC123' });
    expect(result.success).toBe(true);
  });

  it('rejects missing roomCode', () => {
    const result = sessionJoinSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty roomCode', () => {
    const result = sessionJoinSchema.safeParse({ roomCode: '' });
    expect(result.success).toBe(false);
  });

  it('rejects roomCode exceeding max length', () => {
    const result = sessionJoinSchema.safeParse({ roomCode: 'A'.repeat(21) });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createCharacterSchema
// ---------------------------------------------------------------------------
describe('createCharacterSchema', () => {
  it('accepts valid minimal character', () => {
    const result = createCharacterSchema.safeParse({ name: 'Gandalf' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.level).toBe(1); // default
      expect(result.data.armorClass).toBe(10); // default
    }
  });

  it('rejects missing name', () => {
    const result = createCharacterSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = createCharacterSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects level above 20', () => {
    const result = createCharacterSchema.safeParse({ name: 'Test', level: 21 });
    expect(result.success).toBe(false);
  });

  it('accepts full ability scores', () => {
    const result = createCharacterSchema.safeParse({
      name: 'Wizard',
      abilityScores: { str: 8, dex: 14, con: 12, int: 18, wis: 13, cha: 10 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects ability score above 30', () => {
    const result = createCharacterSchema.safeParse({
      name: 'OP',
      abilityScores: { str: 31, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createLootSchema
// ---------------------------------------------------------------------------
describe('createLootSchema', () => {
  it('accepts valid loot item', () => {
    const result = createLootSchema.safeParse({ itemName: 'Longsword', quantity: 2 });
    expect(result.success).toBe(true);
  });

  it('defaults quantity to 1', () => {
    const result = createLootSchema.safeParse({ itemName: 'Shield' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quantity).toBe(1);
    }
  });

  it('rejects negative quantity', () => {
    const result = createLootSchema.safeParse({ itemName: 'Potion', quantity: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects zero quantity', () => {
    const result = createLootSchema.safeParse({ itemName: 'Potion', quantity: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects quantity above 9999', () => {
    const result = createLootSchema.safeParse({ itemName: 'Gold', quantity: 10000 });
    expect(result.success).toBe(false);
  });

  it('rejects oversized itemName', () => {
    const result = createLootSchema.safeParse({ itemName: 'A'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('rejects missing itemName', () => {
    const result = createLootSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createCustomMonsterSchema
// ---------------------------------------------------------------------------
describe('createCustomMonsterSchema', () => {
  it('accepts valid monster', () => {
    const result = createCustomMonsterSchema.safeParse({
      sessionId: 'sess-1',
      name: 'Goblin King',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing sessionId', () => {
    const result = createCustomMonsterSchema.safeParse({ name: 'Goblin' });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = createCustomMonsterSchema.safeParse({ sessionId: 'sess-1' });
    expect(result.success).toBe(false);
  });

  it('rejects armorClass above 99', () => {
    const result = createCustomMonsterSchema.safeParse({
      sessionId: 's1',
      name: 'Tank',
      armorClass: 100,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapLoadSchema
// ---------------------------------------------------------------------------
describe('mapLoadSchema', () => {
  it('accepts valid mapId', () => {
    const result = mapLoadSchema.safeParse({ mapId: 'map-abc' });
    expect(result.success).toBe(true);
  });

  it('rejects empty mapId', () => {
    const result = mapLoadSchema.safeParse({ mapId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing mapId', () => {
    const result = mapLoadSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tokenAddSchema / tokenMoveSchema
// ---------------------------------------------------------------------------
describe('tokenAddSchema', () => {
  it('accepts valid token with defaults', () => {
    const result = tokenAddSchema.safeParse({
      mapId: 'map-1',
      name: 'Fighter',
      x: 100,
      y: 200,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.size).toBe(1);
      expect(result.data.layer).toBe('token');
    }
  });

  it('rejects size above 4', () => {
    const result = tokenAddSchema.safeParse({
      mapId: 'map-1',
      name: 'Giant',
      x: 0,
      y: 0,
      size: 5,
    });
    expect(result.success).toBe(false);
  });
});

describe('tokenMoveSchema', () => {
  it('accepts valid move', () => {
    const result = tokenMoveSchema.safeParse({ tokenId: 't1', x: 50, y: 75 });
    expect(result.success).toBe(true);
  });

  it('rejects missing tokenId', () => {
    const result = tokenMoveSchema.safeParse({ x: 50, y: 75 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chatMessageSchema / chatRollSchema
// ---------------------------------------------------------------------------
describe('chatMessageSchema', () => {
  it('accepts valid message', () => {
    const result = chatMessageSchema.safeParse({
      type: 'ic',
      content: 'Hello, adventurers!',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = chatMessageSchema.safeParse({ type: 'unknown', content: 'hi' });
    expect(result.success).toBe(false);
  });

  it('rejects content exceeding 2000 chars', () => {
    const result = chatMessageSchema.safeParse({
      type: 'ooc',
      content: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('chatRollSchema', () => {
  it('accepts valid roll notation', () => {
    const result = chatRollSchema.safeParse({ notation: '2d6+3' });
    expect(result.success).toBe(true);
  });

  it('rejects empty notation', () => {
    const result = chatRollSchema.safeParse({ notation: '' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// combatStartSchema / combatDamageSchema
// ---------------------------------------------------------------------------
describe('combatStartSchema', () => {
  it('accepts valid token IDs', () => {
    const result = combatStartSchema.safeParse({ tokenIds: ['t1', 't2'] });
    expect(result.success).toBe(true);
  });

  it('rejects empty tokenIds array', () => {
    const result = combatStartSchema.safeParse({ tokenIds: [] });
    expect(result.success).toBe(false);
  });
});

describe('combatDamageSchema', () => {
  it('accepts valid damage', () => {
    const result = combatDamageSchema.safeParse({ tokenId: 't1', amount: 10 });
    expect(result.success).toBe(true);
  });

  it('rejects negative damage', () => {
    const result = combatDamageSchema.safeParse({ tokenId: 't1', amount: -5 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionUpdateSettingsSchema
// ---------------------------------------------------------------------------
describe('sessionUpdateSettingsSchema', () => {
  it('accepts valid partial settings', () => {
    const result = sessionUpdateSettingsSchema.safeParse({ gridSize: 50, gridOpacity: 0.5 });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = sessionUpdateSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects gridSize below 20', () => {
    const result = sessionUpdateSettingsSchema.safeParse({ gridSize: 10 });
    expect(result.success).toBe(false);
  });

  it('rejects gridOpacity above 1', () => {
    const result = sessionUpdateSettingsSchema.safeParse({ gridOpacity: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gridType', () => {
    const result = sessionUpdateSettingsSchema.safeParse({ gridType: 'triangle' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSessionSchema
// ---------------------------------------------------------------------------
describe('createSessionSchema', () => {
  it('accepts valid session', () => {
    const result = createSessionSchema.safeParse({ name: 'My Campaign' });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = createSessionSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    const result = createSessionSchema.safeParse({ name: 'A'.repeat(101) });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createMapSchema
// ---------------------------------------------------------------------------
describe('createMapSchema', () => {
  it('accepts valid map with defaults', () => {
    const result = createMapSchema.safeParse({ name: 'Dungeon' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.width).toBe(1400);
      expect(result.data.gridType).toBe('square');
    }
  });

  it('rejects empty name', () => {
    const result = createMapSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects width below 100', () => {
    const result = createMapSchema.safeParse({ name: 'Map', width: 50 });
    expect(result.success).toBe(false);
  });
});
