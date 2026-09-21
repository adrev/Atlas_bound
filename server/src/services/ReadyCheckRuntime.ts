import type { Server } from 'socket.io';
import { afterCommit, outsideTransaction } from '../db/transactionContext.js';
import { getRoom, type RoomState } from '../utils/roomState.js';
import { startCombat } from '../socket/combat/startCombatHelper.js';
import { sessionRuntimeConfigured, withSessionRuntime } from './SessionRuntime.js';

export function assertReadyCheckTokens(room: RoomState, tokenIds: string[]): void {
  if (tokenIds.length === 0 || tokenIds.some((id) => !room.tokens.has(id))) {
    throw new Error('Ready check requires existing combat tokens; select them again');
  }
}

/**
 * Safe during hydration or a ready-check mutation: only schedule after COMMIT.
 * The effect must remain synchronous; awaiting another session transaction here
 * would wait on the same local queue that is still delivering commit effects.
 */
export function armReadyCheckTimer(room: RoomState, io: Server, minDelayMs = 0): void {
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0)
    throw new Error('Invalid ready-check retry delay');
  const check = room.readyCheck;
  if (!check?.id || !Number.isSafeInteger(check.deadline) || check.deadline! < 0) return;
  const { id } = check;
  const deadline = check.deadline!;
  afterCommit(() => {
    const current = room.readyCheck;
    if (getRoom(room.sessionId) !== room || current?.id !== id || current.deadline !== deadline)
      return;
    if (current.timeout) clearTimeout(current.timeout);
    if (room.combatState?.active) {
      current.timeout = null;
      return;
    }
    // A rollback may restore an overdue check. Delay that retry without moving
    // its durable deadline, so persistent failures cannot spin a zero-ms loop.
    const delay = Math.min(2_147_483_647, Math.max(minDelayMs, deadline - Date.now(), 0));
    // Timer callbacks must not inherit the transaction that scheduled them.
    const timeout = outsideTransaction(() =>
      setTimeout(() => {
        if (getRoom(room.sessionId) !== room || room.readyCheck?.timeout !== timeout) return;
        room.readyCheck.timeout = null;
        const complete = async () => {
          // withSessionRuntime hydrates the latest durable check while holding
          // its cross-instance lock. Object identity alone cannot fence a reload.
          const latest = getRoom(room.sessionId);
          const ready = latest?.readyCheck;
          if (latest !== room || ready?.id !== id || ready.deadline !== deadline) return;
          if (Date.now() < deadline) {
            armReadyCheckTimer(latest, io);
            return;
          }
          if (latest.combatState?.active) {
            if (ready.timeout) clearTimeout(ready.timeout);
            latest.readyCheck = null;
            return;
          }
          assertReadyCheckTokens(latest, ready.tokenIds);
          await startCombat(io, room.sessionId, [...ready.tokenIds]);
          io.to(room.sessionId).emit('combat:ready-check-complete', {});
        };
        // Standalone handler unit tests do not configure the DB event executor.
        const completion = sessionRuntimeConfigured()
          ? withSessionRuntime(room.sessionId, complete)
          : complete();
        void completion.catch((error: unknown) => {
          console.error('[READY CHECK] auto-start combat error:', error);
        });
      }, delay)
    );
    current.timeout = timeout;
    timeout.unref?.();
  });
}
