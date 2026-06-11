import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Token, Combatant } from '@dnd-vtt/shared';
import { pullStateSnapshot } from './stateSnapshot';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { recordEventId, resetEventCursor } from './eventCursor';

/**
 * Regression: the 15s /state reconciler must NOT wipe real local state when
 * the server returns its "no room on this instance" fallback (empty snapshot,
 * nextEventId 0) — which happens on a Cloud Run session-affinity miss or an
 * instance that just restarted. nextEventId is monotonic, so a session that
 * ever had activity reports > 0; only the fallback (or a pristine room) is 0.
 */

function tok(id: string): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name: id,
    x: 1,
    y: 1,
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
    createdAt: new Date(0).toISOString(),
  } as Token;
}

function mockState(body: unknown, etag?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? (etag ?? null) : null) },
      json: async () => body,
    }))
  );
}

describe('pullStateSnapshot — no-room fallback guard', () => {
  beforeEach(() => {
    resetEventCursor();
    useSessionStore.setState({ sessionId: 's1' } as never);
    useMapStore.setState({ tokens: {}, currentMap: { id: 'map-1' } } as never);
    useCombatStore.setState({ active: false } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does NOT wipe local tokens on an empty no-room snapshot (nextEventId 0)', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    mockState({ tokens: [], combat: null, characters: {}, nextEventId: 0, roundNumber: 0 });
    const res = await pullStateSnapshot();
    expect(res.applied).toBe(false);
    expect(Object.keys(useMapStore.getState().tokens)).toEqual(['t1']);
  });

  it('still reconciles a genuinely-empty AUTHORITATIVE snapshot (nextEventId > 0)', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    mockState(
      { tokens: [], combat: null, characters: {}, nextEventId: 7, roundNumber: 0 },
      'W/"v1"'
    );
    const res = await pullStateSnapshot();
    expect(res.applied).toBe(true);
    expect(Object.keys(useMapStore.getState().tokens)).toEqual([]);
  });

  it('does NOT wipe current-map tokens when an empty snapshot is for another map', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'dm-preview' } } as never);
    mockState(
      {
        mapId: 'player-ribbon',
        tokens: [],
        combat: null,
        characters: {},
        nextEventId: 7,
        roundNumber: 0,
      },
      'W/"v2"'
    );

    const res = await pullStateSnapshot();

    expect(res.applied).toBe(true);
    expect(Object.keys(useMapStore.getState().tokens)).toEqual(['t1']);
  });

  it('clears stale tokens when an empty snapshot is explicitly for the current map', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: null,
        characters: {},
        nextEventId: 7,
        roundNumber: 0,
      },
      'W/"v3"'
    );

    const res = await pullStateSnapshot();

    expect(res.applied).toBe(true);
    expect(Object.keys(useMapStore.getState().tokens)).toEqual([]);
  });
});

function combatant(tokenId: string): Combatant {
  return {
    tokenId,
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 10,
    maxHp: 10,
    ac: 12,
    isPlayer: false,
    conditions: [],
  } as unknown as Combatant;
}

/**
 * Regression set 2 — the destructive snapshot reconcile.
 * A combat diff used to call startCombat(), which reset the damage log
 * (recap data), action economy, review phase, and combat clock on every
 * hidden-ambusher reveal / reinforcement / poll-vs-turn-advance race.
 * And a stale /state response (HTTP overtaken by live websocket events)
 * used to apply anyway, rubber-banding tokens and rewinding combat.
 */
describe('pullStateSnapshot — staleness guard', () => {
  beforeEach(() => {
    resetEventCursor();
    useSessionStore.setState({ sessionId: 's1' } as never);
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    useCombatStore.setState({ active: false } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('discards a snapshot older than already-applied live events', async () => {
    recordEventId(10); // live events through id 10 already applied
    const moved = { ...tok('t1'), x: 999 };
    mockState({
      mapId: 'map-1',
      tokens: [moved],
      combat: null,
      characters: {},
      nextEventId: 5,
      roundNumber: 0,
    });
    const res = await pullStateSnapshot();
    expect(res.applied).toBe(false);
    expect(useMapStore.getState().tokens['t1'].x).toBe(1); // no rubber-band
  });

  it('applies a snapshot at the same event point as the cursor', async () => {
    recordEventId(7);
    const moved = { ...tok('t1'), x: 999 };
    mockState(
      {
        mapId: 'map-1',
        tokens: [moved],
        combat: null,
        characters: {},
        nextEventId: 7,
        roundNumber: 0,
      },
      'W/"s1"'
    );
    const res = await pullStateSnapshot();
    expect(res.applied).toBe(true);
    expect(useMapStore.getState().tokens['t1'].x).toBe(999);
  });
});

describe('pullStateSnapshot — non-destructive combat merge', () => {
  beforeEach(() => {
    resetEventCursor();
    useSessionStore.setState({ sessionId: 's1' } as never);
    useMapStore.setState({ tokens: {}, currentMap: { id: 'map-1' } } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves damage log, action economy, and review phase when a reinforcement arrives', async () => {
    const economy = {
      action: true,
      bonusAction: false,
      movementRemaining: 10,
      movementMax: 30,
      reaction: false,
    };
    useCombatStore.setState({
      active: true,
      roundNumber: 3,
      currentTurnIndex: 1,
      combatants: [combatant('a'), combatant('b')],
      damageLog: [{ round: 2, attacker: 'a', target: 'b', amount: 7 }] as never,
      actionEconomy: economy as never,
      reviewPhase: true,
      combatStartTime: 12345,
    } as never);

    // Server now reports THREE combatants (DM added a goblin / revealed an ambusher).
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: {
          active: true,
          roundNumber: 3,
          currentTurnIndex: 1,
          combatants: [combatant('a'), combatant('b'), combatant('goblin')],
          startedAt: 0,
        },
        characters: {},
        nextEventId: 9,
        roundNumber: 3,
      },
      'W/"m1"'
    );

    const res = await pullStateSnapshot();
    expect(res.applied).toBe(true);
    const cs = useCombatStore.getState();
    expect(cs.combatants).toHaveLength(3); // merged
    expect(cs.damageLog).toHaveLength(1); // PRESERVED (was wiped)
    expect(cs.actionEconomy).toEqual(economy); // PRESERVED (was reset to default)
    expect(cs.reviewPhase).toBe(true); // PRESERVED (was closed)
    expect(cs.combatStartTime).toBe(12345); // PRESERVED (was reset)
  });

  it('adopts the server turn/round on a missed turn-advance without wiping the log', async () => {
    useCombatStore.setState({
      active: true,
      roundNumber: 3,
      currentTurnIndex: 1,
      combatants: [combatant('a'), combatant('b')],
      damageLog: [{ round: 2 }] as never,
    } as never);
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: {
          active: true,
          roundNumber: 4,
          currentTurnIndex: 0,
          combatants: [combatant('a'), combatant('b')],
          startedAt: 0,
        },
        characters: {},
        nextEventId: 9,
        roundNumber: 4,
      },
      'W/"m2"'
    );
    await pullStateSnapshot();
    const cs = useCombatStore.getState();
    expect(cs.roundNumber).toBe(4);
    expect(cs.currentTurnIndex).toBe(0);
    expect(cs.damageLog).toHaveLength(1);
  });

  it('adopts same-count combatant changes without wiping the log', async () => {
    useCombatStore.setState({
      active: true,
      roundNumber: 3,
      currentTurnIndex: 1,
      combatants: [combatant('a'), combatant('b')],
      damageLog: [{ round: 2 }] as never,
    } as never);
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: {
          active: true,
          roundNumber: 3,
          currentTurnIndex: 1,
          combatants: [combatant('a'), { ...combatant('b'), hp: 4 }],
          startedAt: 0,
        },
        characters: {},
        nextEventId: 9,
        roundNumber: 3,
      },
      'W/"m2b"'
    );
    await pullStateSnapshot();
    const cs = useCombatStore.getState();
    expect(cs.combatants[1].hp).toBe(4);
    expect(cs.damageLog).toHaveLength(1);
  });

  it('still does a full startCombat when combat begins while desynced', async () => {
    useCombatStore.setState({ active: false, damageLog: [{ round: 1 }] as never } as never);
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: {
          active: true,
          roundNumber: 1,
          currentTurnIndex: 2,
          combatants: [combatant('a'), combatant('b'), combatant('c')],
          startedAt: 0,
        },
        characters: {},
        nextEventId: 4,
        roundNumber: 1,
      },
      'W/"m3"'
    );
    await pullStateSnapshot();
    const cs = useCombatStore.getState();
    expect(cs.active).toBe(true);
    expect(cs.currentTurnIndex).toBe(2); // server's cursor, not 0
    expect(cs.damageLog).toHaveLength(0); // fresh fight, fresh log
  });
});

describe('pullStateSnapshot — widened token diff', () => {
  beforeEach(() => {
    resetEventCursor();
    useSessionStore.setState({ sessionId: 's1' } as never);
    useCombatStore.setState({ active: false } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('detects a light change (previously never self-healed)', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    const lit = { ...tok('t1'), hasLight: true, lightRadius: 4 };
    mockState(
      {
        mapId: 'map-1',
        tokens: [lit],
        combat: null,
        characters: {},
        nextEventId: 3,
        roundNumber: 0,
      },
      'W/"d1"'
    );
    await pullStateSnapshot();
    expect(useMapStore.getState().tokens['t1'].hasLight).toBe(true);
    expect(useMapStore.getState().tokens['t1'].lightRadius).toBe(4);
  });

  it('detects a rename and ownership change', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    const renamed = { ...tok('t1'), name: 'Boss', ownerUserId: 'u9' };
    mockState(
      {
        mapId: 'map-1',
        tokens: [renamed],
        combat: null,
        characters: {},
        nextEventId: 3,
        roundNumber: 0,
      },
      'W/"d2"'
    );
    await pullStateSnapshot();
    expect(useMapStore.getState().tokens['t1'].name).toBe('Boss');
    expect(useMapStore.getState().tokens['t1'].ownerUserId).toBe('u9');
  });
});

/**
 * Regression set 3 — the hidden-ambusher turn pointer (audit #7).
 * Players receive visibility-FILTERED combatant lists but the server's
 * raw currentTurnIndex indexes the UNFILTERED array: with a hidden
 * monster at slot 0, every player's tracker highlighted the wrong row,
 * the camera panned to the wrong token, and "your turn" fired early.
 * The server now also sends position-independent currentTokenId;
 * clients resolve it against their own list.
 */
import { resolveTurnIndex } from '../stores/useCombatStore';

describe('resolveTurnIndex', () => {
  const filtered = [combatant('alice'), combatant('bob')];

  it('resolves by tokenId against the local (filtered) list', () => {
    // Server list: [hidden, alice, bob], raw index 1 (= alice).
    // Player list: [alice, bob] — alice is local index 0, not 1.
    expect(resolveTurnIndex(filtered, 'alice', 1)).toBe(0);
    expect(resolveTurnIndex(filtered, 'bob', 2)).toBe(1);
  });

  it('returns -1 when the current combatant is hidden from this client', () => {
    expect(resolveTurnIndex(filtered, 'hidden-monster', 0)).toBe(-1);
  });

  it('falls back to the raw index for payloads without the field', () => {
    expect(resolveTurnIndex(filtered, undefined, 1)).toBe(1);
    expect(resolveTurnIndex(filtered, null, 0)).toBe(0);
  });
});

describe('pullStateSnapshot — tokenId-based turn pointer', () => {
  beforeEach(() => {
    resetEventCursor();
    useSessionStore.setState({ sessionId: 's1' } as never);
    useMapStore.setState({ tokens: {}, currentMap: { id: 'map-1' } } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolves the ambush scenario: filtered list + raw index disagree', async () => {
    useCombatStore.setState({ active: false } as never);
    // Server array is [hidden, alice, bob] with raw index 1 (alice's
    // turn); this player's filtered payload only has [alice, bob].
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: {
          active: true,
          roundNumber: 1,
          currentTurnIndex: 1,
          currentTokenId: 'alice',
          combatants: [combatant('alice'), combatant('bob')],
          startedAt: 0,
        },
        characters: {},
        nextEventId: 5,
        roundNumber: 1,
      },
      'W/"t1"'
    );
    await pullStateSnapshot();
    const cs = useCombatStore.getState();
    // Raw index 1 would have highlighted BOB; resolution lands on alice.
    expect(cs.currentTurnIndex).toBe(0);
    expect(cs.combatants[cs.currentTurnIndex].tokenId).toBe('alice');
  });

  it('highlights nothing when the current combatant is hidden from this client', async () => {
    useCombatStore.setState({
      active: true,
      roundNumber: 2,
      currentTurnIndex: 0,
      combatants: [combatant('alice'), combatant('bob')],
      damageLog: [] as never,
    } as never);
    mockState(
      {
        mapId: 'map-1',
        tokens: [],
        combat: {
          active: true,
          roundNumber: 2,
          currentTurnIndex: 0,
          currentTokenId: 'hidden-monster',
          combatants: [combatant('alice'), combatant('bob')],
          startedAt: 0,
        },
        characters: {},
        nextEventId: 6,
        roundNumber: 2,
      },
      'W/"t2"'
    );
    await pullStateSnapshot();
    expect(useCombatStore.getState().currentTurnIndex).toBe(-1); // no wrong highlight
  });
});
