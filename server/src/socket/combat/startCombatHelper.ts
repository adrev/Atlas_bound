import { v4 as uuidv4 } from 'uuid';
import type { Server } from 'socket.io';
import * as CombatService from '../../services/CombatService.js';
import * as DiscordService from '../../services/DiscordService.js';
import { getRoom } from '../../utils/roomState.js';
import type { Combatant } from '@dnd-vtt/shared';

/**
 * Build a combatant list filtered to what a given recipient should see.
 * DMs see everything; players never see combatants whose underlying
 * token is hidden (visible: false) so starting combat with a pre-hidden
 * ambusher doesn't leak the ambusher's name / initiative count to the
 * table. The hidden combatant still rolls initiative on the server —
 * when the DM reveals the token, a normal `combat:state-sync` brings
 * the player client up to speed.
 */
function combatantsVisibleTo(
  sessionId: string,
  combatants: Combatant[],
  role: 'dm' | 'player',
): Combatant[] {
  if (role === 'dm') return combatants;
  const room = getRoom(sessionId);
  if (!room) return combatants;
  return combatants.filter((c) => {
    const tok = room.tokens.get(c.tokenId);
    // If the token is missing from the live room map (e.g. a creature
    // added by slug with no map presence), default to hidden — safer
    // to drop than to leak.
    if (!tok) return false;
    return tok.visible !== false;
  });
}

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
  const room = getRoom(sessionId);

  // Initiative review phase — combat is technically active on the
  // server so tokens / HP are locked in, but the DM gets to inspect
  // and hand-edit every rolled initiative before turns start
  // advancing. Clients receive reviewPhase=true on combat:started
  // and hold the DM-facing review modal + the player-facing
  // "DM reviewing" banner until the DM confirms (see the
  // combat:lock-initiative handler).
  //
  // Per-recipient emit so players never see hidden creatures in the
  // initiative tracker. Hidden creatures still act — we just don't
  // advertise them until the DM reveals the token.
  if (room) {
    for (const p of room.players.values()) {
      const visibleCombatants = combatantsVisibleTo(sessionId, combatState.combatants, p.role);
      io.to(p.socketId).emit('combat:started', {
        combatants: visibleCombatants,
        roundNumber: combatState.roundNumber,
        reviewPhase: true,
      });
    }
  } else {
    io.to(sessionId).emit('combat:started', {
      combatants: combatState.combatants,
      roundNumber: combatState.roundNumber,
      reviewPhase: true,
    });
  }

  // Announce the initiative order in chat as a system message. Two
  // versions — DMs get the full list, players get a list with hidden
  // entries replaced by a "???" placeholder so they still see the slot
  // counts (and understand that an unseen threat acts between turns 2
  // and 3) without knowing who or with what modifier.
  const buildLines = (pov: 'dm' | 'player'): string => {
    const out: string[] = ['⚔️ Combat begins! Initiative order:'];
    combatState.combatants.forEach((c, idx) => {
      const marker = idx === 0 ? '▶' : ' ';
      const tok = room?.tokens.get(c.tokenId);
      const hidden = pov === 'player' && tok?.visible === false;
      if (hidden) {
        out.push(`   ${marker} ${idx + 1}. ??? — ??`);
      } else {
        const tag = c.isNPC ? '' : ' (PC)';
        out.push(`   ${marker} ${idx + 1}. ${c.name}${tag} — ${c.initiative}`);
      }
    });
    const firstVisibleName = pov === 'player'
      ? combatState.combatants.find((c) => room?.tokens.get(c.tokenId)?.visible !== false)?.name
      : combatState.combatants[0]?.name;
    out.push(`   Round 1 — ${firstVisibleName ?? '???'}'s turn`);
    return out.join('\n');
  };

  // Fire-and-forget Discord notification (DM-private channel, so the
  // full list is fine here — it never reaches players).
  void DiscordService.notifySession(sessionId, {
    title: '⚔️ Combat Begins',
    description: combatState.combatants
      .map((c, idx) => `**${idx + 1}.** ${c.name}${c.isNPC ? '' : ' *(PC)*'} — ${c.initiative}`)
      .join('\n'),
    color: 0xc0392b,
  });

  if (room) {
    for (const p of room.players.values()) {
      io.to(p.socketId).emit('chat:new-message', {
        id: uuidv4(),
        sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: buildLines(p.role),
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Broadcast each initiative roll — DM-scope gets everything; player-
  // scope only gets rolls for tokens they can see on the map.
  for (const combatant of combatState.combatants) {
    if (combatant.initiative === 0) continue;
    const tok = room?.tokens.get(combatant.tokenId);
    const payload = {
      tokenId: combatant.tokenId,
      roll: combatant.initiative - combatant.initiativeBonus,
      bonus: combatant.initiativeBonus,
      total: combatant.initiative,
    };
    if (!room) {
      io.to(sessionId).emit('combat:initiative-set', payload);
      continue;
    }
    for (const p of room.players.values()) {
      if (p.role === 'dm' || tok?.visible !== false) {
        io.to(p.socketId).emit('combat:initiative-set', payload);
      }
    }
  }

  // Emit the sorted combatants so every client has the correct order.
  if (CombatService.allInitiativesRolled(sessionId)) {
    const sorted = CombatService.sortInitiative(sessionId);
    if (room) {
      for (const p of room.players.values()) {
        io.to(p.socketId).emit('combat:all-initiatives-ready', {
          combatants: combatantsVisibleTo(sessionId, sorted, p.role),
        });
      }
    } else {
      io.to(sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
    }
  }
}
