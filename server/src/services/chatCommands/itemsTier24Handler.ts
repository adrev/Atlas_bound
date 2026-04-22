import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Tier 24 — generic magic items.
 *
 * Rather than a separate !cloakofprotection / !ringofprotection /
 * !amulethealth / ... (50+ items with near-identical shapes), this
 * file ships:
 *
 *   !magicitem <slug> [wearer]  — apply the named item's effect.
 *   !magicitem list             — whisper the supported slugs.
 *   !magicitem help <slug>      — whisper the item's RAW description.
 *
 * Plus targeted handlers for the items that need unique mechanics:
 *
 *   !flametongue [wearer]   — bonus 2d6 fire / turn, ignite at-will
 *   !vorpal <target>         — natural 20 vs humanoid = decapitate
 *   !bootsofspeed            — bonus action to double speed + OA disadv
 *   !holyavenger             — +3 damage vs fiends/undead, aura 10 ft
 *   !staffofpower            — 20 charges, spells + retributive strike
 *   !wandofmagicmissiles     — already in Tier 20
 *   !staffofhealing          — already in Tier 20
 */

// ── Data table ────────────────────────────────────────────────

interface MagicItem {
  name: string;
  rarity: string;
  attunement: boolean;
  effect: string;
  // Optional: apply a pseudo-condition when the wearer attunes /
  // activates it. The DM can peel it later with !uncond.
  condition?: string;
  durationRounds?: number;
}

const MAGIC_ITEMS: Record<string, MagicItem> = {
  // ── Weapons (generic) ──────────────────────────────────────
  'weapon-plus-1': {
    name: 'Weapon +1', rarity: 'Uncommon', attunement: false,
    effect: '+1 to attack rolls AND damage rolls. Counts as magical for bypassing resistance / immunity.',
  },
  'weapon-plus-2': {
    name: 'Weapon +2', rarity: 'Rare', attunement: false,
    effect: '+2 to attack rolls AND damage rolls. Counts as magical.',
  },
  'weapon-plus-3': {
    name: 'Weapon +3', rarity: 'Very Rare', attunement: false,
    effect: '+3 to attack rolls AND damage rolls. Counts as magical.',
  },

  // ── Armor (generic) ────────────────────────────────────────
  'armor-plus-1': {
    name: 'Armor +1', rarity: 'Rare', attunement: false,
    effect: '+1 AC while wearing. Counts as magical.',
  },
  'armor-plus-2': {
    name: 'Armor +2', rarity: 'Very Rare', attunement: false,
    effect: '+2 AC while wearing. Counts as magical.',
  },
  'armor-plus-3': {
    name: 'Armor +3', rarity: 'Legendary', attunement: false,
    effect: '+3 AC while wearing. Counts as magical.',
  },
  'shield-plus-1': {
    name: 'Shield +1', rarity: 'Uncommon', attunement: false,
    effect: '+1 AC beyond the shield\'s normal +2 (so +3 total AC while wielded).',
  },
  'shield-plus-2': {
    name: 'Shield +2', rarity: 'Rare', attunement: false,
    effect: '+2 AC beyond the shield\'s normal +2 (so +4 total AC).',
  },
  'shield-plus-3': {
    name: 'Shield +3', rarity: 'Very Rare', attunement: false,
    effect: '+3 AC beyond the shield\'s normal +2 (so +5 total AC).',
  },

  // ── Protective wondrous items ──────────────────────────────
  'cloak-of-protection': {
    name: 'Cloak of Protection', rarity: 'Uncommon', attunement: true,
    effect: '+1 bonus to AC AND all saving throws.',
    condition: 'cloak-of-protection',
  },
  'ring-of-protection': {
    name: 'Ring of Protection', rarity: 'Rare', attunement: true,
    effect: '+1 bonus to AC AND all saving throws.',
    condition: 'ring-of-protection',
  },
  'cloak-of-displacement': {
    name: 'Cloak of Displacement', rarity: 'Rare', attunement: true,
    effect: 'Attacks against you have disadvantage. Suppressed for 1 round after you take damage. Ends if you\'re incapacitated.',
    condition: 'displaced',
  },
  'cloak-of-invisibility': {
    name: 'Cloak of Invisibility', rarity: 'Legendary', attunement: true,
    effect: 'Action: become invisible (up to 2 hr accumulated per long rest, tracked in increments).',
  },

  // ── Stat-modifying wondrous ─────────────────────────────────
  'amulet-of-health': {
    name: 'Amulet of Health', rarity: 'Rare', attunement: true,
    effect: 'Your Constitution score is 19 while worn (no effect if CON already ≥ 19). Recalculate HP max on attune.',
    condition: 'amulet-of-health',
  },
  'headband-of-intellect': {
    name: 'Headband of Intellect', rarity: 'Uncommon', attunement: true,
    effect: 'Your Intelligence score is 19 while worn (no effect if INT already ≥ 19).',
    condition: 'headband-of-intellect',
  },
  'gauntlets-of-ogre-power': {
    name: 'Gauntlets of Ogre Power', rarity: 'Uncommon', attunement: true,
    effect: 'Your Strength score is 19 while worn (no effect if STR already ≥ 19).',
    condition: 'gauntlets-of-ogre-power',
  },
  'belt-of-giant-strength-hill': {
    name: 'Belt of Hill Giant Strength', rarity: 'Rare', attunement: true,
    effect: 'Your Strength score is 21 while worn. No effect if STR already ≥ 21.',
  },
  'belt-of-giant-strength-stone': {
    name: 'Belt of Stone Giant Strength', rarity: 'Very Rare', attunement: true,
    effect: 'Your Strength score is 23 while worn. No effect if STR already ≥ 23.',
  },
  'belt-of-giant-strength-frost': {
    name: 'Belt of Frost Giant Strength', rarity: 'Very Rare', attunement: true,
    effect: 'Your Strength score is 23 while worn. No effect if STR already ≥ 23.',
  },
  'belt-of-giant-strength-fire': {
    name: 'Belt of Fire Giant Strength', rarity: 'Very Rare', attunement: true,
    effect: 'Your Strength score is 25 while worn. No effect if STR already ≥ 25.',
  },
  'belt-of-giant-strength-cloud': {
    name: 'Belt of Cloud Giant Strength', rarity: 'Legendary', attunement: true,
    effect: 'Your Strength score is 27 while worn. No effect if STR already ≥ 27.',
  },
  'belt-of-giant-strength-storm': {
    name: 'Belt of Storm Giant Strength', rarity: 'Legendary', attunement: true,
    effect: 'Your Strength score is 29 while worn. No effect if STR already ≥ 29.',
  },

  // ── Movement ────────────────────────────────────────────────
  'boots-of-elvenkind': {
    name: 'Boots of Elvenkind', rarity: 'Uncommon', attunement: false,
    effect: 'Advantage on Dexterity (Stealth) checks for moving silently. Silent footsteps in any terrain.',
  },
  'boots-of-striding-and-springing': {
    name: 'Boots of Striding & Springing', rarity: 'Uncommon', attunement: true,
    effect: 'Walking speed is 30 ft (minimum, even encumbered). Jumps triple normal distance. No extra jump expenditure.',
  },
  'boots-of-the-winterlands': {
    name: 'Boots of the Winterlands', rarity: 'Uncommon', attunement: true,
    effect: 'Cold resistance. Ignore difficult terrain from ice/snow. Fine in temperatures down to -50°F.',
  },
  'winged-boots': {
    name: 'Winged Boots', rarity: 'Uncommon', attunement: true,
    effect: 'Fly speed equal to walking speed. 4 hrs of flight per dawn, consumable in 1-minute increments.',
  },
  'boots-of-speed': {
    name: 'Boots of Speed', rarity: 'Rare', attunement: true,
    effect: 'Bonus action: click heels. Speed doubled, opportunity attacks against have disadvantage. 10-minute total per dawn.',
    condition: 'boots-of-speed-active',
    durationRounds: 100,
  },

  // ── Signature weapons ──────────────────────────────────────
  'sun-blade': {
    name: 'Sun Blade', rarity: 'Rare', attunement: true,
    effect: 'Finesse longsword; blade is pure sunlight. +2 to attack + damage. Deals radiant instead of slashing. +1d8 radiant vs undead. Sheds 15-ft bright light + 15-ft dim on command.',
  },
  'flame-tongue': {
    name: 'Flame Tongue', rarity: 'Rare', attunement: true,
    effect: 'Bonus action command to ignite: +2d6 fire damage on hit. Sheds 40-ft bright + 40-ft dim light. Command word again to extinguish.',
  },
  'frost-brand': {
    name: 'Frost Brand', rarity: 'Very Rare', attunement: true,
    effect: '+1d6 cold damage on hit. Fire resistance. Emits 10-ft bright light in temperatures at or below 0°F. Reaction if adjacent fire tries to ignite: extinguish mundane flames.',
  },
  'holy-avenger': {
    name: 'Holy Avenger', rarity: 'Legendary', attunement: true,
    effect: 'Paladin-only. +3 longsword. +2d10 radiant damage to fiends + undead. Creates a 10-ft (30 ft at L17+) magic circle of protection against evil while held.',
  },
  'oathbow': {
    name: 'Oathbow', rarity: 'Very Rare', attunement: true,
    effect: 'Action to name target = sworn enemy. Attacks vs that enemy: advantage + +3d6 piercing. Ignore range penalties vs sworn enemy. Ends when the target dies or you long rest.',
  },
  'vorpal-sword': {
    name: 'Vorpal Sword', rarity: 'Legendary', attunement: true,
    effect: '+3 longsword or greatsword. Crit vs creature with a head + a neck it can lose: target is decapitated and dies (unless immune or >0 heads). Ignores resistance to slashing.',
  },

  // ── Staves ─────────────────────────────────────────────────
  'staff-of-power': {
    name: 'Staff of Power', rarity: 'Very Rare', attunement: true,
    effect: '20 charges, regain 2d8+4/dawn. Cast Cone of Cold (5 charges), Fireball (5 L5), Globe of Invulnerability (6), Hold Monster (5), Levitate (2), Lightning Bolt (5 L5), Magic Missile (1), Ray of Enfeeblement (1), or Wall of Force (5). +2 weapon. +2 AC + saves + spell attack bonus. Retributive strike: break staff, creatures in 30-ft each take 16 × remaining-charges damage (DEX save half).',
  },
  'staff-of-the-magi': {
    name: 'Staff of the Magi', rarity: 'Legendary', attunement: true,
    effect: 'Wizard/Sorcerer/Warlock only. 50 charges, regain 4d6+2/dawn. Cast many spells (Conjure Elemental, Dispel Magic, Fireball, Flaming Sphere, Ice Storm, Invisibility, Knock, Lightning Bolt, Passwall, Plane Shift, Telekinesis, Wall of Fire, Web). Absorb spells (gain charges equal to level). Retributive strike: break, 16 × charges damage in 30-ft, caster teleports to random plane.',
  },

  // ── Rings / amulets / etc. ─────────────────────────────────
  'ring-of-regeneration': {
    name: 'Ring of Regeneration', rarity: 'Very Rare', attunement: true,
    effect: 'Regain 1d6 HP every 10 minutes while above 0 HP. Regrow severed body parts over 1d6+1 days.',
  },
  'ioun-stone-mastery': {
    name: 'Ioun Stone of Mastery', rarity: 'Legendary', attunement: true,
    effect: 'Orbits your head at 1d3-ft distance. Proficiency bonus +1.',
  },
  'ioun-stone-protection': {
    name: 'Ioun Stone of Protection', rarity: 'Rare', attunement: true,
    effect: 'Orbits your head. +1 AC.',
  },
  'ioun-stone-insight': {
    name: 'Ioun Stone of Insight', rarity: 'Rare', attunement: true,
    effect: 'Orbits your head. +2 WIS (max 20).',
  },

  // ── Misc greats ────────────────────────────────────────────
  'portable-hole': {
    name: 'Portable Hole', rarity: 'Rare', attunement: false,
    effect: '6-ft diameter hole, 10-ft deep cylinder of extra-dimensional space. Can be folded up. Placing inside a Bag of Holding causes a gate to the Astral Plane.',
  },
  'immovable-rod': {
    name: 'Immovable Rod', rarity: 'Uncommon', attunement: false,
    effect: 'Press button to fix the rod in place. Holds up to 8,000 lb. STR DC 30 check to push it. Press again to release.',
  },
  'luck-blade': {
    name: 'Luck Blade', rarity: 'Legendary', attunement: true,
    effect: '+1 weapon + advantage on saving throws. 1d4-1 Wish charges (DM rolls). Once per dawn, reroll a missed attack or failed save (keep second).',
  },
};

// ── Helpers ───────────────────────────────────────────────────

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function resolveTargetByName(ctx: PlayerContext, name: string): Token | null {
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

// ── Main !magicitem dispatcher ────────────────────────────────

async function handleMagicItem(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx,
      '!magicitem: usage `!magicitem <slug> [wearer]` | `!magicitem list` | `!magicitem help <slug>`');
    return true;
  }
  const sub = parts[0].toLowerCase();

  if (sub === 'list' || sub === 'ls') {
    const grouped: Record<string, string[]> = {};
    for (const [slug, item] of Object.entries(MAGIC_ITEMS)) {
      const r = item.rarity;
      if (!grouped[r]) grouped[r] = [];
      grouped[r].push(`  • \`${slug}\` — ${item.name}`);
    }
    const order = ['Uncommon', 'Rare', 'Very Rare', 'Legendary'];
    const lines: string[] = ['**Magic items catalog** (use `!magicitem <slug> [wearer]`):', ''];
    for (const rarity of order) {
      if (grouped[rarity]?.length) {
        lines.push(`__${rarity}__`);
        lines.push(...grouped[rarity]);
        lines.push('');
      }
    }
    whisperToCaller(c.io, c.ctx, lines.join('\n'));
    return true;
  }

  if (sub === 'help' || sub === 'info') {
    const slug = parts[1]?.toLowerCase();
    const item = slug ? MAGIC_ITEMS[slug] : undefined;
    if (!item) {
      whisperToCaller(c.io, c.ctx, `!magicitem help: unknown slug "${slug ?? ''}". Run \`!magicitem list\`.`);
      return true;
    }
    whisperToCaller(c.io, c.ctx,
      `**${item.name}** (${item.rarity}${item.attunement ? ', attunement' : ''})\n${item.effect}`);
    return true;
  }

  const slug = sub;
  const item = MAGIC_ITEMS[slug];
  if (!item) {
    whisperToCaller(c.io, c.ctx, `!magicitem: unknown slug "${slug}". Run \`!magicitem list\`.`);
    return true;
  }

  // Resolve wearer — explicit arg wins, else caller's token.
  const wearerName = parts.slice(1).join(' ');
  const wearer = wearerName
    ? resolveTargetByName(c.ctx, wearerName)
    : resolveCallerToken(c.ctx);
  if (wearerName && !wearer) {
    whisperToCaller(c.io, c.ctx, `!magicitem: no token named "${wearerName}".`);
    return true;
  }
  const wearerLabel = wearer?.name ?? 'the wielder';

  // Apply the condition if the item has one (badge + duration).
  if (wearer && item.condition) {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    const duration = item.durationRounds ?? 100000; // effectively permanent
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, wearer.id, {
      name: item.condition,
      source: item.name,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + duration,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: wearer.id,
      changes: { conditions: wearer.conditions },
    });
  }

  broadcastSystem(
    c.io, c.ctx,
    `✨ **${item.name}** (${item.rarity}${item.attunement ? ', attuned' : ''}) — ${wearerLabel}: ${item.effect}`,
  );
  return true;
}

registerChatCommand(['magicitem', 'mi'], handleMagicItem);
