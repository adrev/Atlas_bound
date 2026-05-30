import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import { canReadUploadedMapAsset } from '../utils/uploadAuth.js';

beforeEach(() => {
  mockQuery.mockReset();
});

describe('canReadUploadedMapAsset', () => {
  it('authorizes when the caller is DM or the asset is the player-ribbon map', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    await expect(canReadUploadedMapAsset('/uploads/maps/cave.png', 'user-1', 'image_url'))
      .resolves.toBe(true);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("sp.role = 'dm'");
    expect(sql).toContain('s.player_map_id = m.id');
    expect(sql).not.toContain('current_map_id');
    expect(params).toEqual(['/uploads/maps/cave.png', 'user-1']);
  });

  it('rejects when the caller is neither DM nor viewing the active player map', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(canReadUploadedMapAsset('/uploads/maps/prep.png', 'player-1', 'image_url'))
      .resolves.toBe(false);
  });

  it('uses the thumbnail URL column for thumbnail reads', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    await expect(canReadUploadedMapAsset('/uploads/maps/thumbnails/cave.jpg', 'user-1', 'thumbnail_url'))
      .resolves.toBe(true);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('m.thumbnail_url = $1');
  });
});
