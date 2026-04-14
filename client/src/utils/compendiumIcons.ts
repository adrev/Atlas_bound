/**
 * Generates inline SVG data URIs for compendium entries (creatures, spells, items)
 * so we never 404 on missing /uploads/ images.
 */

const CREATURE_TYPE_COLORS: Record<string, string> = {
  aberration: '#7b2d8b',
  beast: '#2d5a27',
  celestial: '#c4a74a',
  construct: '#666',
  dragon: '#8b2d2d',
  elemental: '#2d6a8b',
  fey: '#6a8b2d',
  fiend: '#8b2d2d',
  giant: '#5a4a3a',
  humanoid: '#4a5a6a',
  monstrosity: '#6a3a5a',
  ooze: '#3a6a3a',
  plant: '#2d7a2d',
  undead: '#4a4a5a',
};

const SPELL_SCHOOL_COLORS: Record<string, string> = {
  abjuration: '#4a7abc',
  conjuration: '#c4a74a',
  divination: '#9a8abf',
  enchantment: '#d46a9f',
  evocation: '#c53131',
  illusion: '#7b5ea7',
  necromancy: '#4a5a4a',
  transmutation: '#d4a843',
};

const ITEM_TYPE_COLORS: Record<string, string> = {
  weapon: '#8b4513',
  armor: '#4a5a6a',
  potion: '#2d6a3a',
  ring: '#c4a74a',
  rod: '#6a4a3a',
  scroll: '#c4a74a',
  staff: '#5a4a3a',
  wand: '#7b5ea7',
  'wondrous item': '#9a3a7a',
  adventuring_gear: '#5a5a5a',
};

function makeSvgDataUri(initial: string, bgColor: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="30" fill="${bgColor}"/>` +
    `<text x="32" y="40" text-anchor="middle" font-size="28" font-weight="bold" fill="white" font-family="sans-serif">${initial}</text>` +
    `</svg>`
  )}`;
}

export function getCreatureIconUrl(name: string, type?: string): string {
  const initial = name.charAt(0).toUpperCase();
  const color = CREATURE_TYPE_COLORS[(type || '').toLowerCase()] || '#555';
  return makeSvgDataUri(initial, color);
}

export function getSpellIconUrl(name: string, school?: string): string {
  const initial = name.charAt(0).toUpperCase();
  const color = SPELL_SCHOOL_COLORS[(school || '').toLowerCase()] || '#3a6a9a';
  return makeSvgDataUri(initial, color);
}

export function getItemIconUrl(name: string, type?: string): string {
  const initial = name.charAt(0).toUpperCase();
  const color = ITEM_TYPE_COLORS[(type || '').toLowerCase()] || '#5a5a5a';
  return makeSvgDataUri(initial, color);
}

/**
 * Returns a placeholder icon URL for any compendium category.
 */
export function getCompendiumIconUrl(
  name: string,
  category: 'monsters' | 'spells' | 'items' | string,
  subtype?: string,
): string {
  switch (category) {
    case 'monsters': return getCreatureIconUrl(name, subtype);
    case 'spells': return getSpellIconUrl(name, subtype);
    case 'items': return getItemIconUrl(name, subtype);
    default: return makeSvgDataUri(name.charAt(0).toUpperCase(), '#555');
  }
}
