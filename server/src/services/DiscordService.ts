import pool from '../db/connection.js';

/**
 * Discord webhook integration for session events.
 *
 * The DM pastes a webhook URL into the session settings; we POST a
 * small embed to it when interesting things happen (combat start /
 * end, handouts, etc). Cheap, no bot required, no OAuth dance.
 *
 * Safety:
 *   - The schema validator only accepts https://discord.com/api/webhooks/…
 *     and https://discordapp.com/api/webhooks/… URLs. No other origin can
 *     reach this function.
 *   - 2s request timeout. Errors are swallowed so a flaky webhook never
 *     blocks the socket handler that triggered the notification.
 *   - No user-generated strings are interpolated raw into the payload
 *     without length capping (Discord rejects embeds >4000 chars anyway).
 */

const TIMEOUT_MS = 2000;
const MAX_EMBED_CHARS = 2000;

export interface SessionEventEmbed {
  title: string;
  description?: string;
  color?: number;     // decimal RGB
  footer?: string;
}

/**
 * Send an embed to the session's configured webhook. No-op if none set.
 */
export async function notifySession(
  sessionId: string,
  embed: SessionEventEmbed,
): Promise<void> {
  let url: string | null = null;
  try {
    const { rows } = await pool.query(
      'SELECT discord_webhook_url FROM sessions WHERE id = $1',
      [sessionId],
    );
    url = (rows[0]?.discord_webhook_url as string | null) ?? null;
  } catch {
    return;
  }
  if (!url) return;

  const body = JSON.stringify({
    embeds: [{
      title: truncate(embed.title, 256),
      description: embed.description ? truncate(embed.description, MAX_EMBED_CHARS) : undefined,
      color: embed.color ?? 0xd4a257, // default gold
      footer: embed.footer ? { text: truncate(embed.footer, 128) } : undefined,
      timestamp: new Date().toISOString(),
    }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch {
    // Ignore — webhook failures are not worth propagating. Log keeps
    // the tail-grep useful without crashing the request chain.
    console.warn('[discord] webhook post failed for session', sessionId);
  } finally {
    clearTimeout(timer);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
