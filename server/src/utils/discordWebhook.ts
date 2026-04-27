/**
 * Discord webhook notifier for user-submitted feedback.
 *
 * Fires a fire-and-forget POST to `DISCORD_FEEDBACK_WEBHOOK_URL` after
 * a feedback row lands in the database. Designed to *never* block or
 * fail the user's submission:
 *
 *   - Errors are caught and logged at warn-level only.
 *   - No retries; webhook delivery is best-effort.
 *   - When the webhook URL is unset (dev, tests, mis-configured prod)
 *     the notifier no-ops cleanly so the feedback row is still saved
 *     and the user still gets a 201.
 *
 * Anonymous submissions are honoured: name/email are never sent to
 * Discord when `anonymous = true`. The page URL, app version, and
 * sanitised content snippet are always included so triage is fast.
 */

import { DISCORD_FEEDBACK_WEBHOOK_URL, BASE_URL } from '../config.js';

export interface FeedbackWebhookPayload {
  id: string;
  category: 'bug' | 'feature' | 'ux' | 'other';
  content: string;
  pageUrl: string | null;
  browser: string | null;
  appVersion: string | null;
  sessionId: string | null;
  anonymous: boolean;
  /** Submitting user's display name. Omitted from Discord when anonymous=true. */
  userDisplayName: string | null;
  /** Submitting user's email. Omitted from Discord when anonymous=true. */
  userEmail: string | null;
}

const CATEGORY_DRESSING: Record<FeedbackWebhookPayload['category'], { emoji: string; color: number; label: string }> = {
  // Discord embed colors are 0xRRGGBB integers.
  bug:     { emoji: '🐞', color: 0xc0392b, label: 'Bug' },
  feature: { emoji: '✨', color: 0xd4a843, label: 'Feature' },
  ux:      { emoji: '🎨', color: 0x6aa9d1, label: 'UX' },
  other:   { emoji: '💬', color: 0x95a5a6, label: 'Other' },
};

/**
 * Build the Discord webhook JSON body for a feedback row. Pure
 * function (no I/O) so we can unit-test the payload shape without a
 * live webhook.
 */
export function buildFeedbackEmbed(p: FeedbackWebhookPayload): unknown {
  const dressing = CATEGORY_DRESSING[p.category] ?? CATEGORY_DRESSING.other;

  // Truncate content to 1500 chars to leave headroom under Discord's
  // 4096-char description limit and avoid noisy walls of text. Admins
  // who want the full text click through to the admin panel.
  const trimmed = p.content.length > 1500
    ? `${p.content.slice(0, 1500)}\u2026`
    : p.content;

  // Identity line — scrubbed when anonymous.
  const submitter = p.anonymous
    ? '*(anonymous)*'
    : (p.userDisplayName ?? p.userEmail ?? 'Unknown user');

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (p.pageUrl) {
    fields.push({ name: 'Page', value: truncateField(p.pageUrl, 1024), inline: true });
  }
  if (p.appVersion) {
    fields.push({ name: 'Version', value: truncateField(p.appVersion, 1024), inline: true });
  }
  if (p.sessionId) {
    // Show the first 8 chars only — full UUIDs are noisy and admins
    // can pivot from the admin panel if they need the full id.
    fields.push({ name: 'Session', value: p.sessionId.slice(0, 8), inline: true });
  }
  if (p.browser) {
    fields.push({ name: 'Browser', value: truncateField(p.browser, 1024) });
  }

  // Deep-link to the admin panel so the on-call human can review +
  // triage in one click. Falls back to the bare admin path if BASE_URL
  // isn't set (dev).
  const adminUrl = `${BASE_URL.replace(/\/$/, '')}/admin/feedback`;

  // Thread title for forum-channel webhooks. Discord requires
  // `thread_name` (≤100 chars) on any webhook posted to a forum
  // channel — each submission becomes its own thread, which is also
  // a nicer triage UX than a flat firehose. Regular text-channel
  // webhooks ignore the field, so it's safe to send unconditionally.
  const summary = p.content.replace(/\s+/g, ' ').trim().slice(0, 70);
  const threadName = `${dressing.emoji} ${dressing.label}: ${summary || '(no summary)'}`.slice(0, 100);

  return {
    // Username + avatar override on the webhook so the bot identity
    // is consistent regardless of which Discord channel hosts the
    // webhook. (No avatar URL — Discord falls back to the channel
    // default, which is fine.)
    username: 'Atlas Bound · Feedback',
    thread_name: threadName,
    embeds: [
      {
        title: `${dressing.emoji} ${dressing.label} — from ${submitter}`,
        description: trimmed,
        color: dressing.color,
        fields,
        footer: {
          text: `Review at ${adminUrl}`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Discord field values cap at 1024 chars; trim hard to stay safe. */
function truncateField(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

/**
 * Result of a webhook POST. `threadUrl` is the deep-link to the Discord
 * thread that received this submission — populated when the POST used
 * `?wait=true` and the surrounding guild_id was discoverable via
 * a webhook GET. Null when the webhook URL is unset, when Discord
 * rejected the post, or when the guild lookup failed.
 *
 * Callers (routes/feedback.ts) persist `threadUrl` on the feedback row
 * so a later release announcement can deep-link back to the original
 * report. The "ok" boolean is kept for backwards compat with callers
 * that only care whether delivery succeeded.
 */
export interface FeedbackWebhookResult {
  ok: boolean;
  threadUrl: string | null;
}

// guild_id is the same for every post against a given webhook URL, so
// resolve once on first call and cache for the lifetime of the
// process. A new deploy reseeds the cache cheaply.
const guildIdCache = new Map<string, string | null>();

/**
 * Test-only escape hatch: clear the guild_id cache. Production code
 * never calls this — the module's natural lifecycle reseeds via
 * deploy. Tests need it to assert behaviour at "first call".
 */
export function _resetGuildIdCache(): void {
  guildIdCache.clear();
}

async function resolveGuildId(webhookUrl: string): Promise<string | null> {
  const cached = guildIdCache.get(webhookUrl);
  if (cached !== undefined) return cached;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3_000);
    const res = await fetch(webhookUrl, { method: 'GET', signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
    if (!res.ok) {
      guildIdCache.set(webhookUrl, null);
      return null;
    }
    const data = (await res.json()) as { guild_id?: string };
    const gid = data.guild_id ?? null;
    guildIdCache.set(webhookUrl, gid);
    return gid;
  } catch {
    guildIdCache.set(webhookUrl, null);
    return null;
  }
}

/**
 * Construct a https://discord.com/channels/<guild>/<channel> URL.
 * Channel here is the *thread id* when the webhook target is a forum
 * channel — that's exactly what we want for a deep-link to the
 * per-feedback thread. Exported so the releases webhook can build the
 * same shape from message_ids it captures.
 */
export function buildDiscordThreadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

/**
 * Send the feedback notification. Returns the thread URL when Discord
 * accepts the post AND the guild_id lookup succeeds — so a later
 * release announcement can back-link to this submission. Errors are
 * swallowed; callers should treat the return value as best-effort and
 * never block the user's submission on it.
 */
export async function sendFeedbackWebhook(payload: FeedbackWebhookPayload): Promise<FeedbackWebhookResult> {
  if (!DISCORD_FEEDBACK_WEBHOOK_URL) return { ok: false, threadUrl: null };

  const body = buildFeedbackEmbed(payload);
  // ?wait=true tells Discord to return the created message in the
  // response body, including its `channel_id` (== thread_id for
  // forum-channel webhooks). Without this flag the response is 204
  // with an empty body and we'd have no way to construct a deep-link.
  const url = DISCORD_FEEDBACK_WEBHOOK_URL.includes('?')
    ? `${DISCORD_FEEDBACK_WEBHOOK_URL}&wait=true`
    : `${DISCORD_FEEDBACK_WEBHOOK_URL}?wait=true`;

  try {
    // 5-second timeout via AbortController — Discord usually responds
    // in <100 ms, but we don't want a hung webhook to keep the request
    // handler's promise alive forever (Cloud Run charges per CPU-second).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      console.warn(
        `[discordWebhook] non-2xx status ${res.status} from Discord — feedback ${payload.id} not announced`,
      );
      return { ok: false, threadUrl: null };
    }

    const msg = (await res.json().catch(() => null)) as { channel_id?: string } | null;
    if (!msg?.channel_id) return { ok: true, threadUrl: null };

    const guildId = await resolveGuildId(DISCORD_FEEDBACK_WEBHOOK_URL);
    const threadUrl = guildId ? buildDiscordThreadUrl(guildId, msg.channel_id) : null;
    return { ok: true, threadUrl };
  } catch (err) {
    // Network blip, timeout, DNS, malformed URL. We deliberately do
    // NOT rethrow — the user's submission already succeeded; the
    // webhook is purely a side channel.
    console.warn(
      `[discordWebhook] webhook delivery failed for feedback ${payload.id}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, threadUrl: null };
  }
}
