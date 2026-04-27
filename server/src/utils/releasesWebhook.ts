/**
 * Discord webhook for release announcements.
 *
 * Fires when an admin publishes a patch-kind tiding. Mirrors the
 * feedback-webhook pattern (?wait=true so we get the message back,
 * fire-and-forget delivery, no retries) but routes to a dedicated
 * channel — `DISCORD_RELEASES_WEBHOOK_URL` — and embeds clickable
 * back-links to the user-feedback threads that motivated each item.
 *
 * Layout of the embed:
 *
 *   📜 Patch 0.7.4 · "Brass-bound Lobby"
 *   <body — typically a short paragraph or bullet list>
 *
 *   Addressed feedback:
 *   • 🐞 Bug: Wiki search broken on partial words
 *     ↳ https://discord.com/channels/<guild>/<thread-id>
 *   • ✨ Feature: Add Hide action
 *     ↳ https://discord.com/channels/<guild>/<thread-id>
 *
 *   Read more on the Great Hall →
 *
 * Linked feedback is OPTIONAL — releases without user-feedback context
 * (e.g. infrastructure changes) still post a clean announcement.
 */

import { DISCORD_RELEASES_WEBHOOK_URL, BASE_URL } from '../config.js';
import { buildDiscordThreadUrl } from './discordWebhook.js';

export interface LinkedFeedbackSummary {
  /** Feedback row id — kept so the admin UI can sanity-check the
   *  link survived the round-trip. */
  id: string;
  category: 'bug' | 'feature' | 'ux' | 'other';
  /** First ~60 chars of the original feedback content; used as the
   *  bullet line in the release embed. */
  summary: string;
  /** The original feedback's Discord thread URL captured when the
   *  feedback webhook ran. Null when feedback predates the URL
   *  capture path or the original webhook delivery failed. */
  threadUrl: string | null;
}

export interface ReleaseWebhookPayload {
  tidingId: string;
  /** 'patch' is the only kind that triggers a release announcement
   *  today, but we keep the shape generic in case 'content' drops want
   *  to surface here too in the future. */
  kind: 'patch' | 'content' | 'announcement';
  title: string;
  body: string;
  versionTag: string | null;
  linkedFeedback: LinkedFeedbackSummary[];
}

const KIND_DRESSING: Record<ReleaseWebhookPayload['kind'], { emoji: string; color: number; label: string }> = {
  patch:        { emoji: '📜', color: 0xe0b44f, label: 'Release' },
  content:      { emoji: '✨', color: 0xc79632, label: 'Content Drop' },
  announcement: { emoji: '🛡️', color: 0x6aa9d1, label: 'Announcement' },
};

const CATEGORY_EMOJI: Record<LinkedFeedbackSummary['category'], string> = {
  bug: '🐞', feature: '✨', ux: '🎨', other: '💬',
};

/**
 * Cache the resolved guild_id per webhook URL — Discord's webhook GET
 * returns it once and the value is stable for the lifetime of the
 * webhook.
 */
const guildIdCache = new Map<string, string | null>();

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

/** Test-only escape hatch — see discordWebhook.ts for rationale. */
export function _resetReleasesGuildIdCache(): void {
  guildIdCache.clear();
}

/**
 * Build the embed body. Pure function (no I/O). Exported so unit
 * tests can assert the shape without spinning up a fetch mock.
 */
export function buildReleaseEmbed(p: ReleaseWebhookPayload): unknown {
  const dressing = KIND_DRESSING[p.kind] ?? KIND_DRESSING.announcement;
  const versionPart = p.versionTag ? `${p.versionTag} · ` : '';
  const titleLine = `${dressing.emoji} ${dressing.label} ${versionPart}${p.title}`;

  // Body section. Trim hard so the embed stays well under Discord's
  // 4096-char description ceiling — admins can park the long version
  // in expandedBody on the lobby instead.
  const bodyTrimmed = p.body.length > 1500 ? `${p.body.slice(0, 1500)}\u2026` : p.body;

  // Build the "Addressed feedback" section as a compact bullet list.
  // Each line is one feedback row: emoji, summary, then a sub-line
  // with the Discord thread URL (if we have one). When a row has no
  // captured threadUrl we still surface the summary — useful context
  // even without a clickable link.
  let feedbackSection = '';
  if (p.linkedFeedback.length > 0) {
    const lines = p.linkedFeedback.map((f) => {
      const emoji = CATEGORY_EMOJI[f.category] ?? '💬';
      const summary = f.summary.replace(/\s+/g, ' ').trim();
      const summaryClipped = summary.length > 100 ? `${summary.slice(0, 100)}\u2026` : summary;
      const link = f.threadUrl ? `\n   ↳ ${f.threadUrl}` : '';
      return `• ${emoji} ${summaryClipped}${link}`;
    });
    feedbackSection = `\n\n**Addressed feedback:**\n${lines.join('\n')}`;
  }

  const lobbyLink = `${BASE_URL.replace(/\/$/, '')}/`;
  const description = `${bodyTrimmed}${feedbackSection}\n\n[Read more on the Great Hall →](${lobbyLink})`;

  // Forum-channel webhooks need a thread_name (≤100 chars). Use the
  // version tag + title so the sidebar reads as the release name.
  const threadName = `${dressing.emoji} ${versionPart}${p.title}`.slice(0, 100);

  return {
    username: 'Atlas Bound · Releases',
    thread_name: threadName,
    embeds: [
      {
        title: titleLine.slice(0, 256), // Discord caps embed.title at 256
        description: description.slice(0, 4000),
        color: dressing.color,
        timestamp: new Date().toISOString(),
        footer: { text: `Tiding ${p.tidingId}` },
      },
    ],
  };
}

export interface ReleaseWebhookResult {
  ok: boolean;
  threadUrl: string | null;
}

/**
 * POST a release announcement to the Releases Discord channel.
 * Same fire-and-forget contract as sendFeedbackWebhook — never throws,
 * never blocks the user's request, returns the thread URL when
 * delivery + guild_id discovery both succeed so the caller can stamp
 * `discord_thread_url` onto the tiding row.
 */
export async function sendReleaseWebhook(payload: ReleaseWebhookPayload): Promise<ReleaseWebhookResult> {
  if (!DISCORD_RELEASES_WEBHOOK_URL) return { ok: false, threadUrl: null };

  const body = buildReleaseEmbed(payload);
  const url = DISCORD_RELEASES_WEBHOOK_URL.includes('?')
    ? `${DISCORD_RELEASES_WEBHOOK_URL}&wait=true`
    : `${DISCORD_RELEASES_WEBHOOK_URL}?wait=true`;

  try {
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
        `[releasesWebhook] non-2xx status ${res.status} from Discord — tiding ${payload.tidingId} not announced`,
      );
      return { ok: false, threadUrl: null };
    }

    const msg = (await res.json().catch(() => null)) as { channel_id?: string } | null;
    if (!msg?.channel_id) return { ok: true, threadUrl: null };

    const guildId = await resolveGuildId(DISCORD_RELEASES_WEBHOOK_URL);
    const threadUrl = guildId ? buildDiscordThreadUrl(guildId, msg.channel_id) : null;
    return { ok: true, threadUrl };
  } catch (err) {
    console.warn(
      `[releasesWebhook] webhook delivery failed for tiding ${payload.tidingId}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, threadUrl: null };
  }
}
