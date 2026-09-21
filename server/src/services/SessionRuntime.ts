import type { Server, Socket } from 'socket.io';
import type { Combatant } from '@dnd-vtt/shared';
import pool, { rawPool } from '../db/connection.js';
import { inTransaction } from '../db/transactionContext.js';
import {
  createRoom,
  getRoom,
  getPlayerBySocketId,
  removeSocketFromRoom,
  type RoomState,
} from '../utils/roomState.js';
import type { SocketOperationOptions } from '../utils/socketHelpers.js';
import { sessionJoinSchema } from '../utils/validation.js';
import { armReadyCheckTimer } from './ReadyCheckRuntime.js';
import { snapshotRoom, restoreRoom, type RoomSnapshot } from '../utils/roomSnapshot.js';
import { rowToToken } from '../utils/tokenMapper.js';
import { withConditionSources } from '../utils/conditionSources.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { reconcileCharacterCombatState } from './CharacterUpdateService.js';
import {
  loadFeatureRuntime,
  runWithFeatureRuntime,
  saveFeatureRuntime,
  hydrateFeaturePointPools,
  captureFeaturePointPools,
} from '../utils/featureRuntime.js';

const queues = new Map<string, Promise<unknown>>();
const socketQueues = new Map<string, Promise<unknown>>();
let draining = false;
let io: Server | undefined;
let configured = false;

export function configureSessionRuntime(server?: Server): void {
  io = server;
  configured = true;
}
export function sessionRuntimeConfigured(): boolean {
  return configured;
}

export async function drainSessionRuntime(): Promise<void> {
  draining = true;
  await Promise.allSettled([...socketQueues.values(), ...queues.values()]);
}

async function refreshRoom(sessionId: string, preserveSocket?: Socket): Promise<RoomState> {
  const { rows: sessions } = await pool.query('SELECT * FROM sessions WHERE id = $1 FOR SHARE', [
    sessionId,
  ]);
  const session = sessions[0];
  if (!session) throw new Error('Session no longer exists');
  const room = getRoom(sessionId) ?? createRoom(sessionId, session.room_code, session.dm_user_id);
  const { rows } = await pool.query('SELECT state FROM session_runtime WHERE session_id = $1', [
    sessionId,
  ]);
  if (rows[0]) {
    restoreRoom(room, rows[0].state as RoomSnapshot);
  } else {
    const { rows: combatRows } = await pool.query(
      'SELECT * FROM combat_state WHERE session_id = $1',
      [sessionId]
    );
    const combat = combatRows[0];
    if (combat) {
      const combatants = safeParseJSON<Combatant[] | null>(
        combat.combatants,
        null,
        'combat_state.combatants'
      );
      if (!combatants) throw new Error('Cannot restore saved combat');
      room.combatState = {
        sessionId,
        active: true,
        roundNumber: combat.round_number,
        currentTurnIndex: combat.current_turn_index,
        combatants,
        startedAt: combat.started_at,
      };
      // Legacy memory-only turn budgets cannot be inferred. Do not grant free
      // actions on migration; the DM can advance the turn to reset explicitly.
      for (const actor of combatants)
        room.actionEconomies.set(actor.tokenId, {
          action: true,
          bonusAction: true,
          reaction: true,
          movementRemaining: 0,
          movementMax: actor.speed,
        });
    }
  }
  room.dmUserId = session.dm_user_id;
  const settings = safeParseJSON<Record<string, unknown>>(
    session.settings,
    {},
    'sessions.settings'
  );
  room.showCreatureStatsToPlayers = settings.showCreatureStatsToPlayers === true;
  room.showPlayersToPlayers = settings.showPlayersToPlayers === true;
  room.playerMapId = session.player_map_id ?? null;
  room.currentMapId = session.current_map_id ?? null;
  room.gameMode = room.combatState?.active ? 'combat' : 'free-roam';
  const { rows: maps } = await pool.query('SELECT id, grid_size FROM maps WHERE session_id = $1', [
    sessionId,
  ]);
  room.mapGridSizes = new Map(maps.map((map) => [map.id, Number(map.grid_size) || 70]));
  for (const [userId, mapId] of room.dmViewingMap)
    if (!room.mapGridSizes.has(mapId)) room.dmViewingMap.delete(userId);
  const { rows: tokens } = await pool.query(
    'SELECT t.* FROM tokens t JOIN maps m ON m.id = t.map_id WHERE m.session_id = $1',
    [sessionId]
  );
  room.tokens = new Map(
    tokens.map((row) => {
      const token = withConditionSources(room, rowToToken(row));
      return [token.id, token];
    })
  );
  const characterIds = new Set<string>();
  for (const token of room.tokens.values())
    if (token.characterId) characterIds.add(token.characterId);
  for (const actor of room.combatState?.combatants ?? [])
    if (actor.characterId) characterIds.add(actor.characterId);
  const { rows: members } = await pool.query(
    'SELECT sp.*, u.display_name FROM session_players sp JOIN users u ON u.id = sp.user_id WHERE session_id = $1',
    [sessionId]
  );
  for (const member of members) if (member.character_id) characterIds.add(member.character_id);
  // Stable locks also serialize REST character edits with room read/modify/
  // writes. A fresh version alone cannot protect a stale checkpoint HP value.
  if (characterIds.size) {
    const { rows: characters } = await pool.query(
      'SELECT * FROM characters WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
      [[...characterIds].sort()]
    );
    reconcileCharacterCombatState(room, characters);
  }
  // Presence is transport state, rebuilt rather than checkpointed. The adapter
  // includes sockets on other instances; authority always comes from SQL roles.
  if (io) {
    const previousUsers = new Set(room.players.keys());
    const sockets = await io.in(sessionId).fetchSockets();
    for (const s of sockets) {
      if (!members.some((m) => m.user_id === s.data.userId)) await s.leave(sessionId);
    }
    room.players.clear();
    room.userSockets.clear();
    const online = sockets.map((s) => ({ id: s.id, userId: s.data.userId as string }));
    if (preserveSocket && !online.some((s) => s.id === preserveSocket.id)) {
      online.push({ id: preserveSocket.id, userId: preserveSocket.data.userId as string });
    }
    for (const s of online) {
      const member = members.find((m) => m.user_id === s.userId);
      if (!member) continue;
      const ids = room.userSockets.get(s.userId) ?? new Set<string>();
      ids.add(s.id);
      room.userSockets.set(s.userId, ids);
      room.players.set(s.userId, {
        userId: s.userId,
        displayName: member.display_name,
        socketId: s.id,
        role: member.role,
        characterId: member.character_id,
      });
    }
    // A remote join may have reached browsers without touching this process's
    // cache. Reconcile offline SQL members too after an ungraceful remote exit.
    for (const member of members) previousUsers.add(member.user_id as string);
    for (const userId of previousUsers) {
      if (!room.players.has(userId)) io.to(sessionId).emit('session:player-left', { userId });
    }
  } else {
    for (const [id, player] of room.players) {
      const member = members.find((m) => m.user_id === id);
      if (!member) room.players.delete(id);
      else {
        player.role = member.role;
        player.characterId = member.character_id;
      }
    }
  }
  return room;
}

/** SQL lock serializes writers across instances; local queue protects mutable
 * room objects while awaits yield within one process. Reload before each turn. */
export function withSessionRuntime<T>(
  sessionId: string,
  operation: () => Promise<T>,
  socket?: Socket
): Promise<T> {
  if (draining) return Promise.reject(new Error('Server is restarting; reconnect to continue'));
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      let room: RoomState | undefined;
      let before: RoomSnapshot | undefined;
      let tokenBackup: RoomState['tokens'] | undefined;
      let pointPoolBackup: RoomState['pointPools'] | undefined;
      let drawingBackup: RoomState['drawings'] | undefined;
      let mapPointers: Pick<RoomState, 'currentMapId' | 'playerMapId'> | undefined;
      try {
        return await inTransaction(rawPool, async () => {
          await pool.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `atlas-session:${sessionId}`,
          ]);
          room = await refreshRoom(sessionId, socket);
          before = snapshotRoom(room);
          tokenBackup = structuredClone(room.tokens);
          drawingBackup = structuredClone(room.drawings);
          mapPointers = { currentMapId: room.currentMapId, playerMapId: room.playerMapId };
          const { rows: characters } = await pool.query(
            `SELECT character_id AS id FROM session_players
          WHERE session_id = $1 AND character_id IS NOT NULL
          UNION SELECT t.character_id AS id FROM tokens t JOIN maps m ON m.id = t.map_id
          WHERE m.session_id = $1 AND t.character_id IS NOT NULL`,
            [sessionId]
          );
          const features = await loadFeatureRuntime(
            pool.query.bind(pool),
            sessionId,
            characters.map((c) => c.id as string)
          );
          room.pointPools = hydrateFeaturePointPools(features);
          pointPoolBackup = structuredClone(room.pointPools);
          return runWithFeatureRuntime(features, async () => {
            const result = await operation();
            captureFeaturePointPools(features, room!.pointPools);
            await saveFeatureRuntime(pool.query.bind(pool), features);
            if (io) armReadyCheckTimer(room!, io);
            // Deleted sessions cascade their runtime. Never resurrect a deleted room.
            const state = snapshotRoom(room!);
            await pool.query(
              `INSERT INTO session_runtime (session_id, state) SELECT id, $2::jsonb FROM sessions WHERE id = $1
            ON CONFLICT (session_id) DO UPDATE SET state = EXCLUDED.state,
              version = session_runtime.version + 1, updated_at = NOW()`,
              [sessionId, JSON.stringify(state)]
            );
            return result;
          });
        });
      } catch (error) {
        if (room && before) restoreRoom(room, before);
        if (room && tokenBackup) room.tokens = tokenBackup;
        if (room && pointPoolBackup) room.pointPools = pointPoolBackup;
        if (room && drawingBackup) room.drawings = drawingBackup;
        if (room && mapPointers) Object.assign(room, mapPointers);
        // Discard a failed attempt's timer, but retain the restored committed
        // check and its original deadline rather than inventing a new check.
        if (room?.readyCheck?.timeout) clearTimeout(room.readyCheck.timeout);
        if (room?.readyCheck) room.readyCheck.timeout = null;
        if (room && io) armReadyCheckTimer(room, io, 5_000);
        throw error;
      }
    });
  queues.set(sessionId, next);
  void next
    .finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    })
    .catch(() => {});
  return next;
}

export function runSocketOperation(
  socket: Socket,
  data: unknown,
  operation: () => Promise<void>,
  options?: SocketOperationOptions
): Promise<void> {
  // Resolve membership only after prior leave/join events on this socket finish.
  const previous = socketQueues.get(socket.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const oldSessionId = getPlayerBySocketId(socket.id)?.room.sessionId;
      let sessionId = oldSessionId;
      if (options?.join) {
        const parsed = sessionJoinSchema.safeParse(data);
        if (!parsed.success) return operation();
        const { rows } = await pool.query(
          `SELECT s.id FROM sessions s JOIN session_players sp ON sp.session_id = s.id
        WHERE s.room_code = $1 AND sp.user_id = $2`,
          [parsed.data.roomCode, socket.data.userId]
        );
        sessionId = rows[0]?.id;
        if (!sessionId) return operation();
        if (oldSessionId && oldSessionId !== sessionId) {
          await withSessionRuntime(
            oldSessionId,
            async () => {
              const left = removeSocketFromRoom(oldSessionId, socket.id);
              await socket.leave(oldSessionId);
              if (left?.userFullyLeft)
                socket.to(oldSessionId).emit('session:player-left', { userId: left.userId });
            },
            socket
          );
        }
      }
      if (!sessionId) return operation();
      return withSessionRuntime(sessionId, operation, socket);
    });
  socketQueues.set(socket.id, next);
  void next
    .finally(() => {
      if (socketQueues.get(socket.id) === next) socketQueues.delete(socket.id);
    })
    .catch(() => {});
  return next;
}
