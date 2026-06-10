import type { Server } from 'socket.io';
import type {
  ChatMessage,
  AttackBreakdown,
  SpellCastBreakdown,
  SaveBreakdown,
  ActionBreakdown,
} from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import type { PlayerContext } from '../utils/roomState.js';
import { emitToTokenViewers } from '../utils/combatBroadcast.js';
import { emitTokenScopedChat, tokenScopedChatIsPrivate } from '../utils/tokenScopedChat.js';

/**
 * Chat slash-command dispatcher. A single entry point for every
 * `!foo …` message a user types into chat. Replaces the previous
 * ad-hoc parsing in individual handlers (roll is still its own
 * channel because of the 3D-dice sync plumbing).
 *
 * Handlers decide authorization and either:
 *   - emit zero or more chat messages and return `true` to suppress
 *     the default chat:new-message broadcast for the original input,
 *   - return `false` to let the caller fall through to normal chat.
 *
 * UNKNOWN commands do NOT fall through to public chat. A typo'd
 * command used to be persisted + broadcast room-wide as a regular
 * line, which was both a silent failure (the player thinks `!firebolt`
 * did something) and a leak vector (a DM typo'ing `!gmnotes <secret>`
 * published the secret to every player's scrollback). Now anything
 * that *looks* like a command attempt (`!` + a word) but matches no
 * handler is suppressed and answered with a private whisper + nearest-
 * name suggestion. Non-word `!` text ("!!!", "!?") still falls through
 * as ordinary chat.
 *
 * The dispatcher intentionally never throws — individual handler
 * errors get caught and surfaced as a whispered system message to
 * the caller, so one broken command can't nuke the chat channel.
 */

export interface ChatCommandContext {
  io: Server;
  ctx: PlayerContext;
  /** The full raw content the user typed, including the leading `!`. */
  raw: string;
  /** The command name — the first whitespace-delimited token, `!` stripped, lowercased. */
  command: string;
  /** Everything after the command name, as a single string (not pre-tokenized). */
  rest: string;
}

type HandlerResult = Promise<boolean> | boolean;
export type ChatCommandHandler = (c: ChatCommandContext) => HandlerResult;

const handlers: Record<string, ChatCommandHandler> = {};

export function registerChatCommand(names: string | string[], handler: ChatCommandHandler): void {
  const list = Array.isArray(names) ? names : [names];
  for (const n of list) handlers[n.toLowerCase()] = handler;
}

/** All registered command names (lowercased). Exposed for typo suggestions and the typeahead. */
export function registeredCommandNames(): string[] {
  return Object.keys(handlers);
}

/** A command *attempt* is `!` + a word-like token — not "!!!" or "!?". */
const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;

/** Bounded Levenshtein distance — bails out early once > max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Nearest registered command for a typo, or null. Prefers a unique
 * prefix match (`!firebal` → `!fireball`), then the smallest edit
 * distance ≤ 2 (≤ 1 for very short inputs, where 2 edits can morph
 * into an unrelated command).
 */
export function suggestCommand(input: string): string | null {
  const names = registeredCommandNames();
  const prefixed = names.filter((n) => n.startsWith(input));
  if (prefixed.length > 0) {
    return prefixed.sort((a, b) => a.length - b.length)[0];
  }
  const maxDist = input.length <= 4 ? 1 : 2;
  let best: string | null = null;
  let bestDist = maxDist + 1;
  for (const n of names) {
    const d = editDistance(input, n, maxDist);
    if (d < bestDist || (d === bestDist && best !== null && n.length < best.length)) {
      best = n;
      bestDist = d;
    }
  }
  return bestDist <= maxDist ? best : null;
}

/**
 * Try to run a chat command. Returns true if the handler handled the
 * message (caller should suppress the default chat insert/broadcast).
 */
export async function tryHandleChatCommand(
  io: Server,
  ctx: PlayerContext,
  raw: string
): Promise<boolean> {
  if (!raw.startsWith('!')) return false;
  const trimmed = raw.slice(1).trim();
  if (!trimmed) return false;

  const firstSpace = trimmed.search(/\s/);
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  const handler = handlers[command];
  if (!handler) {
    // Looks like a command attempt but matches nothing — suppress the
    // public broadcast (no silent failure, no `!gmnotes` secret leak)
    // and tell the sender privately. Non-word `!` text ("!!!") is not
    // a command attempt and falls through to normal chat.
    if (!COMMAND_WORD.test(command)) return false;
    const suggestion = suggestCommand(command);
    whisperToCaller(
      io,
      ctx,
      `Unknown command \`!${command}\`${suggestion ? ` — did you mean \`!${suggestion}\`?` : ''} Type \`!help\` for the catalog. (Your message was not posted.)`
    );
    return true;
  }

  try {
    return await handler({ io: scopedChatCommandIo(io, ctx), ctx, raw, command, rest });
  } catch (err) {
    // Surface the error back to the caller as a private whisper
    // instead of letting the exception escape the safeHandler wrapper.
    const msg = err instanceof Error ? err.message : 'Command failed.';
    whisperToCaller(io, ctx, `⚠ !${command}: ${msg}`);
    return true;
  }
}

function scopedChatCommandIo(io: Server, ctx: PlayerContext): Server {
  return new Proxy(io, {
    get(target, prop, receiver) {
      if (prop !== 'to') return Reflect.get(target, prop, receiver);
      return (channel: unknown) => {
        const operator = target.to(channel as never);
        if (channel !== ctx.room.sessionId) return operator;
        return new Proxy(operator, {
          get(opTarget, opProp, opReceiver) {
            if (opProp !== 'emit') return Reflect.get(opTarget, opProp, opReceiver);
            return (event: string, payload?: unknown, ...args: unknown[]) => {
              const tokenId = tokenIdForScopedCommandEmit(ctx, event, payload);
              if (tokenId) {
                emitToTokenViewers(io, ctx.room, tokenId, event, payload, {
                  includeOwner: event === 'character:updated' || event === 'combat:action-used',
                });
                return true;
              }
              return (opTarget.emit as (...emitArgs: unknown[]) => unknown).call(
                opTarget,
                event,
                payload,
                ...args
              );
            };
          },
        });
      };
    },
  }) as Server;
}

function tokenIdForScopedCommandEmit(
  ctx: PlayerContext,
  event: string,
  payload: unknown
): string | null {
  if (typeof payload !== 'object' || payload === null) return null;

  if (
    event === 'map:token-updated' ||
    event === 'combat:hp-changed' ||
    event === 'combat:action-used'
  ) {
    const tokenId = (payload as { tokenId?: unknown }).tokenId;
    return typeof tokenId === 'string' ? tokenId : null;
  }

  if (event === 'character:updated') {
    const characterId = (payload as { characterId?: unknown }).characterId;
    if (typeof characterId !== 'string') return null;
    const token = Array.from(ctx.room.tokens.values()).find((t) => t.characterId === characterId);
    return token?.id ?? null;
  }

  return null;
}

// ── Helpers used by command handlers ───────────────────────────────

/** Whisper a system message visible only to the caller. */
export function whisperToCaller(io: Server, ctx: PlayerContext, content: string): void {
  const message: ChatMessage = {
    id: uuidv4(),
    sessionId: ctx.room.sessionId,
    userId: 'system',
    displayName: 'System',
    type: 'whisper',
    content,
    characterName: null,
    whisperTo: ctx.player.userId,
    rollData: null,
    createdAt: new Date().toISOString(),
  };
  io.to(ctx.player.socketId).emit('chat:new-message', message);
}

/**
 * Broadcast a system message to the whole session room. Optional
 * `structured` bag attaches one or more breakdowns (attack / spell /
 * save / action) so chat renders the rich card alongside the plain
 * text fallback. The plain-text `content` is always stored + shown
 * as scrollback even for clients that haven't loaded the card
 * components.
 */
export interface ChatStructuredPayloads {
  attackResult?: AttackBreakdown;
  spellResult?: SpellCastBreakdown;
  saveResult?: SaveBreakdown;
  actionResult?: ActionBreakdown;
}

export function broadcastSystem(
  io: Server,
  ctx: PlayerContext,
  content: string,
  structured?: ChatStructuredPayloads
): void {
  const message: ChatMessage = {
    id: uuidv4(),
    sessionId: ctx.room.sessionId,
    userId: 'system',
    displayName: 'System',
    type: 'system',
    content,
    characterName: null,
    whisperTo: null,
    rollData: null,
    attackResult: structured?.attackResult ?? null,
    spellResult: structured?.spellResult ?? null,
    saveResult: structured?.saveResult ?? null,
    actionResult: structured?.actionResult ?? null,
    createdAt: new Date().toISOString(),
  };
  // Persist so history shows the command result on refresh, including
  // the structured breakdowns so cards rehydrate correctly.
  const attackResultJson = structured?.attackResult
    ? JSON.stringify(structured.attackResult)
    : null;
  const spellResultJson = structured?.spellResult ? JSON.stringify(structured.spellResult) : null;
  const saveResultJson = structured?.saveResult ? JSON.stringify(structured.saveResult) : null;
  const actionResultJson = structured?.actionResult
    ? JSON.stringify(structured.actionResult)
    : null;
  pool
    .query(
      `INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, attack_result, spell_result, save_result, action_result, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        message.id,
        message.sessionId,
        message.userId,
        message.displayName,
        message.type,
        message.content,
        message.characterName,
        attackResultJson,
        spellResultJson,
        saveResultJson,
        actionResultJson,
        message.createdAt,
      ]
    )
    .catch((e) => console.warn('[chat-commands] persist broadcast failed:', e));
  io.to(ctx.room.sessionId).emit('chat:new-message', message);
}

/**
 * Broadcast a system chat card whose contents reveal a specific token.
 * Public/visible tokens still go room-wide; hidden or invisible token
 * cards only reach DMs, eligible viewers, and the token owner.
 */
export function broadcastTokenScopedSystem(
  io: Server,
  ctx: PlayerContext,
  tokenId: string,
  content: string,
  structured?: ChatStructuredPayloads
): void {
  const hidden = tokenScopedChatIsPrivate(ctx.room, tokenId);
  const message: ChatMessage = {
    id: uuidv4(),
    sessionId: ctx.room.sessionId,
    userId: 'system',
    displayName: 'System',
    type: 'system',
    content,
    characterName: null,
    whisperTo: null,
    rollData: null,
    attackResult: structured?.attackResult ?? null,
    spellResult: structured?.spellResult ?? null,
    saveResult: structured?.saveResult ?? null,
    actionResult: structured?.actionResult ?? null,
    hidden,
    createdAt: new Date().toISOString(),
  };
  const attackResultJson = structured?.attackResult
    ? JSON.stringify(structured.attackResult)
    : null;
  const spellResultJson = structured?.spellResult ? JSON.stringify(structured.spellResult) : null;
  const saveResultJson = structured?.saveResult ? JSON.stringify(structured.saveResult) : null;
  const actionResultJson = structured?.actionResult
    ? JSON.stringify(structured.actionResult)
    : null;
  pool
    .query(
      `INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, attack_result, spell_result, save_result, action_result, hidden, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        message.id,
        message.sessionId,
        message.userId,
        message.displayName,
        message.type,
        message.content,
        message.characterName,
        attackResultJson,
        spellResultJson,
        saveResultJson,
        actionResultJson,
        hidden ? 1 : 0,
        message.createdAt,
      ]
    )
    .catch((e) => console.warn('[chat-commands] persist token-scoped broadcast failed:', e));
  emitTokenScopedChat(io, ctx.room, tokenId, message as unknown as Record<string, unknown>);
}

/** True if the caller is the DM of this session. */
export function isDM(ctx: PlayerContext): boolean {
  return ctx.player.role === 'dm';
}
