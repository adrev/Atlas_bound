import { v4 as uuidv4 } from 'uuid';
import type { Server } from 'socket.io';
import * as CombatService from '../../services/CombatService.js';
import * as DiscordService from '../../services/DiscordService.js';

/**
 * Shared between the `combat:start` handler and the `combat:ready-check`
 * auto-start path. Creates combat state, emits all combat-start events,
 * announces the initiative order, and fires the Discord notification.
 *
 * Pulled out of combatEvents.ts (Apr 2026) as part of splitting that
 * 1455-line monolith into per-concern modules under `socket/combat/*`.
 */
export async function startCombat(
  io: Server, sessionId: string, tokenIds: string[],
): Promise<void> {
  const combatState = await CombatService.startCombatAsync(sessionId, tokenIds);

  // Initiative review phase — combat is technically active on the
  // server so tokens / HP are locked in, but the DM gets to inspect
  // and hand-edit every rolled initiative before turns start
  // advancing. Clients receive reviewPhase=true on combat:started
  // and hold the DM-facing review modal + the player-facing
  // "DM reviewing" banner until the DM confirms (see the
  // combat:lock-initiative handler).
  io.to(sessionId).emit('combat:started', {
    combatants: combatState.combatants,
    roundNumber: combatState.roundNumber,
    reviewPhase: true,
  });

  // Announce the initiative order in chat as a system message.
  const lines: string[] = ['\u2694\uFE0F Combat begins! Initiative order:'];
  combatState.combatants.forEach((c, idx) => {
    const marker = idx === 0 ? '\u25B6' : ' ';
    const tag = c.isNPC ? '' : ' (PC)';
    lines.push(`   ${marker} ${idx + 1}. ${c.name}${tag} \u2014 ${c.initiative}`);
  });
  lines.push(`   Round 1 \u2014 ${combatState.combatants[0]?.name ?? '?'}'s turn`);

  // Fire-and-forget Discord notification. The service is a no-op when
  // no webhook is configured, and internally swallows network errors
  // so a flaky webhook can never stall combat-start.
  void DiscordService.notifySession(sessionId, {
    title: '\u2694\uFE0F Combat Begins',
    description: combatState.combatants
      .map((c, idx) => `**${idx + 1}.** ${c.name}${c.isNPC ? '' : ' *(PC)*'} \u2014 ${c.initiative}`)
      .join('\n'),
    color: 0xc0392b,
  });

  io.to(sessionId).emit('chat:new-message', {
    id: uuidv4(),
    sessionId,
    userId: 'system',
    displayName: 'System',
    type: 'system',
    content: lines.join('\n'),
    characterName: null,
    whisperTo: null,
    rollData: null,
    createdAt: new Date().toISOString(),
  });

  // Broadcast each initiative roll so every client sees the values.
  for (const combatant of combatState.combatants) {
    if (combatant.initiative === 0) continue;
    io.to(sessionId).emit('combat:initiative-set', {
      tokenId: combatant.tokenId,
      roll: combatant.initiative - combatant.initiativeBonus,
      bonus: combatant.initiativeBonus,
      total: combatant.initiative,
    });
  }

  // Emit the sorted combatants so every client has the correct order.
  if (CombatService.allInitiativesRolled(sessionId)) {
    const sorted = CombatService.sortInitiative(sessionId);
    io.to(sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
  }
}
