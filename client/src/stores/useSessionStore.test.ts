import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from './useSessionStore';
import type { Player } from '@dnd-vtt/shared';

function player(overrides: Partial<Player> = {}): Player {
  return {
    userId: 'user-player',
    displayName: 'Characterless Player',
    avatarUrl: null,
    role: 'player',
    characterId: null,
    connected: true,
    ...overrides,
  };
}

describe('useSessionStore roster presence', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
  });

  it('marks a disconnected member offline instead of removing them from the roster', () => {
    useSessionStore.setState({
      players: [
        player(),
        player({ userId: 'user-dm', displayName: 'DM', role: 'dm' }),
      ],
    } as never);

    useSessionStore.getState().setPlayerConnected('user-player', false);

    const row = useSessionStore.getState().players.find((p) => p.userId === 'user-player');
    expect(row).toMatchObject({
      displayName: 'Characterless Player',
      characterId: null,
      connected: false,
    });
    expect(useSessionStore.getState().players).toHaveLength(2);
  });

  it('upserts a character-less presence update back online', () => {
    useSessionStore.setState({
      players: [player({ connected: false })],
    } as never);

    useSessionStore.getState().addPlayer(player({
      avatarUrl: 'https://example.test/avatar.png',
      connected: true,
    }));

    expect(useSessionStore.getState().players).toEqual([
      player({
        avatarUrl: 'https://example.test/avatar.png',
        connected: true,
      }),
    ]);
  });
});
