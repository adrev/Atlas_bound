/**
 * Atlas Bound — approved emoji palette.
 *
 * Per the UI unification plan, emojis are explicitly part of the
 * Dungeon Master visual style. Instead of every component picking
 * random emojis, this file codifies the approved set per feature area.
 *
 * ### Rules
 * 1. **Per-row consistency** — within a single list or row, all icons
 *    must come from ONE source. Don't mix a lucide `<X />` and a 🗑️
 *    in the same context menu.
 * 2. **Buttons** — a button takes EITHER an emoji OR a lucide icon,
 *    never both. Text-only buttons are fine.
 * 3. **Chat/toasts/result messages** are the richest emoji area —
 *    they're ephemeral and narrative, so emoji decoration is
 *    encouraged.
 * 4. **Modal & tooltip headers** — one leading emoji as an accent
 *    is encouraged, e.g. "⚔️ Attack Roll", "✨ Spell Cast".
 *
 * ### Adding new emojis
 * Add to the appropriate category. If a new category is needed,
 * keep it tightly scoped. Never add an emoji directly in a
 * component — always route through this file.
 */
export const EMOJI = {
  // Combat actions & outcomes
  combat: {
    attack: '⚔️',
    crit: '💥',
    hit: '🎯',
    miss: '💨',
    // Force the emoji variation selector (U+FE0F) so the shield
    // glyph renders as a color emoji everywhere instead of falling
    // back to the monochrome text form on older Windows builds where
    // the plain 🛡 codepoint was blank for some players.
    dodge: '🛡️',
    shield: '🛡️',
    cast: '✨',
    counterspell: '🚫',
    dead: '💀',
    opportunity: '⚡',
    initiative: '🎲',
    disengage: '🏃',
  },

  // Health / hit points
  hp: {
    full: '❤️',
    wounded: '❤️‍🩹',
    low: '🩸',
    temp: '💙',
    heal: '💚',
    damage: '💥',
  },

  // Status indicators (use sparingly — these are often better as lucide icons)
  status: {
    ok: '✓',
    fail: '✗',
    pending: '⏱',
    warning: '⚠️',
    locked: '🔒',
  },

  // Rest & recovery
  rest: {
    long: '💤',
    short: '🌙',
    food: '🍞',
    campfire: '🔥',
  },

  // Map / scene manager
  map: {
    ribbon: '🟡',
    viewing: '👁',
    scene: '🗺',
    pin: '📍',
    dm: '🎭',
    travel: '🧭',
  },

  // Loot & treasure
  loot: {
    gold: '💰',
    gem: '💎',
    scroll: '📜',
    chest: '📦',
    weapon: '⚔️',
    potion: '🧪',
    ring: '💍',
    key: '🗝',
  },

  // Spell elements / damage types
  elements: {
    fire: '🔥',
    ice: '❄️',
    lightning: '⚡',
    acid: '🧪',
    poison: '☠️',
    radiant: '🌟',
    necrotic: '💀',
    force: '💠',
    psychic: '🧠',
    thunder: '🌩',
    bludgeoning: '🔨',
    piercing: '🏹',
    slashing: '⚔️',
  },

  // Dice & rolls
  dice: {
    d20: '🎲',
    advantage: '⬆',
    disadvantage: '⬇',
    reroll: '🔄',
  },

  // Character classes (for quick visual hints)
  classes: {
    bard: '🎵',
    cleric: '✝',
    druid: '🌿',
    fighter: '⚔️',
    monk: '🥋',
    paladin: '🛡',
    ranger: '🏹',
    rogue: '🗡',
    sorcerer: '🔮',
    warlock: '😈',
    wizard: '🪄',
    artificer: '⚙',
    barbarian: '🪓',
  },
} as const;

/**
 * Convenience lookup for damage type → emoji. Covers the 13 D&D 5e
 * damage types with fallback to a generic '⚔️'.
 */
export function damageTypeEmoji(damageType: string | undefined | null): string {
  if (!damageType) return EMOJI.combat.attack;
  const lower = damageType.toLowerCase();
  const elements = EMOJI.elements as Record<string, string>;
  return elements[lower] ?? EMOJI.combat.attack;
}
