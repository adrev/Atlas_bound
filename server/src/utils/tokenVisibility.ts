import type { Token } from '@dnd-vtt/shared';

function conditionNames(token: Token): string[] {
  return (token.conditions ?? [])
    .map((condition) => {
      if (typeof condition === 'string') return condition;
      if (condition && typeof condition === 'object' && 'name' in condition) {
        return String((condition as { name?: unknown }).name ?? '');
      }
      return '';
    })
    .map((name) => name.toLowerCase())
    .filter(Boolean);
}

export function tokenVisibleToPlayer(token: Token, viewerUserId: string): boolean {
  if (token.visible === false) return false;

  const names = conditionNames(token);
  if (names.includes('invisible') && !names.includes('outlined')) {
    return token.ownerUserId === viewerUserId;
  }

  return true;
}
