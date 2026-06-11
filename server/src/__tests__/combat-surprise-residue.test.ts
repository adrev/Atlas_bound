/**
 * Audit #12 — two combat-lifecycle gaps:
 *
 * (1) SURPRISE AT SLOT 0: nextTurn enforces "surprised combatants lose
 *     their round-1 turn" for every slot EXCEPT the opener — the first
 *     turn starts implicitly at the current index when the DM locks
 *     initiative, so a surprised top-initiative combatant took a full
 *     turn anyway. combat:lock-initiative now advances past a surprised
 *     opener (nextTurn's own skip logic carries through consecutive
 *     surprised slots) and broadcasts the same turn-advanced payload
 *     (currentTokenId included) the normal advance path uses.
 *
 * (2) END-COMBAT RESIDUE: endCombat cleared only combatState +
 *     actionEconomies. Per-fight caches (melee reach, Mobile targets,
 *     polearm masters, lair flags, legendary/recharge budgets) and
 *     round-relative conditionMeta leaked into the NEXT encounter —
 *     a buff applied in fight A round 12 ("expires after 21") would
 *     survive into fight B and not expire until ITS round 22. Manual /
 *     non-round-relative meta (grapples) deliberately persists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token, CombatState, Combatant } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import * as CombatService from '../services/CombatService.js';
import { registerCombatLifecycle } from '../socket/combat/lifecycleEvents.js';
import { createRoom, getAllRooms, addPlayerToRoom, deleteRoom } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}
type Handler = (data: unknown) => Promise<void> | void;

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function driverFor(emissions: Emission[], socketId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: socketId,
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: socketId, event, payload }),
  };
  registerCombatLifecycle(fakeIo(emissions) as never, socket as never);
  return handlers;
}

const SESSION = 's-surprise-residue';

function tok(id: string): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
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
  };
}

function combatant(tokenId: string, surprised: boolean): Combatant {
  return {
    tokenId,
    characterId: null,
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    surprised,
  } as unknown as Combatant;
}

function seedCombat(openerSurprised: boolean) {
  const room = createRoom(SESSION, 'ROOM-SR', 'dm-user');
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  room.tokens.set('ambusher', tok('ambusher'));
  room.tokens.set('alice', tok('alice'));
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [combatant('ambusher', openerSurprised), combatant('alice', false)],
    startedAt: new Date().toISOString(),
  } as CombatState;
  return room;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('combat:lock-initiative — surprised opener', () => {
  it('advances past a surprised slot-0 combatant and broadcasts the turn pointer', async () => {
    const room = seedCombat(true);
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('combat:lock-initiative')!({});

    expect(em.some((e) => e.event === 'combat:review-complete')).toBe(true);
    const adv = em.find((e) => e.event === 'combat:turn-advanced');
    expect(adv).toBeDefined();
    const payload = adv!.payload as { currentTokenId: string | null; roundNumber: number };
    expect(payload.currentTokenId).toBe('alice'); // skipped the ambusher
    expect(payload.roundNumber).toBe(1);
    expect(room.combatState!.currentTurnIndex).toBe(1);
  });

  it('does nothing extra when the opener is not surprised', async () => {
    const room = seedCombat(false);
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('combat:lock-initiative')!({});

    expect(em.some((e) => e.event === 'combat:review-complete')).toBe(true);
    expect(em.some((e) => e.event === 'combat:turn-advanced')).toBe(false);
    expect(room.combatState!.currentTurnIndex).toBe(0);
  });
});

describe('endCombat — per-fight residue', () => {
  it('clears combat caches and round-relative conditionMeta, keeps scene-real meta', async () => {
    const room = seedCombat(false);
    // Populate every per-fight cache.
    room.tokenMeleeReach.set('ambusher', 2);
    room.mobileMeleeTargets.set('ambusher', new Set(['alice']));
    room.polearmMasters.add('alice');
    room.lairActionTokens.add('ambusher');
    room.legendaryActions.set('ambusher', { max: 3, remaining: 1 });
    room.rechargePools.set('ambusher', new Map([['breath', { min: 5, available: false }]]));
    // Meta: one round-relative buff, one save-retry condition, one manual.
    room.conditionMeta.set(
      'alice',
      new Map([
        ['blessed', { name: 'blessed', source: 'Bless', appliedRound: 12, expiresAfterRound: 21 }],
        [
          'restrained',
          {
            name: 'restrained',
            source: 'Hold Person',
            appliedRound: 12,
            saveAtEndOfTurn: { ability: 'wis', dc: 14 },
          },
        ],
        ['grappled', { name: 'grappled', source: 'manual', appliedRound: 12 }],
      ]) as never
    );

    await CombatService.endCombat(SESSION);

    expect(room.combatState).toBeNull();
    expect(room.tokenMeleeReach.size).toBe(0);
    expect(room.mobileMeleeTargets.size).toBe(0);
    expect(room.polearmMasters.size).toBe(0);
    expect(room.lairActionTokens.size).toBe(0);
    expect(room.legendaryActions.size).toBe(0);
    expect(room.rechargePools.size).toBe(0);
    const meta = room.conditionMeta.get('alice')!;
    expect(meta.has('blessed')).toBe(false); // round-relative → cleared
    expect(meta.has('restrained')).toBe(false); // save-retry → cleared
    expect(meta.has('grappled')).toBe(true); // scene-real → kept
  });
});
