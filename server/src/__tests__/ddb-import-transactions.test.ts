import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';

const { mockPoolQuery, mockConnect, mockParseCharacterJSON } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockParseCharacterJSON: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({
  default: { query: mockPoolQuery, connect: mockConnect },
}));

vi.mock('../services/DndBeyondService.js', () => ({
  parseCharacterJSON: mockParseCharacterJSON,
}));

import dndbeyondRouter from '../routes/dndbeyond.js';
import charactersRouter from '../routes/characters.js';

function makeCharacter(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Levelled Hero',
    race: 'Human',
    class: 'Fighter',
    level: 4,
    hitPoints: 30,
    maxHitPoints: 30,
    tempHitPoints: 0,
    armorClass: 17,
    speed: 30,
    proficiencyBonus: 2,
    abilityScores: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    savingThrows: ['str', 'con'],
    skills: {},
    spellSlots: { '1': { max: 3, used: 0 } },
    spells: [],
    features: [{ name: 'Second Wind', usesTotal: 1, usesRemaining: 1 }],
    inventory: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    dndbeyondId: 'ddb-123',
    background: {},
    characteristics: {},
    personality: {},
    notes: {},
    proficiencies: {},
    senses: {},
    defenses: {},
    conditions: [],
    currency: {},
    extras: [],
    spellcastingAbility: '',
    spellAttackBonus: 0,
    spellSaveDC: 10,
    initiative: 1,
    hitDice: [{ dieSize: 10, total: 4, used: 0 }],
    ...overrides,
  };
}

function makeCharacterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'char-1',
    user_id: 'owner-1',
    name: 'Old Hero',
    race: 'Human',
    class: 'Fighter',
    level: 3,
    hit_points: 22,
    max_hit_points: 24,
    temp_hit_points: 0,
    armor_class: 16,
    speed: 30,
    proficiency_bonus: 2,
    ability_scores: JSON.stringify({ str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }),
    saving_throws: JSON.stringify(['str', 'con']),
    skills: '{}',
    spell_slots: JSON.stringify({ '1': { max: 2, used: 1 } }),
    spells: '[]',
    features: JSON.stringify([{ name: 'Second Wind', usesTotal: 1, usesRemaining: 0 }]),
    inventory: '[]',
    death_saves: JSON.stringify({ successes: 0, failures: 0 }),
    hit_dice: JSON.stringify([{ dieSize: 10, total: 3, used: 2 }]),
    portrait_url: null,
    dndbeyond_id: 'ddb-123',
    dndbeyond_json: '{}',
    source: 'dndbeyond_import',
    ...overrides,
  };
}

function makeApp(mountPath: string, router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      avatarUrl: null,
    };
    next();
  });
  app.use(mountPath, router);
  return app;
}

function mockClient(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  mockConnect.mockResolvedValueOnce({ query, release });
  return release;
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockConnect.mockReset();
  mockParseCharacterJSON.mockReset();
  mockParseCharacterJSON.mockReturnValue(makeCharacter());
});

describe('DDB import transactions', () => {
  it('updates an existing /api/dndbeyond/import character inside one locked transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [makeCharacterRow()] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE
      .mockResolvedValueOnce(undefined); // COMMIT
    const release = mockClient(query);

    const res = await request(makeApp('/api/dndbeyond', dndbeyondRouter))
      .post('/api/dndbeyond/import')
      .send({ characterJson: { data: { id: 'ddb-123' } } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'char-1', updated: true, merged: true });
    const sqlCalls = query.mock.calls.map((call) => call[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[1]).toMatch(/SELECT \* FROM characters[\s\S]+FOR UPDATE/);
    expect(sqlCalls[2]).toMatch(/^UPDATE characters SET /);
    expect(sqlCalls[3]).toBe('COMMIT');
    expect(sqlCalls).not.toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back /api/dndbeyond/import when the merge update fails', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [makeCharacterRow()] }) // SELECT FOR UPDATE
      .mockRejectedValueOnce(new Error('write failed')) // UPDATE
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const release = mockClient(query);

    const res = await request(makeApp('/api/dndbeyond', dndbeyondRouter))
      .post('/api/dndbeyond/import')
      .send({ characterJson: { data: { id: 'ddb-123' } } });

    expect(res.status).toBe(400);
    const sqlCalls = query.mock.calls.map((call) => call[0] as string);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('updates an existing /api/characters/import-json character inside one locked transaction', async () => {
    const updatedRow = makeCharacterRow({ name: 'Levelled Hero', level: 4 });
    const query = vi
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [makeCharacterRow()] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE
      .mockResolvedValueOnce({ rows: [updatedRow] }) // SELECT updated
      .mockResolvedValueOnce(undefined); // COMMIT
    const release = mockClient(query);

    const res = await request(makeApp('/api/characters', charactersRouter))
      .post('/api/characters/import-json')
      .send({ characterJson: { data: { id: 'ddb-123' } } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'char-1', name: 'Levelled Hero', merged: true });
    const sqlCalls = query.mock.calls.map((call) => call[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[1]).toMatch(/SELECT \* FROM characters[\s\S]+FOR UPDATE/);
    expect(sqlCalls[2]).toMatch(/^UPDATE characters SET /);
    expect(sqlCalls[3]).toMatch(/^SELECT \* FROM characters/);
    expect(sqlCalls[4]).toBe('COMMIT');
    expect(sqlCalls).not.toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
