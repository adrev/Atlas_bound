interface FeatureLike {
  name: string;
  [key: string]: unknown;
}

function parseFeatureArray(value: unknown): FeatureLike[] | null {
  try {
    const parsed = value == null ? [] : typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (feature) =>
          typeof feature !== 'object' ||
          feature === null ||
          typeof (feature as { name?: unknown }).name !== 'string'
      )
    ) {
      return null;
    }
    return parsed as FeatureLike[];
  } catch {
    return null;
  }
}

export function serverManagedFeatureResourceKey(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (/^ki(?: points?)?$/.test(normalized)) return 'ki';
  if (/^(?:font of magic|sorcery points?)$/.test(normalized)) return 'sorcery-points';
  if (/^racial spell:\s*\S/.test(normalized)) return normalized;
  return null;
}

/**
 * Preserve resources that only server-owned actions/rests may mutate while
 * still allowing normal character-sheet feature editing.
 */
export function preserveServerManagedFeatureResources(
  existingValue: unknown,
  requestedValue: unknown
): FeatureLike[] | null {
  const existing = parseFeatureArray(existingValue);
  const requested = parseFeatureArray(requestedValue);
  if (!existing || !requested) return null;

  const existingResources = new Map<string, FeatureLike>();
  for (const feature of existing) {
    const key = serverManagedFeatureResourceKey(feature.name);
    if (!key) continue;
    if (existingResources.has(key)) return null;
    existingResources.set(key, feature);
  }

  const result: FeatureLike[] = [];
  const includedResources = new Set<string>();
  for (const feature of requested) {
    const key = serverManagedFeatureResourceKey(feature.name);
    if (!key) {
      result.push(feature);
      continue;
    }
    if (includedResources.has(key)) return null;
    includedResources.add(key);
    const authoritative = existingResources.get(key);
    if (authoritative) result.push(authoritative);
  }
  for (const [key, feature] of existingResources) {
    if (!includedResources.has(key)) result.push(feature);
  }
  return result;
}
