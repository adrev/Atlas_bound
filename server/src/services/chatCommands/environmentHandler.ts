import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token, ActionBreakdown } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Environment + variant combat:
 *   !underwater on|off           — toggle a per-map "aquatic" flag,
 *                                  broadcasts the ruleset reminder
 *   !mount <rider> <mount> [controlled|independent]  — set up mount
 *                                  relationship
 *   !dismount <rider>            — end the mount relationship, half speed
 *   !chase [urban|wilderness|...] — roll on the XGE chase complication
 *                                  table for the chosen terrain
 */

function resolveTargetByName(ctx: PlayerContext, name: string): Token | null {
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

// ═══════════════════════════════════════════════════════════════════
// Underwater combat — PHB p.198
// ═══════════════════════════════════════════════════════════════════

// In-memory flag per session. Not persisted — DMs toggle per scene.
const underwaterSessions = new Set<string>();

async function handleUnderwater(c: ChatCommandContext): Promise<boolean> {
  if (c.ctx.player.role !== 'dm') {
    whisperToCaller(c.io, c.ctx, '!underwater: DM only.');
    return true;
  }
  const sub = c.rest.trim().toLowerCase();
  if (sub === 'on' || sub === 'start' || sub === 'enable') {
    underwaterSessions.add(c.ctx.room.sessionId);
    broadcastSystem(c.io, c.ctx,
      '🌊 **Underwater combat** activated for this scene (PHB p.198):\n' +
      '  • **Melee attacks** with weapons other than daggers / javelins / shortswords / spears / tridents have **disadvantage** — except creatures with swim speed or adapted for water.\n' +
      '  • **Ranged attacks** automatically miss beyond the weapon\'s *normal* range. At normal range they have **disadvantage** unless the weapon is a crossbow, net, or thrown weapon (trident / dart / javelin / spear).\n' +
      '  • **Fire damage** from non-magical sources is impossible (torches extinguish). Spells that create fire are at the DM\'s discretion — Fireball works (it\'s magical); a bonfire cantrip doesn\'t.\n' +
      '  • **Swim speed** creatures move normally; others treat water as difficult terrain (2× movement cost).\n' +
      '  • **Breath** — creatures without a swim speed or water-breathing can hold breath for CON mod minutes (min 30 s). After that, they start suffocating (drop to 0 HP at end of next full round).');
    return true;
  }
  if (sub === 'off' || sub === 'end' || sub === 'disable') {
    underwaterSessions.delete(c.ctx.room.sessionId);
    broadcastSystem(c.io, c.ctx, '🏞 Underwater combat deactivated — normal movement + attack rules resume.');
    return true;
  }
  const active = underwaterSessions.has(c.ctx.room.sessionId);
  whisperToCaller(c.io, c.ctx,
    `!underwater: currently ${active ? 'ACTIVE' : 'inactive'}. Usage: \`!underwater <on|off>\`.`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Mounted combat — PHB p.198
// ═══════════════════════════════════════════════════════════════════

// Key: sessionId → rider-tokenId → { mountTokenId, controlled }
const mountLinks = new Map<string, Map<string, { mountTokenId: string; controlled: boolean }>>();

function mountMap(sessionId: string): Map<string, { mountTokenId: string; controlled: boolean }> {
  let m = mountLinks.get(sessionId);
  if (!m) { m = new Map(); mountLinks.set(sessionId, m); }
  return m;
}

async function handleMount(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx,
      '!mount: usage `!mount <rider> <mount> [controlled|independent]`');
    return true;
  }
  const maybeControl = parts[parts.length - 1].toLowerCase();
  const hasControlToken = maybeControl === 'controlled' || maybeControl === 'independent';
  const controlled = !hasControlToken || maybeControl === 'controlled';
  const trimmed = hasControlToken ? parts.slice(0, -1) : parts;
  // Accept "rider mount" with 2 one-word names, or "Rider Name, Mount"
  // with a comma fallback.
  let rider: Token | null;
  let mount: Token | null;
  if (trimmed.length === 2) {
    rider = resolveTargetByName(c.ctx, trimmed[0]);
    mount = resolveTargetByName(c.ctx, trimmed[1]);
  } else {
    const joined = trimmed.join(' ');
    const idx = joined.indexOf(',');
    if (idx < 0) {
      whisperToCaller(c.io, c.ctx,
        '!mount: when names contain spaces, separate with a comma (e.g. `!mount Arthur, Black Stallion`).');
      return true;
    }
    rider = resolveTargetByName(c.ctx, joined.slice(0, idx).trim());
    mount = resolveTargetByName(c.ctx, joined.slice(idx + 1).trim());
  }
  if (!rider || !mount) {
    whisperToCaller(c.io, c.ctx, `!mount: couldn't resolve rider / mount.`);
    return true;
  }

  mountMap(c.ctx.room.sessionId).set(rider.id, {
    mountTokenId: mount.id,
    controlled,
  });

  // Snap the mount's position to the rider so the pair visually moves together.
  if (c.ctx.room.tokens.has(mount.id) && c.ctx.room.tokens.has(rider.id)) {
    mount.x = rider.x;
    mount.y = rider.y;
    pool.query('UPDATE tokens SET x = $1, y = $2 WHERE id = $3', [mount.x, mount.y, mount.id])
      .catch((e) => console.warn('[!mount] snap failed:', e));
  }

  broadcastSystem(c.io, c.ctx,
    `🐎 **Mounted** — ${rider.name} rides ${mount.name} (${controlled ? 'controlled' : 'independent'} mount, PHB p.198):\n` +
    `  • Mounting / dismounting costs **half your speed**.\n` +
    (controlled
      ? `  • **Controlled:** mount shares rider's initiative, moves when rider dictates. Mount can only Dash, Disengage, or Dodge on its own turn. Attacks against the pair: attacker chooses rider or mount.\n`
      : `  • **Independent:** mount acts on its own initiative with full action suite.\n`) +
    `  • If mount is knocked prone / killed / pushed, rider makes DC 10 DEX save or is also knocked prone + dismounted. Successful save keeps rider standing in an empty space near the mount.`);
  return true;
}

async function handleDismount(c: ChatCommandContext): Promise<boolean> {
  const riderName = c.rest.trim();
  if (!riderName) {
    whisperToCaller(c.io, c.ctx, '!dismount: usage `!dismount <rider>`');
    return true;
  }
  const rider = resolveTargetByName(c.ctx, riderName);
  if (!rider) {
    whisperToCaller(c.io, c.ctx, `!dismount: no token named "${riderName}".`);
    return true;
  }
  const m = mountMap(c.ctx.room.sessionId);
  const link = m.get(rider.id);
  if (!link) {
    whisperToCaller(c.io, c.ctx, `!dismount: ${rider.name} isn't mounted.`);
    return true;
  }
  const mount = c.ctx.room.tokens.get(link.mountTokenId);
  m.delete(rider.id);
  broadcastSystem(c.io, c.ctx,
    `🚶 **Dismount** — ${rider.name} dismounts from ${mount?.name ?? 'the mount'} (costs half speed).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Chase rules — XGE ch.2 complication tables
// ═══════════════════════════════════════════════════════════════════

const CHASE_URBAN: Array<{ roll: number; text: string }> = [
  { roll: 1, text: '**Horse-drawn carriage** blocks the way. DC 15 DEX save or fall prone (10 ft of movement to stand).' },
  { roll: 2, text: '**Crate or barrel stack** — DC 10 DEX save, fail = 10 ft of difficult terrain.' },
  { roll: 3, text: '**Slippery cobblestones** (rain / fish guts). DC 10 DEX save, fail = fall prone.' },
  { roll: 4, text: '**Dog tangles underfoot.** DC 10 DEX save, fail = fall prone.' },
  { roll: 5, text: '**Large crowd** ahead. Dash becomes difficult terrain (2× movement cost).' },
  { roll: 6, text: '**Window / door** in your path. DC 10 STR save to force through; spend 15 ft of movement.' },
  { roll: 7, text: '**Pickpocket** brushes past. DC 10 WIS save or don\'t notice; on success DC 15 DEX to grab them.' },
  { roll: 8, text: '**Passerby helps** the fleeing party they root for. DC 10 STR save to push through.' },
  { roll: 9, text: '**Patrol** on the corner. Roll DEX (Stealth) vs their passive Perception to slip by unnoticed.' },
  { roll: 10, text: '**Guarded gate** ahead. Bribe, bluff, or bash — 20 ft of movement cost.' },
  { roll: 11, text: '**Sewer grate** loose — DC 10 DEX save, fail = leg stuck, prone, one turn to free.' },
  { roll: 12, text: '**Stray cat** — no save needed, purely flavor (DC 10 Animal Handling if you pause).' },
  { roll: 13, text: '**Narrow alley** — Large creatures have disadvantage on DEX saves to avoid obstacles.' },
  { roll: 14, text: '**Wash line strung across street** at neck height. DC 10 DEX save, fail = prone.' },
  { roll: 15, text: '**Steep uphill section.** 10 ft of difficult terrain.' },
  { roll: 16, text: '**Vendor\'s cart** overturned. Extra 5 ft of movement to go around.' },
  { roll: 17, text: '**Crowded market.** Dash requires DC 10 STR or DEX check; fail = 10 ft of movement lost.' },
  { roll: 18, text: '**Wagon wheels** loose. DC 10 DEX save, fail = 1d4 bludgeoning as rolling debris hits.' },
];

const CHASE_WILDERNESS: Array<{ roll: number; text: string }> = [
  { roll: 1, text: '**Swarm of insects** in path. DC 10 CON save or 1d4 piercing + disadvantage for next move.' },
  { roll: 2, text: '**Steep slope** up or down. Movement costs doubled until off slope.' },
  { roll: 3, text: '**Thick bramble.** DC 10 STR save to push through; fail = 1d4 slashing + restrained until next turn.' },
  { roll: 4, text: '**Vertical drop** 1d6 × 10 ft. DC 10 DEX save or fall + take 1d6 per 10 ft.' },
  { roll: 5, text: '**Narrow chasm** 5 ft wide. Standard jump — DEX to clear.' },
  { roll: 6, text: '**Animal burrow** — DC 10 DEX save, fail = leg caught, prone + speed halved until freed.' },
  { roll: 7, text: '**Dense fog** rolls in. Heavily obscured beyond 5 ft for the next round.' },
  { roll: 8, text: '**Creek / stream.** DC 10 STR save to cross at speed; fail = difficult terrain.' },
  { roll: 9, text: '**Thorny vines** — 5 ft difficult terrain.' },
  { roll: 10, text: '**Fallen log** blocks path. DC 10 DEX save or prone.' },
  { roll: 11, text: '**Slippery leaves / mud.** DC 10 DEX save, fail = prone.' },
  { roll: 12, text: '**Beehive or hornet swarm** disturbed. DC 10 CON save or 1d4 poison + disadvantage for 1 turn.' },
  { roll: 13, text: '**Wild deer / rabbit** bolts across path. DC 10 WIS save or lose focus (disadvantage on next attack).' },
  { roll: 14, text: '**Muddy patch** — 10 ft difficult terrain.' },
  { roll: 15, text: '**Fallen tree gap** — DC 12 STR (Athletics) to climb over; costs 15 ft of movement.' },
  { roll: 16, text: '**Bird flock** erupts — DC 10 WIS save or disadvantage on next Perception check.' },
  { roll: 17, text: '**Stepping stones** across a stream. DC 10 DEX save or fall prone in water.' },
  { roll: 18, text: '**Loose rocks** rolling. DC 10 DEX save or 1d4 bludgeoning.' },
];

const CHASE_TABLES: Record<string, Array<{ roll: number; text: string }>> = {
  urban: CHASE_URBAN,
  city: CHASE_URBAN,
  wilderness: CHASE_WILDERNESS,
  forest: CHASE_WILDERNESS,
  outdoors: CHASE_WILDERNESS,
};

async function handleChase(c: ChatCommandContext): Promise<boolean> {
  const terrainRaw = c.rest.trim().toLowerCase() || 'urban';
  const terrain = terrainRaw.split(/\s+/)[0];
  const table = CHASE_TABLES[terrain] ?? CHASE_URBAN;
  const tableLabel = terrain in CHASE_TABLES ? terrain : 'urban (default)';
  const d20 = Math.floor(Math.random() * 20) + 1;
  const entry = table.find((e) => e.roll === d20)
    ?? { roll: d20, text: `No complication — fleet foot or lucky break (roll ${d20}).` };
  const caller = Array.from(c.ctx.room.tokens.values()).find((t) => t.ownerUserId === c.ctx.player.userId);
  const chaseBreakdown: ActionBreakdown = {
    actor: { name: c.ctx.player.displayName, tokenId: caller?.id },
    action: {
      name: `Chase complication (d20 = ${d20})`,
      category: 'chase',
      icon: '🏃',
      cost: 'Triggered on chase tick',
    },
    effect: entry.text,
    notes: [
      `Chase terrain: ${tableLabel}`,
      `d20 roll: ${d20}`,
      `Table: ${terrain in CHASE_TABLES ? terrain : 'urban (default)'}`,
    ],
  };
  broadcastSystem(c.io, c.ctx,
    `🏃 **Chase complication** (${tableLabel}, d20=${d20}):\n   ${entry.text}`,
    { actionResult: chaseBreakdown });
  return true;
}

registerChatCommand('underwater', handleUnderwater);
registerChatCommand('mount', handleMount);
registerChatCommand('dismount', handleDismount);
registerChatCommand('chase', handleChase);
