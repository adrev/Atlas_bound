import { describe, it, expect } from 'vitest';
import { rowToToken } from '../utils/tokenMapper.js';

/**
 * Regression test for the central DB-row → Token mapper. The four old
 * inline mappers kept drifting apart (missing faction on one path,
 * missing aura on another). This suite just pins down what rowToToken
 * returns so adding a new field forces every call site via the type
 * system and this fixture guards the happy paths + corrupted JSON.
 */
describe('rowToToken', () => {
  const baseRow = {
    id: 't-1',
    map_id: 'm-1',
    character_id: null,
    name: 'Goblin',
    x: 10,
    y: 20,
    size: 1,
    image_url: '/uploads/tokens/g.png',
    color: '#666',
    layer: 'token',
    visible: 1,
    has_light: 0,
    light_radius: 0,
    light_dim_radius: 0,
    light_color: '#ffcc44',
    conditions: '["prone"]',
    owner_user_id: null,
    faction: 'hostile',
    aura: null,
    created_at: '2026-04-16T00:00:00Z',
  };

  it('maps a vanilla NPC row into a Token shape', () => {
    const t = rowToToken(baseRow);
    expect(t).toMatchObject({
      id: 't-1',
      mapId: 'm-1',
      name: 'Goblin',
      faction: 'hostile',
      conditions: ['prone'],
      visible: true,
      hasLight: false,
      aura: null,
    });
  });

  it('defaults missing faction to neutral', () => {
    const t = rowToToken({ ...baseRow, faction: null });
    expect(t.faction).toBe('neutral');
  });

  it('parses aura JSON column back into the TokenAura shape', () => {
    const aura = { radiusFeet: 10, color: '#d4a843', opacity: 0.2, shape: 'circle' };
    const t = rowToToken({ ...baseRow, aura: JSON.stringify(aura) });
    expect(t.aura).toEqual(aura);
  });

  it('returns null aura when the column is null', () => {
    const t = rowToToken({ ...baseRow, aura: null });
    expect(t.aura).toBeNull();
  });

  it('survives a malformed conditions column (does not throw)', () => {
    const t = rowToToken({ ...baseRow, conditions: '{not: valid json' });
    expect(t.conditions).toEqual([]); // safeParseJSON fallback
  });

  it('survives a malformed aura column (does not throw)', () => {
    const t = rowToToken({ ...baseRow, aura: 'also not json' });
    expect(t.aura).toBeNull(); // safeParseJSON fallback
  });

  it('converts visible/has_light to booleans', () => {
    const t = rowToToken({ ...baseRow, visible: 0, has_light: 1 });
    expect(t.visible).toBe(false);
    expect(t.hasLight).toBe(true);
  });
});
