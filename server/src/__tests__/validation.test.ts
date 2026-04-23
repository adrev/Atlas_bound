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

  // -------------------------------------------------------------------
  // attackResult — structured per-source breakdown shipped alongside
  // the attack resolver's system message. Server validates + persists.
  // -------------------------------------------------------------------
  describe('attackResult attachment', () => {
    const validBreakdown = {
      attacker: { name: 'Liraya Voss', tokenId: 't-liraya' },
      target: { name: 'Goblin', tokenId: 't-goblin', ac: 13, baseAc: 13, acNotes: [] },
      weapon: { name: 'Longsword', damageType: 'slashing' },
      attackRoll: {
        d20: 14,
        advantage: 'normal' as const,
        modifiers: [
          { label: 'Weapon +ability +prof', value: 5, source: 'other' as const },
          { label: 'Bless +1d4', value: 3, source: 'condition' as const },
        ],
        total: 22,
        isCrit: false,
        isFumble: false,
      },
      hitResult: 'hit' as const,
      damage: {
        dice: '1d8+3',
        diceRolls: [5],
        mainRoll: 8,
        bonuses: [
          { label: 'Rage', amount: 2, damageType: 'slashing' },
        ],
        finalDamage: 10,
        targetHpBefore: 12,
        targetHpAfter: 2,
      },
      notes: ['Bless active', 'Target prone (melee adv)'],
    };

    it('accepts a valid attack breakdown payload', () => {
      const result = chatMessageSchema.safeParse({
        type: 'system',
        content: 'Liraya hits Goblin for 10',
        attackResult: validBreakdown,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a miss payload with no damage section', () => {
      const miss = {
        ...validBreakdown,
        hitResult: 'miss' as const,
        damage: undefined,
      };
      const result = chatMessageSchema.safeParse({
        type: 'system',
        content: 'Liraya misses Goblin',
        attackResult: miss,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a crit payload with d20Rolls for advantage', () => {
      const crit = {
        ...validBreakdown,
        hitResult: 'crit' as const,
        attackRoll: {
          ...validBreakdown.attackRoll,
          d20: 20,
          d20Rolls: [3, 20],
          advantage: 'advantage' as const,
          isCrit: true,
          total: 28,
        },
      };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'crit!', attackResult: crit,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a breakdown with an out-of-range d20 roll', () => {
      const bad = {
        ...validBreakdown,
        attackRoll: { ...validBreakdown.attackRoll, d20: 99 },
      };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: bad,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a breakdown missing attacker.name', () => {
      const { attacker: _a, ...rest } = validBreakdown;
      const bad = { ...rest, attacker: { tokenId: 't1' } };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: bad,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a breakdown with an unknown hitResult', () => {
      const bad = { ...validBreakdown, hitResult: 'glancing' };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: bad,
      });
      expect(result.success).toBe(false);
    });

    it('rejects more than 16 attack modifiers', () => {
      const bad = {
        ...validBreakdown,
        attackRoll: {
          ...validBreakdown.attackRoll,
          modifiers: Array.from({ length: 17 }, (_, i) => ({
            label: `mod-${i}`, value: 1,
          })),
        },
      };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: bad,
      });
      expect(result.success).toBe(false);
    });

    it('accepts shieldSpell annotations', () => {
      const withShield = {
        ...validBreakdown,
        shieldSpell: 'miss' as const,
      };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: withShield,
      });
      expect(result.success).toBe(true);
    });

    it('accepts damage source with resisted field + note', () => {
      const resistedHex = {
        ...validBreakdown,
        damage: {
          ...validBreakdown.damage,
          bonuses: [{
            label: 'Hex (1d6)',
            amount: 5,
            damageType: 'necrotic',
            resisted: 2,
            resistanceNote: 'resist necrotic',
          }],
        },
      };
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: resistedHex,
      });
      expect(result.success).toBe(true);
    });

    it('plain message with no attackResult still parses', () => {
      const result = chatMessageSchema.safeParse({
        type: 'system', content: 'plain system message',
      });
      expect(result.success).toBe(true);
    });
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

  // The `reported` field carries the client-side 3D dice result.
  // When present the server trusts it instead of re-rolling random.
  // These tests lock in the expected shape so the dice-box → chat
  // pipeline can't regress into silently accepting garbage.
  it('accepts a roll with reported dice + total', () => {
    const result = chatRollSchema.safeParse({
      notation: '1d20+3',
      reported: { dice: [{ type: 20, value: 15 }], total: 18 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts reported rolls for multi-die notation', () => {
    const result = chatRollSchema.safeParse({
      notation: '2d6+4',
      reported: {
        dice: [{ type: 6, value: 3 }, { type: 6, value: 5 }],
        total: 12,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects reported dice with no entries', () => {
    const result = chatRollSchema.safeParse({
      notation: '1d20',
      reported: { dice: [], total: 15 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects reported rolls with too many dice (>100)', () => {
    const big = Array.from({ length: 101 }, () => ({ type: 6, value: 1 }));
    const result = chatRollSchema.safeParse({
      notation: 'silly',
      reported: { dice: big, total: 101 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects reported total outside the ±10000 window', () => {
    const result = chatRollSchema.safeParse({
      notation: '1d20',
      reported: { dice: [{ type: 20, value: 20 }], total: 1_000_000 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects reported dice value above the type cap', () => {
    // Validator only clamps 0..1000 on the raw number; business-level
    // sanity (e.g. d20 value ≤ 20) is enforced in the service layer.
    const result = chatRollSchema.safeParse({
      notation: '1d20',
      reported: { dice: [{ type: 20, value: 9999 }], total: 9999 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects reported dice with non-integer type', () => {
    const result = chatRollSchema.safeParse({
      notation: '1d20',
      reported: { dice: [{ type: 20.5, value: 10 }], total: 10 },
    });
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
describe('sessionUpdateSettingsSchema discordWebhookUrl', () => {
  it('accepts a valid Discord webhook URL', () => {
    const r = sessionUpdateSettingsSchema.safeParse({
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
    });
    expect(r.success).toBe(true);
  });

  it('accepts the legacy discordapp.com host', () => {
    const r = sessionUpdateSettingsSchema.safeParse({
      discordWebhookUrl: 'https://discordapp.com/api/webhooks/1/2',
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty string (the clear-disable signal)', () => {
    expect(sessionUpdateSettingsSchema.safeParse({ discordWebhookUrl: '' }).success).toBe(true);
  });

  it('accepts null (the clear-disable signal)', () => {
    expect(sessionUpdateSettingsSchema.safeParse({ discordWebhookUrl: null }).success).toBe(true);
  });

  it('rejects non-Discord URLs (SSRF hardening)', () => {
    expect(sessionUpdateSettingsSchema.safeParse({
      discordWebhookUrl: 'https://evil.example.com/webhook',
    }).success).toBe(false);
    expect(sessionUpdateSettingsSchema.safeParse({
      discordWebhookUrl: 'http://discord.com/api/webhooks/1/2',
    }).success).toBe(false);
    expect(sessionUpdateSettingsSchema.safeParse({
      discordWebhookUrl: 'https://discord.com.evil.com/api/webhooks/1/2',
    }).success).toBe(false);
  });

  it('rejects URLs longer than 500 chars', () => {
    const url = 'https://discord.com/api/webhooks/' + 'a'.repeat(500);
    expect(sessionUpdateSettingsSchema.safeParse({ discordWebhookUrl: url }).success).toBe(false);
  });
});

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
