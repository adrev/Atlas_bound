/**
 * Handler-level coverage for opportunity-attack PROMPT fan-out
 * (`combat:oa-opportunity`), emitted from inside `map:token-move` when a
 * move provokes an OA during active combat.
 *
 * Unlike the HP/condition/reaction emits — which route through the shared,
 * already-tested `emitToTokenViewers` chokepoint — the OA prompt uses a
 * BESPOKE manual fan-out in `tokenEvents.ts`: it walks `room.userSockets`
 * to reach every tab of the attacker's owner plus every DM tab, deduped.
 * That hand-rolled path (the "#1 combat support ask" per the handler's own
 * log comment) had no socket-level test, so this file pins its scoping:
 *
 *  • An NPC attacker (no owner) → DM sockets only; never players.
 *  • A PC attacker → the owner's every open tab + the DM, never bystanders.
 *  • No prompt at all unless combat is active.
 *
 * The OA *detection* geometry is already covered in `combat-bugfixes.test.ts`,
 * so we mock `detectOpportunityAttacks` to inject a synthetic opportunity and
 * exercise ONLY the fan-out. We drive the move as the DM so ownership/turn
 * gating doesn't interfere, and move a token that is NOT the current
 * combatant so the movement-spend path stays out of the way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import type { CombatState, Token } from '@dnd-vtt/shared';
import type { OAOpportunity } from '../services/OpportunityAttackService.js';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
// Inject synthetic opportunities; geometry is tested elsewhere.
vi.mock('../services/OpportunityAttackService.js', () => ({
  detectOpportunityAttacks: vi.fn(() => [] as OAOpportunity[]),
}));

import { registerTokenEvents } from '../socket/tokenEvents.js';
import * as OAService from '../services/OpportunityAttackService.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }

function makeHarness(actorSocketId: string) {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const emissions: Emission[] = [];
  const record = (channelId: string) => ({
    emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
  });
  const io = { to: record } as unknown as Server;
  const socket = {
    id: actorSocketId,
    on: (event: string, handler: (d: unknown) => Promise<void> | void) => { handlers[event] = handler; },
    emit: (event: string, payload: unknown) => emissions.push({ channelId: actorSocketId, event, payload }),
    join: () => {},
    to: record,
  } as unknown as Socket;
  return { io, socket, handlers, emissions };
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id, mapId: 'map-1', characterId: null, name: id,
    x: 0, y: 0, size: 1, imageUrl: null, color: '#000',
    layer: 'token', visible: true, hasLight: false,
    lightRadius: 0, lightDimRadius: 0, lightColor: '#fff',
    conditions: [], ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const SESSION = 's-oa-fanout';

/**
 * Combat room: DM (1 tab), the OA attacker's owner across TWO tabs
 * (multi-tab), and an uninvolved bystander player — all on ribbon map-1.
 * A DM-controlled `mover` token provokes; the synthetic opportunity is
 * injected via the mock so only the fan-out is exercised. The current
 * combatant is a separate `turn-token`, so moving `mover` skips the
 * movement-spend path.
 */
function seedRoom(): void {
  const room = createRoom(SESSION, 'ROOM-OA', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'combat';
  room.mapGridSizes.set('map-1', 70);
  room.tokens.set('mover', token('mover', { name: 'Mover' }));
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [{
      tokenId: 'turn-token', characterId: null, name: 'Turn', initiative: 20,
      initiativeBonus: 0, hp: 30, maxHp: 30, tempHp: 0, armorClass: 15,
      speed: 30, isNPC: true, conditions: [], deathSaves: { successes: 0, failures: 0 },
      portraitUrl: null,
    }],
    startedAt: new Date().toISOString(),
  } satisfies CombatState;
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  // Attacker owner, two open tabs (multi-tab fan-out target).
  addPlayerToRoom(SESSION, { userId: 'attacker-user', displayName: 'Atk', socketId: 'atk-sock-1', role: 'player', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'attacker-user', displayName: 'Atk', socketId: 'atk-sock-2', role: 'player', characterId: null });
  // Uninvolved bystander — must never receive the prompt.
  addPlayerToRoom(SESSION, { userId: 'bystander-user', displayName: 'Bys', socketId: 'bystander-sock', role: 'player', characterId: null });
}

function oppFrom(attackerOwnerUserId: string | null): OAOpportunity {
  return {
    attackerTokenId: 'attacker-token',
    attackerName: 'Attacker',
    attackerOwnerUserId,
    moverTokenId: 'mover',
    moverName: 'Mover',
  };
}

function oaChannels(emissions: Emission[]): string[] {
  return emissions
    .filter((e) => e.event === 'combat:oa-opportunity')
    .map((e) => e.channelId)
    .sort();
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  vi.mocked(OAService.detectOpportunityAttacks).mockReset();
  vi.mocked(OAService.detectOpportunityAttacks).mockReturnValue([]);
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('combat:oa-opportunity — OA prompt fan-out', () => {
  it("an NPC attacker's OA prompt reaches DM sockets only — never players", async () => {
    seedRoom();
    vi.mocked(OAService.detectOpportunityAttacks).mockReturnValue([oppFrom(null)]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'mover', x: 140, y: 0 });

    expect(oaChannels(emissions)).toEqual(['dm-sock']);
  });

  it("a PC attacker's OA prompt reaches the owner's every tab + the DM, but not bystanders", async () => {
    seedRoom();
    vi.mocked(OAService.detectOpportunityAttacks).mockReturnValue([oppFrom('attacker-user')]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'mover', x: 140, y: 0 });

    expect(oaChannels(emissions)).toEqual(['atk-sock-1', 'atk-sock-2', 'dm-sock']);
    expect(oaChannels(emissions)).not.toContain('bystander-sock');
  });

  it('emits the OA prompt to each recipient exactly once (no duplicate fan-out)', async () => {
    seedRoom();
    vi.mocked(OAService.detectOpportunityAttacks).mockReturnValue([oppFrom('attacker-user')]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'mover', x: 140, y: 0 });

    const channels = oaChannels(emissions);
    expect(channels).toEqual(Array.from(new Set(channels)).sort());
  });

  it('fires no OA prompt when combat is not active (detector never consulted)', async () => {
    seedRoom();
    getAllRooms().get(SESSION)!.combatState!.active = false;
    vi.mocked(OAService.detectOpportunityAttacks).mockReturnValue([oppFrom('attacker-user')]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'mover', x: 140, y: 0 });

    expect(oaChannels(emissions)).toEqual([]);
    expect(OAService.detectOpportunityAttacks).not.toHaveBeenCalled();
  });
});
