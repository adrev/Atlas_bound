export const PUBLIC_ASSET_BASE_URL =
  'https://storage.googleapis.com/atlas-bound-public-assets-personal';
export const LEGACY_PUBLIC_ASSET_BASE_URL = 'https://storage.googleapis.com/atlas-bound-data';

export function publicAssetUrl(path: string): string {
  return `${PUBLIC_ASSET_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

export function isKnownPublicAssetUrl(url: string): boolean {
  return (
    url.startsWith(`${PUBLIC_ASSET_BASE_URL}/`) ||
    url.startsWith(`${LEGACY_PUBLIC_ASSET_BASE_URL}/`)
  );
}
