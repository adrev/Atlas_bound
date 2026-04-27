/**
 * Discord webhook tests.
 *
 * Two layers of coverage:
 *  - `buildFeedbackEmbed`: pure-function payload shape (no I/O).
 *    Quick to run, cheap to maintain, catches schema regressions.
 *  - `sendFeedbackWebhook`: uses a `vi.fn()` fetch stub to verify the
 *    HTTP path — that we POST exactly once, that errors don't throw,
 *    and that the no-URL case skips the network entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { DISCORD_FEEDBACK_WEBHOOK_URL: '', BASE_URL: 'https://kbrt.ai' },
}));

vi.mock('../config.js', () => ({
  get DISCORD_FEEDBACK_WEBHOOK_URL() { return mockEnv.DISCORD_FEEDBACK_WEBHOOK_URL; },
  get BASE_URL() { return mockEnv.BASE_URL; },
}));

import { buildFeedbackEmbed, sendFeedbackWebhook, _resetGuildIdCache, type FeedbackWebhookPayload } from '../utils/discordWebhook.js';

const basePayload: FeedbackWebhookPayload = {
  id: 'fb-123',
  category: 'bug',
  content: 'Something broke when I clicked the wiki link.',
  pageUrl: 'https://kbrt.ai/session/AB12',
  browser: 'Mozilla/5.0',
  appVersion: '1.0.0',
  sessionId: '00000000-0000-0000-0000-000000000abc',
  anonymous: false,
  userDisplayName: 'Alice',
  userEmail: 'alice@example.com',
};

describe('buildFeedbackEmbed', () => {
  it('uses the per-category emoji + color', () => {
    const out = buildFeedbackEmbed(basePayload) as any;
    const embed = out.embeds[0];
    expect(embed.title).toMatch(/^🐞 Bug — from Alice/);
    expect(embed.color).toBe(0xc0392b);
  });

  it('scrubs identity when the submitter ticked anonymous', () => {
    const out = buildFeedbackEmbed({ ...basePayload, anonymous: true }) as any;
    const title: string = out.embeds[0].title;
    expect(title).toContain('(anonymous)');
    expect(title).not.toContain('Alice');
    expect(title).not.toContain('alice@example.com');
  });

  it('includes context fields (page, version, session, browser)', () => {
    const out = buildFeedbackEmbed(basePayload) as any;
    const fields = out.embeds[0].fields as { name: string; value: string }[];
    const names = fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Page', 'Version', 'Session', 'Browser']));
    // Session is truncated to 8 chars to keep the embed compact.
    expect(fields.find((f) => f.name === 'Session')?.value).toBe('00000000');
  });

  it('embeds a deep-link to the admin panel in the footer', () => {
    const out = buildFeedbackEmbed(basePayload) as any;
    expect(out.embeds[0].footer.text).toBe('Review at https://kbrt.ai/admin/feedback');
  });

  it('truncates very long content with an ellipsis', () => {
    const huge = 'x'.repeat(2000);
    const out = buildFeedbackEmbed({ ...basePayload, content: huge }) as any;
    const desc: string = out.embeds[0].description;
    expect(desc.length).toBe(1501);
    expect(desc.endsWith('\u2026')).toBe(true);
  });

  it('omits missing context fields rather than rendering empty rows', () => {
    const out = buildFeedbackEmbed({
      ...basePayload, pageUrl: null, browser: null, appVersion: null, sessionId: null,
    }) as any;
    expect(out.embeds[0].fields).toEqual([]);
  });

  it('falls back to "Other" dressing for an unknown category', () => {
    // Cast through unknown to bypass the union — simulates a future
    // category being added server-side without updating the dressing
    // table. We want safe fallback rather than a crash.
    const out = buildFeedbackEmbed({ ...basePayload, category: 'mystery' as unknown as 'other' }) as any;
    expect(out.embeds[0].title).toMatch(/^💬 Other/);
  });

  it('emits a thread_name so forum-channel webhooks accept the post', () => {
    const out = buildFeedbackEmbed(basePayload) as any;
    // Forum channels require thread_name; regular text channels
    // ignore it. Always emit so a single payload works in both.
    expect(typeof out.thread_name).toBe('string');
    expect(out.thread_name.length).toBeGreaterThan(0);
    expect(out.thread_name.length).toBeLessThanOrEqual(100);
    // Thread name leads with the category dressing so the forum
    // sidebar reads naturally — "🐞 Bug: <summary>".
    expect(out.thread_name).toMatch(/^🐞 Bug:/);
  });

  it('clamps thread_name to 100 chars even with long content', () => {
    const longContent = 'A'.repeat(500);
    const out = buildFeedbackEmbed({ ...basePayload, content: longContent }) as any;
    expect(out.thread_name.length).toBeLessThanOrEqual(100);
  });
});

describe('sendFeedbackWebhook', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    // Override global fetch for the duration of this suite.
    (globalThis as any).fetch = fetchSpy;
    mockEnv.DISCORD_FEEDBACK_WEBHOOK_URL = '';
    mockEnv.BASE_URL = 'https://kbrt.ai';
    // Reset the in-module guild_id cache so each test sees a fresh
    // "first call" state. Production never resets, but tests must
    // each assert behaviour from scratch.
    _resetGuildIdCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok=false and skips fetch when no webhook URL is configured', async () => {
    const result = await sendFeedbackWebhook(basePayload);
    expect(result).toEqual({ ok: false, threadUrl: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs JSON with ?wait=true and resolves a thread URL when guild_id is discoverable', async () => {
    mockEnv.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/xxx/yyy';
    // POST → returns the message including the channel_id (== thread_id for forum channels)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-1', channel_id: 'thread-99' }),
    });
    // GET on the webhook URL → returns guild_id for the URL builder
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'webhook-xxx', guild_id: 'guild-42' }),
    });

    const result = await sendFeedbackWebhook(basePayload);

    expect(result.ok).toBe(true);
    expect(result.threadUrl).toBe('https://discord.com/channels/guild-42/thread-99');

    // First call is the POST with ?wait=true appended.
    const [postUrl, postInit] = fetchSpy.mock.calls[0];
    expect(postUrl).toBe('https://discord.com/api/webhooks/xxx/yyy?wait=true');
    expect(postInit.method).toBe('POST');
    expect(postInit.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(postInit.body as string);
    expect(body.username).toBe('Atlas Bound · Feedback');
    expect(Array.isArray(body.embeds)).toBe(true);

    // Second call is the GET to discover guild_id.
    const [getUrl, getInit] = fetchSpy.mock.calls[1];
    expect(getUrl).toBe('https://discord.com/api/webhooks/xxx/yyy');
    expect(getInit.method).toBe('GET');
  });

  it('returns ok=true / threadUrl=null when guild_id lookup fails', async () => {
    mockEnv.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/xxx/yyy';
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-1', channel_id: 'thread-99' }),
    });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await sendFeedbackWebhook(basePayload);
    expect(result.ok).toBe(true);
    expect(result.threadUrl).toBeNull();
  });

  it('returns ok=false (does not throw) on non-2xx Discord response', async () => {
    mockEnv.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/xxx/yyy';
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429 });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await sendFeedbackWebhook(basePayload);
    expect(result).toEqual({ ok: false, threadUrl: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows network errors and returns ok=false', async () => {
    mockEnv.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord.com/api/webhooks/xxx/yyy';
    fetchSpy.mockRejectedValueOnce(new Error('connection refused'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await sendFeedbackWebhook(basePayload);
    expect(result).toEqual({ ok: false, threadUrl: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
