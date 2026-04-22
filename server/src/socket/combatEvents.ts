import type { Server, Socket } from 'socket.io';
import { registerCombatLifecycle } from './combat/lifecycleEvents.js';
import { registerCombatInitiative } from './combat/initiativeEvents.js';
import { registerCombatHp } from './combat/hpEvents.js';
import { registerCombatActions } from './combat/actionEvents.js';
import { registerCombatReactions } from './combat/reactionEvents.js';
import { registerCombatConditions } from './combat/conditionEvents.js';

/**
 * Top-level combat-event registrar. The old 1455-line monolith here
 * was split (Apr 2026) into per-concern modules under `combat/` so
 * PRs touching "damage" don't collide with PRs touching "reactions"
 * or "initiative". Each sub-register wires its own `socket.on` hooks
 * against the same shared `io` / `socket` handles.
 *
 * Sub-modules:
 *   lifecycleEvents   \u2014 start / ready-check / add-combatant / end
 *   initiativeEvents  \u2014 roll / set / surprise / next-turn + ticks
 *   hpEvents          \u2014 damage / heal / death save
 *   actionEvents      \u2014 use-action / use-movement / dash
 *   reactionEvents    \u2014 OA, counterspell, shield, cast-spell animation
 *   conditionEvents   \u2014 condition CRUD + damage:side-effects +
 *                       concentration:dropped
 */
export function registerCombatEvents(io: Server, socket: Socket): void {
  registerCombatLifecycle(io, socket);
  registerCombatInitiative(io, socket);
  registerCombatHp(io, socket);
  registerCombatActions(io, socket);
  registerCombatReactions(io, socket);
  registerCombatConditions(io, socket);
}
