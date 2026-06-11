export const LEGACY_PUBLIC_ASSET_BASE_URL = 'https://storage.googleapis.com/atlas-bound-data';
export const CURRENT_PUBLIC_ASSET_BASE_URL =
  'https://storage.googleapis.com/atlas-bound-public-assets-personal';

export const LEGACY_PUBLIC_ASSET_PREFIX = `${LEGACY_PUBLIC_ASSET_BASE_URL}/`;
export const CURRENT_PUBLIC_ASSET_PREFIX = `${CURRENT_PUBLIC_ASSET_BASE_URL}/`;

export interface PublicAssetUrlMigrationTarget {
  table: string;
  column: string;
  description: string;
}

export const PUBLIC_ASSET_URL_MIGRATION_TARGETS: PublicAssetUrlMigrationTarget[] = [
  {
    table: 'maps',
    column: 'image_url',
    description: 'custom/prebuilt map image URLs',
  },
  {
    table: 'maps',
    column: 'thumbnail_url',
    description: 'custom map thumbnail URLs',
  },
  {
    table: 'tokens',
    column: 'image_url',
    description: 'map token image URLs',
  },
  {
    table: 'characters',
    column: 'portrait_url',
    description: 'character portrait URLs',
  },
  {
    table: 'characters',
    column: 'inventory',
    description: 'character inventory JSON with embedded item image URLs',
  },
  {
    table: 'custom_items',
    column: 'image_url',
    description: 'homebrew item image URLs',
  },
  {
    table: 'custom_monsters',
    column: 'image_url',
    description: 'homebrew monster image URLs',
  },
  {
    table: 'custom_spells',
    column: 'image_url',
    description: 'homebrew spell image URLs',
  },
  {
    table: 'encounter_presets',
    column: 'creatures',
    description: 'encounter preset JSON with embedded creature image URLs',
  },
  {
    table: 'session_notes',
    column: 'image_url',
    description: 'handout/note image URLs',
  },
  {
    table: 'session_notes',
    column: 'content',
    description: 'handout/note content that may contain public asset links',
  },
];

export function replaceLegacyPublicAssetUrls(value: string): string {
  return value.split(LEGACY_PUBLIC_ASSET_PREFIX).join(CURRENT_PUBLIC_ASSET_PREFIX);
}

export function countLegacyPublicAssetUrls(value: string): number {
  if (!value) return 0;
  return value.split(LEGACY_PUBLIC_ASSET_PREFIX).length - 1;
}

export function quoteSqlIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
