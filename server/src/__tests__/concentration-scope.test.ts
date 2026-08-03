/**
 * Concentration cleanup scope (audit #7).
 *
 * When a caster loses concentration (drops to 0 HP, is incapacitated, or
 * is removed), only the conditions from the spell they were CONCENTRATING
 * on should end. The cleanup used to pass no spellName to
 * clearConcentrationConditions, which then matched EVERY caster-attributed
 * condition — so a monk's Stunning Strike stun and ongoing spell damage
 * (neither concentration-dependent) vanished when the caster went down.
 *
 * Fix: conditions carry a `concentration` flag; the caster-drop path
 * clears only flagged conditions. The specific-spell path (a CON save
 * failed) still matches by source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token, CombatState } from '@dnd-vtt/shared';
import type { ConditionMetadata } from '../utils/roomState.js';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import {
  applyConditionWithMeta,
  clearConcentrationConditions,
  dropConcentrationAndHeldEffects,
} from '../services/ConditionService.js';
import { createRoom, getAllRooms, deleteRoom } from '../utils/roomState.js';

const SESSION = 's-conc-scope';
const CASTER = 'wizard';

function tok(id: string, characterId: string | null = null): Token {
  return {
    id,
    mapId: 'm1',
    characterId,
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: null,
    createdAt: new Date().toISOString(),
  } as Token;
}

function seed() {
  const room = createRoom(SESSION, 'ROOM-CS', 'dm-user');
  room.tokens.set(CASTER, tok(CASTER));
  room.tokens.set('ogre', tok('ogre'));
  room.tokens.set('goblin', tok('goblin'));
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 3,
    currentTurnIndex: 0,
    combatants: [],
    startedAt: new Date().toISOString(),
  } as CombatState;
  return room;
}

const meta = (
  over: Partial<ConditionMetadata> & Pick<ConditionMetadata, 'name' | 'source'>
): ConditionMetadata => ({
  appliedRound: 1,
  casterTokenId: CASTER,
  ...over,
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('clearConcentrationConditions — caster-drop path (no spellName)', () => {
  it('clears concentration-flagged conditions but SPARES non-concentration caster effects', () => {
    const room = seed();
    // Concentration spell (Hold Person) → flagged.
    applyConditionWithMeta(
      SESSION,
      'ogre',
      meta({ name: 'paralyzed', source: 'Hold Person', concentration: true })
    );
    // Stunning Strike stun → caster-attributed but NOT concentration.
    applyConditionWithMeta(
      SESSION,
      'ogre',
      meta({ name: 'stunned', source: 'Monk (Stunning Strike)' })
    );
    // Ongoing damage on another target → NOT concentration.
    applyConditionWithMeta(SESSION, 'goblin', meta({ name: 'acid', source: 'Acid Arrow' }));

    const cleared = clearConcentrationConditions(SESSION, CASTER); // no spellName = caster lost concentration

    const clearedNames = cleared.flatMap((c) => c.removed);
    expect(clearedNames).toContain('paralyzed'); // concentration → cleared
    expect(clearedNames).not.toContain('stunned'); // Stunning Strike → survives (THE fix)
    expect(clearedNames).not.toContain('acid'); // ongoing damage → survives

    expect(room.conditionMeta.get('ogre')?.has('paralyzed')).toBe(false);
    expect(room.conditionMeta.get('ogre')?.has('stunned')).toBe(true);
    expect(room.conditionMeta.get('goblin')?.has('acid')).toBe(true);
  });

  it('ignores conditions cast by a DIFFERENT caster', () => {
    seed();
    applyConditionWithMeta(
      SESSION,
      'ogre',
      meta({ name: 'slowed', source: 'Slow', concentration: true, casterTokenId: 'other-caster' })
    );
    const cleared = clearConcentrationConditions(SESSION, CASTER);
    expect(cleared.flatMap((c) => c.removed)).not.toContain('slowed');
  });
});

describe('clearConcentrationConditions — specific-spell path (CON save failed)', () => {
  it('clears exactly that spell by source, regardless of the concentration flag', () => {
    seed();
    applyConditionWithMeta(
      SESSION,
      'ogre',
      meta({ name: 'paralyzed', source: 'Hold Person', concentration: true })
    );
    applyConditionWithMeta(
      SESSION,
      'goblin',
      meta({ name: 'frightened', source: 'Fear', concentration: true })
    );

    const cleared = clearConcentrationConditions(SESSION, CASTER, 'Hold Person');

    const names = cleared.flatMap((c) => c.removed);
    expect(names).toContain('paralyzed'); // matched by source
    expect(names).not.toContain('frightened'); // different spell, kept
  });
});

describe('dropConcentrationAndHeldEffects — end to end (caster to 0 HP)', () => {
  it('Stunning Strike stun on another creature SURVIVES the caster going down', () => {
    const room = seed();
    applyConditionWithMeta(
      SESSION,
      'ogre',
      meta({ name: 'stunned', source: 'Monk (Stunning Strike)' })
    );
    applyConditionWithMeta(
      SESSION,
      'goblin',
      meta({ name: 'paralyzed', source: 'Hold Person', concentration: true })
    );

    const result = dropConcentrationAndHeldEffects(SESSION, CASTER);

    const cleared = result.clearedConcentrationConditions.flatMap((c) => c.removed);
    expect(cleared).toContain('paralyzed'); // concentration ends
    expect(cleared).not.toContain('stunned'); // Stunning Strike persists
    expect(room.conditionMeta.get('ogre')?.has('stunned')).toBe(true);
  });
});
