import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Attunement tracking (DMG p.138). A character can be attuned to at
 * most 3 magic items at a time; attuning a 4th refuses until they
 * break attunement on another. The UI shows the badge already; this
 * adds a server-authoritative toggle + the cap.
 *
 *   !attune <item name>     look up the item on the caller's
 *                           inventory, flip attuned=true, refuse if
 *                           already at the 3-cap.
 *   !unattune <item name>   flip attuned=false.
 *   !attune list            show all currently-attuned items.
 */

const ATTUNEMENT_CAP = 3;

interface InventoryItem {
  name?: string;
  attunement?: boolean;
  attuned?: boolean;
  [k: string]: unknown;
}

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function loadInventory(characterId: string): Promise<InventoryItem[]> {
  const { rows } = await pool.query('SELECT inventory FROM characters WHERE id = $1', [characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return [];
  try {
    const raw = row.inventory;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
    return Array.isArray(parsed) ? (parsed as InventoryItem[]) : [];
  } catch {
    return [];
  }
}

async function writeInventory(characterId: string, inv: InventoryItem[]): Promise<void> {
  await pool.query('UPDATE characters SET inventory = $1 WHERE id = $2', [
    JSON.stringify(inv),
    characterId,
  ]);
}

function findItem(inv: InventoryItem[], needle: string): number {
  const n = needle.trim().toLowerCase();
  // Case-insensitive exact match first; then substring as a fallback
  // for long official names ("Ring of Protection" matches "ring").
  let exactIdx = -1, substrIdx = -1;
  for (let i = 0; i < inv.length; i++) {
    const name = String(inv[i]?.name ?? '').toLowerCase();
    if (name === n) exactIdx = i;
    else if (name.includes(n)) substrIdx = i;
  }
  return exactIdx >= 0 ? exactIdx : substrIdx;
}

async function handleAttune(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim();
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!attune: no owned PC token on this map.');
    return true;
  }
  const inv = await loadInventory(caller.characterId);

  if (arg.toLowerCase() === 'list' || !arg) {
    const attuned = inv.filter((i) => i.attuned);
    if (attuned.length === 0) {
      whisperToCaller(c.io, c.ctx, `${caller.name} has no attuned items (${ATTUNEMENT_CAP} slots free).`);
      return true;
    }
    const names = attuned.map((i) => i.name || '<unnamed>').join(', ');
    whisperToCaller(
      c.io, c.ctx,
      `${caller.name} — attuned: ${names} (${attuned.length}/${ATTUNEMENT_CAP}).`,
    );
    return true;
  }

  const idx = findItem(inv, arg);
  if (idx < 0) {
    whisperToCaller(c.io, c.ctx, `!attune: no item matching "${arg}" in ${caller.name}'s inventory.`);
    return true;
  }
  const item = inv[idx];
  if (!item.attunement) {
    whisperToCaller(c.io, c.ctx, `!attune: "${item.name}" doesn't require attunement.`);
    return true;
  }
  if (item.attuned) {
    whisperToCaller(c.io, c.ctx, `!attune: "${item.name}" is already attuned.`);
    return true;
  }
  const currentCount = inv.filter((i) => i.attuned).length;
  if (currentCount >= ATTUNEMENT_CAP) {
    whisperToCaller(
      c.io, c.ctx,
      `!attune: ${caller.name} is already at the ${ATTUNEMENT_CAP}-item cap. Unattune something first with \`!unattune <item>\`.`,
    );
    return true;
  }

  item.attuned = true;
  inv[idx] = item;
  await writeInventory(caller.characterId, inv)
    .catch((e) => console.warn('[!attune] inventory write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { inventory: inv },
  });
  broadcastSystem(
    c.io, c.ctx,
    `🔮 ${caller.name} attunes to **${item.name}** (${currentCount + 1}/${ATTUNEMENT_CAP} attunement slots used).`,
  );
  return true;
}

async function handleUnattune(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim();
  if (!arg) {
    whisperToCaller(c.io, c.ctx, '!unattune: usage `!unattune <item name>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!unattune: no owned PC token on this map.');
    return true;
  }
  const inv = await loadInventory(caller.characterId);
  const idx = findItem(inv, arg);
  if (idx < 0) {
    whisperToCaller(c.io, c.ctx, `!unattune: no item matching "${arg}" in ${caller.name}'s inventory.`);
    return true;
  }
  const item = inv[idx];
  if (!item.attuned) {
    whisperToCaller(c.io, c.ctx, `!unattune: "${item.name}" is not attuned.`);
    return true;
  }
  item.attuned = false;
  inv[idx] = item;
  await writeInventory(caller.characterId, inv)
    .catch((e) => console.warn('[!unattune] inventory write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { inventory: inv },
  });
  const remaining = inv.filter((i) => i.attuned).length;
  broadcastSystem(
    c.io, c.ctx,
    `🔮 ${caller.name} breaks attunement with **${item.name}** (${remaining}/${ATTUNEMENT_CAP} slots used).`,
  );
  return true;
}

registerChatCommand('attune', handleAttune);
registerChatCommand('unattune', handleUnattune);
