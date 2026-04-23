import type { Server } from 'socket.io';
import type {
  ChatMessage, AttackBreakdown, SpellCastBreakdown, SaveBreakdown, ActionBreakdown,
} from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import type { PlayerContext } from '../utils/roomState.js';

/**
 * Chat slash-command dispatcher. A single entry point for every
 * `!foo …` message a user types into chat. Replaces the previous
 * ad-hoc parsing in individual handlers (roll is still its own
 * channel because of the 3D-dice sync plumbing).
 *
 * Handlers decide authorization and either:
 *   - emit zero or more chat messages and return `true` to suppress
 *     the default chat:new-message broadcast for the original input,
 *   - return `false` to let the caller fall through to normal chat
 *     (useful when the command is unknown / unauthorized and we
 *     want the user's input to show in chat as a regular line).
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

export function registerChatCommand(
  names: string | string[],
  handler: ChatCommandHandler,
): void {
  const list = Array.isArray(names) ? names : [names];
  for (const n of list) handlers[n.toLowerCase()] = handler;
}

/**
 * Try to run a chat command. Returns true if the handler handled the
 * message (caller should suppress the default chat insert/broadcast).
 */
export async function tryHandleChatCommand(
  io: Server,
  ctx: PlayerContext,
  raw: string,
): Promise<boolean> {
  if (!raw.startsWith('!')) return false;
  const trimmed = raw.slice(1).trim();
  if (!trimmed) return false;

  const firstSpace = trimmed.search(/\s/);
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  const handler = handlers[command];
  if (!handler) return false;

  try {
    return await handler({ io, ctx, raw, command, rest });
  } catch (err) {
    // Surface the error back to the caller as a private whisper
    // instead of letting the exception escape the safeHandler wrapper.
    const msg = err instanceof Error ? err.message : 'Command failed.';
    whisperToCaller(io, ctx, `⚠ !${command}: ${msg}`);
    return true;
  }
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
  structured?: ChatStructuredPayloads,
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
  const attackResultJson = structured?.attackResult ? JSON.stringify(structured.attackResult) : null;
  const spellResultJson = structured?.spellResult ? JSON.stringify(structured.spellResult) : null;
  const saveResultJson = structured?.saveResult ? JSON.stringify(structured.saveResult) : null;
  const actionResultJson = structured?.actionResult ? JSON.stringify(structured.actionResult) : null;
  pool.query(
    `INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, attack_result, spell_result, save_result, action_result, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      message.id, message.sessionId, message.userId, message.displayName,
      message.type, message.content, message.characterName,
      attackResultJson, spellResultJson, saveResultJson, actionResultJson,
      message.createdAt,
    ],
  ).catch((e) => console.warn('[chat-commands] persist broadcast failed:', e));
  io.to(ctx.room.sessionId).emit('chat:new-message', message);
}

/** True if the caller is the DM of this session. */
export function isDM(ctx: PlayerContext): boolean {
  return ctx.player.role === 'dm';
}
