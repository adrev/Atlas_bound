export interface HeroSelectionCandidate {
  id: string;
  userId?: string | null;
}

export function pickAutoActiveHero<T extends HeroSelectionCandidate>(options: {
  current: HeroSelectionCandidate | null;
  candidates: T[];
  savedId: string | null;
  userId: string;
  isDM: boolean;
}): T | null {
  const { current, candidates, savedId, userId, isDM } = options;

  // DMs may intentionally inspect another party member; don't replace that
  // selection with the DM's own character list on background reloads.
  if (isDM && current) return null;

  const currentIsOwnedAndPresent = !!current
    && current.userId === userId
    && candidates.some((candidate) => candidate.id === current.id);

  if (currentIsOwnedAndPresent) return null;

  return candidates.find((candidate) => candidate.id === savedId)
    ?? candidates[0]
    ?? null;
}
