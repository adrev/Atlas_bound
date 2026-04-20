import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';

/**
 * !rest <short|long> [target]
 *   DM (or party-member) triggers a rest on every connected PC, or
 *   on a single named target token. Rather than duplicating the
 *   rest-update logic on the server (fragile drift risk with the
 *   client's performLongRest / performShortRest helpers), the server
 *   just broadcasts a `rest:party-trigger` event — each client
 *   listens, checks if the event applies to its active character,
 *   and runs the existing helper locally.
 *
 *   Doing it this way keeps the "what does a long rest reset?"
 *   rulebook in one place (client/src/utils/rest.ts) while still
 *   giving the DM a one-command way to trigger the rest for the
 *   whole party.
 */

async function handleRest(c: ChatCommandContext): Promise<boolean> {
  if (c.ctx.player.role !== 'dm') {
    whisperToCaller(c.io, c.ctx, '!rest: DM only. Players can use the Rest button in the bottom bar.');
    return true;
  }
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!rest: usage `!rest <short|long> [target]`');
    return true;
  }
  const kindRaw = parts.shift()!.toLowerCase();
  const kind: 'short' | 'long' = kindRaw === 'short' || kindRaw === 's' ? 'short' : 'long';
  const targetName = parts.join(' ').trim();

  // Resolve target tokenId if a target was specified. Broadcast the
  // event with targetTokenId set so clients filter by ownership.
  let targetTokenId: string | undefined;
  if (targetName) {
    const matches = Array.from(c.ctx.room.tokens.values()).filter(
      (t) => t.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (matches.length === 0) {
      whisperToCaller(c.io, c.ctx, `!rest: no token named "${targetName}" on this map.`);
      return true;
    }
    matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    targetTokenId = matches[0].id;
  }

  c.io.to(c.ctx.room.sessionId).emit('rest:party-trigger', {
    kind,
    targetTokenId,
    triggeredBy: c.ctx.player.displayName,
  });

  broadcastSystem(
    c.io, c.ctx,
    `🛌 ${c.ctx.player.displayName} calls for a ${kind === 'long' ? 'Long' : 'Short'} Rest${targetName ? ` (${targetName} only)` : ' — whole party'}.`,
  );
  return true;
}

registerChatCommand('rest', handleRest);
