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

    it('accepts weapon-type resistance metadata (pre/post/note)', () => {
      // Regression: the base weapon row carries a separate
      // before/after/note triple for weapon-type resistance so the
      // card can show "24 → 12 (resists slashing)" without conflating
      // per-rider resistance. These fields are optional; omitting them
      // stays valid, and including them up to 120 chars on the note
      // round-trips.
      const resistedWeaponType = {
        ...validBreakdown,
        damage: {
          ...validBreakdown.damage,
          weaponTotalPre: 24,
          weaponTotalPost: 12,
          weaponResistanceNote: 'resists slashing',
        },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: resistedWeaponType,
      });
      expect(r.success).toBe(true);
    });

    it('rejects weapon-type resistance note over 120 chars', () => {
      const bad = {
        ...validBreakdown,
        damage: {
          ...validBreakdown.damage,
          weaponTotalPre: 24,
          weaponTotalPost: 12,
          weaponResistanceNote: 'x'.repeat(121),
        },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', attackResult: bad,
      });
      expect(r.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // spellResult — structured spell-cast breakdown for multi-target
  // spells (Fireball, Eldritch Blast, Cure Wounds, Hypnotic Pattern).
  // -------------------------------------------------------------------
  describe('spellResult attachment', () => {
    const validSingleAttack = {
      caster: { name: 'Vex', tokenId: 't-vex' },
      spell: {
        name: 'Fire Bolt',
        level: 0,
        kind: 'attack' as const,
        damageType: 'fire',
        spellAttackBonus: 5,
      },
      notes: [],
      targets: [
        {
          name: 'Goblin',
          tokenId: 't-goblin',
          kind: 'attack' as const,
          attack: {
            d20: 18,
            advantage: 'normal' as const,
            modifiers: [
              { label: 'Spell attack bonus', value: 5, source: 'other' as const },
            ],
            total: 23,
            targetAc: 13,
            hitResult: 'hit' as const,
          },
          damage: {
            dice: '1d10',
            diceRolls: [7],
            mainRoll: 7,
            bonuses: [],
            finalDamage: 7,
            targetHpBefore: 12,
            targetHpAfter: 5,
          },
        },
      ],
    };

    it('accepts a single-target spell attack (Fire Bolt)', () => {
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'Vex → Goblin: 7 fire', spellResult: validSingleAttack,
      });
      expect(r.success).toBe(true);
    });

    it('accepts an AoE save spell with per-target rows (Fireball)', () => {
      const fireball = {
        caster: { name: 'Vex', tokenId: 't-vex' },
        spell: {
          name: 'Fireball',
          level: 3,
          kind: 'save' as const,
          damageType: 'fire',
          saveAbility: 'dex' as const,
          saveDc: 15,
          halfOnSave: true,
        },
        notes: ['20-ft sphere · 4 in area'],
        targets: [
          {
            name: 'Orc', tokenId: 't-orc', kind: 'save' as const,
            save: {
              d20: 5, advantage: 'normal' as const, ability: 'dex' as const,
              modifiers: [{ label: 'DEX save mod', value: 1, source: 'ability' as const }],
              total: 6, dc: 15, saved: false,
            },
            damage: {
              dice: '8d6', diceRolls: [6, 5, 4, 3, 5, 2, 6, 1],
              mainRoll: 32, bonuses: [],
              finalDamage: 32, targetHpBefore: 40, targetHpAfter: 8,
            },
          },
          {
            name: 'Halfling', tokenId: 't-half', kind: 'save' as const,
            save: {
              d20: 18, advantage: 'advantage' as const, d20Rolls: [7, 18],
              ability: 'dex' as const,
              modifiers: [
                { label: 'DEX save mod', value: 3, source: 'ability' as const },
              ],
              total: 21, dc: 15, saved: true,
            },
            damage: {
              dice: '8d6', diceRolls: [6, 5, 4, 3, 5, 2, 6, 1],
              mainRoll: 16, bonuses: [], halfDamage: true,
              finalDamage: 16, targetHpBefore: 28, targetHpAfter: 12,
            },
          },
        ],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'Fireball!', spellResult: fireball,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a heal outcome (Cure Wounds)', () => {
      const cure = {
        caster: { name: 'Priest' },
        spell: { name: 'Cure Wounds', level: 1, kind: 'heal' as const },
        notes: [],
        targets: [
          {
            name: 'Ally', kind: 'heal' as const,
            healing: {
              dice: '1d8+3', diceRolls: [5],
              mainRoll: 8, targetHpBefore: 4, targetHpAfter: 12,
            },
          },
        ],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'cured', spellResult: cure,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a buff outcome (Bless)', () => {
      const bless = {
        caster: { name: 'Priest' },
        spell: { name: 'Bless', level: 1, kind: 'utility' as const },
        notes: [],
        targets: [
          {
            name: 'Fighter', kind: 'buff' as const,
            conditionsApplied: ['blessed'],
          },
        ],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'Bless', spellResult: bless,
      });
      expect(r.success).toBe(true);
    });

    it('accepts up to 20 target rows (large AoE)', () => {
      const big = {
        ...validSingleAttack,
        targets: Array.from({ length: 20 }, (_, i) => ({
          name: `t${i}`, kind: 'damage-flat' as const,
          damage: {
            dice: '1d6', diceRolls: [3], mainRoll: 3, bonuses: [],
            finalDamage: 3, targetHpBefore: 10, targetHpAfter: 7,
          },
        })),
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'big', spellResult: big,
      });
      expect(r.success).toBe(true);
    });

    it('rejects more than 20 target rows', () => {
      const tooBig = {
        ...validSingleAttack,
        targets: Array.from({ length: 21 }, () => ({
          name: 'x', kind: 'damage-flat' as const,
        })),
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', spellResult: tooBig,
      });
      expect(r.success).toBe(false);
    });

    it('rejects an unknown spell kind', () => {
      const bad = {
        ...validSingleAttack,
        spell: { ...validSingleAttack.spell, kind: 'blast' },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', spellResult: bad,
      });
      expect(r.success).toBe(false);
    });

    it('rejects an out-of-range spell level', () => {
      const bad = {
        ...validSingleAttack,
        spell: { ...validSingleAttack.spell, level: 10 },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', spellResult: bad,
      });
      expect(r.success).toBe(false);
    });

    it('accepts auto-failed save payload', () => {
      const paralyzed = {
        ...validSingleAttack,
        spell: { ...validSingleAttack.spell, kind: 'save' as const, saveAbility: 'str' as const, saveDc: 14 },
        targets: [
          {
            name: 'Paralyzed mark', kind: 'save' as const,
            save: {
              d20: 1, advantage: 'normal' as const, ability: 'str' as const,
              modifiers: [],
              total: -999, dc: 14, saved: false, autoFailed: true,
            },
          },
        ],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', spellResult: paralyzed,
      });
      expect(r.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // saveResult — single d20 save breakdown (concentration / death /
  // standalone save / spell retry).
  // -------------------------------------------------------------------
  describe('saveResult attachment', () => {
    it('accepts a concentration save payload', () => {
      const conc = {
        roller: { name: 'Vex', tokenId: 't-vex', characterId: 'c-vex' },
        context: 'Concentration on Hex',
        ability: 'con' as const,
        d20: 12,
        d20Rolls: [8, 12],
        advantage: 'advantage' as const,
        modifiers: [
          { label: 'CON modifier', value: 2, source: 'ability' as const },
          { label: 'Proficient in CON save', value: 3, source: 'proficiency' as const },
        ],
        total: 17,
        dc: 10,
        passed: true,
        concentration: {
          spellName: 'Hex',
          damageAmount: 12,
          dropped: false,
          warCaster: true,
        },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', saveResult: conc,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a death save payload (nat 20)', () => {
      const ds = {
        roller: { name: 'Pc', tokenId: 't-pc' },
        context: 'Death Save',
        ability: 'death' as const,
        d20: 20,
        advantage: 'normal' as const,
        modifiers: [],
        total: 20,
        dc: 10,
        passed: true,
        deathSave: {
          successes: 0,
          failures: 0,
          stabilized: true,
          critSuccess: true,
        },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', saveResult: ds,
      });
      expect(r.success).toBe(true);
    });

    it('rejects death save with successes > 3', () => {
      const bad = {
        roller: { name: 'Pc' },
        context: 'Death',
        ability: 'death' as const,
        d20: 10,
        advantage: 'normal' as const,
        modifiers: [],
        total: 10, passed: true,
        deathSave: { successes: 4, failures: 0 },
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', saveResult: bad,
      });
      expect(r.success).toBe(false);
    });

    it('rejects unknown ability', () => {
      const bad = {
        roller: { name: 'x' },
        context: 'y',
        ability: 'luck',
        d20: 10,
        advantage: 'normal' as const,
        modifiers: [], total: 10, passed: true,
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', saveResult: bad,
      });
      expect(r.success).toBe(false);
    });

    it('accepts a standalone save without dc/concentration/deathSave', () => {
      const s = {
        roller: { name: 'PC' },
        context: 'WIS save vs Fear',
        ability: 'wis' as const,
        d20: 15,
        advantage: 'normal' as const,
        modifiers: [{ label: 'WIS mod', value: 2 }],
        total: 17, passed: true,
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', saveResult: s,
      });
      expect(r.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // actionResult — non-dice narrative/mechanical event.
  // -------------------------------------------------------------------
  describe('actionResult attachment', () => {
    it('accepts a legendary action', () => {
      const a = {
        actor: { name: 'Ancient Red Dragon', tokenId: 't-drag' },
        action: { name: 'Tail Swipe', category: 'legendary' as const, icon: '\uD83D\uDC09', cost: '1 action' },
        effect: 'Makes a tail attack against a creature within 15 ft.',
        notes: [],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', actionResult: a,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a lair action with per-target effects', () => {
      const a = {
        actor: { name: 'Beholder' },
        action: { name: 'Eye Ray', category: 'lair' as const },
        effect: 'Beholder shoots 3 eye rays at random targets.',
        targets: [
          { name: 'Orc', effect: 'Disintegration — DC 16 DEX save' },
          { name: 'Goblin', damage: { amount: 22, damageType: 'force', hpBefore: 30, hpAfter: 8 } },
        ],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', actionResult: a,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a magic-item activation with conditions', () => {
      const a = {
        actor: { name: 'Liraya' },
        action: { name: 'Cloak of Protection', category: 'magic-item' as const },
        effect: '+1 AC and +1 to saving throws while worn.',
        targets: [{ name: 'Liraya', conditionsApplied: ['cloak-of-protection'] }],
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', actionResult: a,
      });
      expect(r.success).toBe(true);
    });

    it('rejects unknown action category', () => {
      const bad = {
        actor: { name: 'x' },
        action: { name: 'y', category: 'boss-fight' },
        effect: 'z',
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', actionResult: bad,
      });
      expect(r.success).toBe(false);
    });

    it('accepts up to 20 action targets', () => {
      const big = {
        actor: { name: 'x' },
        action: { name: 'y', category: 'environment' as const },
        effect: 'z',
        targets: Array.from({ length: 20 }, (_, i) => ({ name: `t${i}` })),
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', actionResult: big,
      });
      expect(r.success).toBe(true);
    });

    it('rejects more than 20 action targets', () => {
      const bad = {
        actor: { name: 'x' },
        action: { name: 'y', category: 'environment' as const },
        effect: 'z',
        targets: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}` })),
      };
      const r = chatMessageSchema.safeParse({
        type: 'system', content: 'x', actionResult: bad,
      });
      expect(r.success).toBe(false);
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
