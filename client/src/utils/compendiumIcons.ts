/**
 * Compendium image URLs — uses GCS-hosted artwork with inline SVG fallback.
 *
 * ~4600 creature tokens, ~1400 spell icons, ~1700 item icons are hosted on
 * Google Cloud Storage. When artwork exists, the PNG is used. When it doesn't
 * (or fails to load), we fall back to an inline SVG colored initial.
 */

const CDN = 'https://storage.googleapis.com/atlas-bound-data';

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

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function makeSvgFallback(initial: string, bgColor: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="30" fill="${bgColor}"/>` +
    `<text x="32" y="40" text-anchor="middle" font-size="28" font-weight="bold" fill="white" font-family="sans-serif">${initial}</text>` +
    `</svg>`
  )}`;
}

/** Primary creature image URL (PNG on GCS) */
export function getCreatureImageUrl(name: string): string {
  return `${CDN}/tokens/${slugify(name)}.png`;
}

/** SVG creature image URL (GCS) */
export function getCreatureImageSvgUrl(name: string): string {
  return `${CDN}/tokens/${slugify(name)}.svg`;
}

/** Inline SVG fallback for when GCS image doesn't exist */
export function getCreatureIconUrl(name: string, type?: string): string {
  const initial = name.charAt(0).toUpperCase();
  const color = CREATURE_TYPE_COLORS[(type || '').toLowerCase()] || '#555';
  return makeSvgFallback(initial, color);
}

/** Primary spell image URL (PNG on GCS) */
export function getSpellImageUrl(name: string): string {
  return `${CDN}/spells/${slugify(name)}.png`;
}

export function getSpellIconUrl(name: string, school?: string): string {
  const initial = name.charAt(0).toUpperCase();
  const color = SPELL_SCHOOL_COLORS[(school || '').toLowerCase()] || '#3a6a9a';
  return makeSvgFallback(initial, color);
}

/** Primary item image URL (PNG on GCS) */
export function getItemImageUrl(name: string): string {
  return `${CDN}/items/${slugify(name)}.png`;
}

export function getItemIconUrl(name: string, type?: string): string {
  const initial = name.charAt(0).toUpperCase();
  const color = ITEM_TYPE_COLORS[(type || '').toLowerCase()] || '#5a5a5a';
  return makeSvgFallback(initial, color);
}

/**
 * Returns the primary GCS image URL for any compendium category.
 * Use with an onError fallback to getCompendiumFallbackUrl.
 */
export function getCompendiumImageUrl(
  name: string,
  category: 'monsters' | 'spells' | 'items' | string,
): string {
  switch (category) {
    case 'monsters': return getCreatureImageUrl(name);
    case 'spells': return getSpellImageUrl(name);
    case 'items': return getItemImageUrl(name);
    default: return makeSvgFallback(name.charAt(0).toUpperCase(), '#555');
  }
}

/**
 * Returns an inline SVG fallback URL for any compendium category.
 */
export function getCompendiumFallbackUrl(
  name: string,
  category: 'monsters' | 'spells' | 'items' | string,
  subtype?: string,
): string {
  switch (category) {
    case 'monsters': return getCreatureIconUrl(name, subtype);
    case 'spells': return getSpellIconUrl(name, subtype);
    case 'items': return getItemIconUrl(name, subtype);
    default: return makeSvgFallback(name.charAt(0).toUpperCase(), '#555');
  }
}
