import pool from '../../db/connection.js';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  isDM,
  type ChatCommandContext,
} from '../ChatCommands.js';

/**
 * R8 — Handout / note → chat commands.
 *
 *   !gmnote <title>  — whisper the matching session note to the caller
 *                      only (private review). Useful mid-scene reminder.
 *   !pcnote <title>  — broadcast the matching session note as a system
 *                      message to everyone in the session. DM-only.
 *   !note <title>    — alias: `gmnote` for DM (private), `pcnote` for
 *                      players IF the note is owned by them (they can
 *                      share their own notes). Never lets a player
 *                      broadcast a DM-private note.
 *
 * Lookup: case-insensitive, whole-title match in the current session's
 * notes. If there's more than one match, the newest wins (notes have a
 * created_at). If there's no match, whisper an error back.
 *
 * Plays nicely with R3's roll-template chrome: the broadcast is a
 * plain system message today, but the content can contain markdown
 * which the chat card renderer already formats.
 */

interface NoteRow {
  id: string;
  title: string;
  content: string;
  is_shared: number;
  created_by: string;
}

async function findNote(
  sessionId: string,
  title: string,
): Promise<NoteRow | null> {
  const { rows } = await pool.query(
    `SELECT id, title, content, is_shared, created_by
       FROM session_notes
      WHERE session_id = $1 AND LOWER(title) = LOWER($2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, title],
  );
  return rows[0] ?? null;
}

function formatNoteBlock(title: string, body: string): string {
  // Keep the format simple — DiceRollCard / ChatPanel already style
  // `type: 'system'` messages with a gold left border. Use a small
  // title header so players can scan multiple broadcasts visually.
  const trimmed = (body ?? '').trim();
  return trimmed.length > 0
    ? `📜 **${title}**\n${trimmed}`
    : `📜 **${title}**\n*(empty note)*`;
}

async function handleGmNote(c: ChatCommandContext): Promise<boolean> {
  if (!c.rest) {
    whisperToCaller(c.io, c.ctx, '!gmnote: usage `!gmnote <note title>`');
    return true;
  }
  const note = await findNote(c.ctx.room.sessionId, c.rest);
  if (!note) {
    whisperToCaller(c.io, c.ctx, `!gmnote: no note titled “${c.rest}” in this session.`);
    return true;
  }
  // Non-DMs can gmnote their own notes only — avoids a player peeking
  // at a DM-private note by guessing the title.
  if (!isDM(c.ctx) && note.created_by !== c.ctx.player.userId) {
    whisperToCaller(c.io, c.ctx, `!gmnote: no note titled “${c.rest}” in this session.`);
    return true;
  }
  whisperToCaller(c.io, c.ctx, formatNoteBlock(note.title, note.content));
  return true;
}

async function handlePcNote(c: ChatCommandContext): Promise<boolean> {
  if (!c.rest) {
    whisperToCaller(c.io, c.ctx, '!pcnote: usage `!pcnote <note title>`');
    return true;
  }
  const note = await findNote(c.ctx.room.sessionId, c.rest);
  if (!note) {
    whisperToCaller(c.io, c.ctx, `!pcnote: no note titled “${c.rest}” in this session.`);
    return true;
  }
  // Who can broadcast?
  //   - DM: any note.
  //   - Player: only their own notes (avoids publishing DM-private
  //     content by guessing the title).
  if (!isDM(c.ctx) && note.created_by !== c.ctx.player.userId) {
    whisperToCaller(c.io, c.ctx, `!pcnote: you can only broadcast notes you authored.`);
    return true;
  }
  broadcastSystem(c.io, c.ctx, formatNoteBlock(note.title, note.content));
  return true;
}

async function handleNote(c: ChatCommandContext): Promise<boolean> {
  // `!note` convenience: DM defaults to private whisper, players
  // default to broadcasting their own note (handlePcNote already
  // gates ownership so this is safe).
  return isDM(c.ctx) ? handleGmNote(c) : handlePcNote(c);
}

registerChatCommand('gmnote', handleGmNote);
registerChatCommand('pcnote', handlePcNote);
registerChatCommand('note', handleNote);
