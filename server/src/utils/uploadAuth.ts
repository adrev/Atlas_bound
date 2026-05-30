import pool from '../db/connection.js';

export async function canReadUploadedMapAsset(
  assetUrl: string,
  userId: string,
  column: 'image_url' | 'thumbnail_url',
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM maps m
       JOIN sessions s ON s.id = m.session_id
       JOIN session_players sp ON sp.session_id = m.session_id
      WHERE m.${column} = $1
        AND sp.user_id = $2
        AND (sp.role = 'dm' OR s.player_map_id = m.id)
      LIMIT 1`,
    [assetUrl, userId],
  );
  return rows.length > 0;
}
