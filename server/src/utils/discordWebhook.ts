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
 * Send the feedback notification. Resolves immediately on success or
 * any failure mode — callers should `await` it only if they care
 * about the awaitable for tests; in the request handler we just call
 * it and move on. Returns `true` if the POST returned a 2xx status,
 * `false` otherwise (including when the webhook URL is unset).
 */
export async function sendFeedbackWebhook(payload: FeedbackWebhookPayload): Promise<boolean> {
  if (!DISCORD_FEEDBACK_WEBHOOK_URL) return false;

  const body = buildFeedbackEmbed(payload);

  try {
    // 5-second timeout via AbortController — Discord usually responds
    // in <100 ms, but we don't want a hung webhook to keep the request
    // handler's promise alive forever (Cloud Run charges per CPU-second).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);

    const res = await fetch(DISCORD_FEEDBACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      console.warn(
        `[discordWebhook] non-2xx status ${res.status} from Discord — feedback ${payload.id} not announced`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // Anything else (network blip, timeout, DNS, malformed URL) lands here.
    // We deliberately do NOT rethrow — the user's submission already
    // succeeded; the webhook is purely a side channel.
    console.warn(
      `[discordWebhook] webhook delivery failed for feedback ${payload.id}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
