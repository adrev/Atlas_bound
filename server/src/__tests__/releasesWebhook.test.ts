/**
 * Releases webhook tests — same shape as discordWebhook.test.ts:
 * pure-function payload assertions, then HTTP path with a fetch stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { DISCORD_RELEASES_WEBHOOK_URL: '', BASE_URL: 'https://kbrt.ai' },
}));

vi.mock('../config.js', () => ({
  get DISCORD_RELEASES_WEBHOOK_URL() { return mockEnv.DISCORD_RELEASES_WEBHOOK_URL; },
  get BASE_URL() { return mockEnv.BASE_URL; },
}));

import {
  buildReleaseEmbed,
  sendReleaseWebhook,
  _resetReleasesGuildIdCache,
  type ReleaseWebhookPayload,
} from '../utils/releasesWebhook.js';

const basePayload: ReleaseWebhookPayload = {
  tidingId: 'tid-1',
  kind: 'patch',
  title: 'Brass-bound Lobby',
  body: 'New lobby design + Tidings system + Discord cross-linking.',
  versionTag: '0.7.4',
  linkedFeedback: [
    { id: 'f1', category: 'bug', summary: 'Wiki search returns nothing for partial words.', threadUrl: 'https://discord.com/channels/g1/t1' },
    { id: 'f2', category: 'feature', summary: 'Add a Hide action button.', threadUrl: null },
  ],
};

describe('buildReleaseEmbed', () => {
  it('uses the per-kind dressing for patch entries', () => {
    const out = buildReleaseEmbed(basePayload) as any;
    const embed = out.embeds[0];
    expect(embed.title).toMatch(/^📜 Release 0.7.4 ·/);
    expect(embed.title).toContain('Brass-bound Lobby');
    expect(embed.color).toBe(0xe0b44f);
  });

  it('emits a thread_name within Discord\u2019s 100-char limit', () => {
    const out = buildReleaseEmbed({ ...basePayload, title: 'A'.repeat(200) }) as any;
    expect(out.thread_name.length).toBeLessThanOrEqual(100);
    expect(out.thread_name).toMatch(/^📜 0\.7\.4 · /);
  });

  it('renders an "Addressed feedback" section with deep-links', () => {
    const out = buildReleaseEmbed(basePayload) as any;
    const desc: string = out.embeds[0].description;
    expect(desc).toContain('Addressed feedback:');
    expect(desc).toContain('🐞 Wiki search returns nothing');
    expect(desc).toContain('https://discord.com/channels/g1/t1');
    // The bug had a thread URL → renders the ↳ sub-line.
    expect(desc).toContain('↳ https://discord.com/channels/g1/t1');
    // The feature has threadUrl=null → just the bullet, no ↳ line.
    expect(desc).toContain('✨ Add a Hide action button');
    expect(desc).not.toMatch(/✨ Add a Hide action button\.\n   ↳/);
  });

  it('omits the feedback section entirely when nothing is linked', () => {
    const out = buildReleaseEmbed({ ...basePayload, linkedFeedback: [] }) as any;
    expect(out.embeds[0].description).not.toContain('Addressed feedback');
  });

  it('embeds a Read-more link to the lobby base URL', () => {
    const out = buildReleaseEmbed(basePayload) as any;
    expect(out.embeds[0].description).toContain('https://kbrt.ai/');
    expect(out.embeds[0].description).toContain('Great Hall');
  });

  it('clamps very long bodies', () => {
    const huge = 'x'.repeat(2000);
    const out = buildReleaseEmbed({ ...basePayload, body: huge, linkedFeedback: [] }) as any;
    const desc: string = out.embeds[0].description;
    // 1500 + ellipsis + " Read more on the Great Hall →" line
    expect(desc.length).toBeLessThanOrEqual(4000);
    expect(desc).toContain('\u2026'); // ellipsis from body trim
  });
});

describe('sendReleaseWebhook', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    mockEnv.DISCORD_RELEASES_WEBHOOK_URL = '';
    _resetReleasesGuildIdCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok=false and skips fetch when no webhook URL is configured', async () => {
    const result = await sendReleaseWebhook(basePayload);
    expect(result).toEqual({ ok: false, threadUrl: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs with ?wait=true and resolves the new thread URL', async () => {
    mockEnv.DISCORD_RELEASES_WEBHOOK_URL = 'https://discord.com/api/webhooks/aaa/bbb';
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'msg-1', channel_id: 'thread-77' }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ guild_id: 'g-99' }),
    });

    const result = await sendReleaseWebhook(basePayload);
    expect(result.ok).toBe(true);
    expect(result.threadUrl).toBe('https://discord.com/channels/g-99/thread-77');

    const [postUrl, postInit] = fetchSpy.mock.calls[0];
    expect(postUrl).toBe('https://discord.com/api/webhooks/aaa/bbb?wait=true');
    expect(postInit.method).toBe('POST');
    const body = JSON.parse(postInit.body as string);
    expect(body.username).toBe('Atlas Bound · Releases');
  });

  it('returns ok=false (no throw) on Discord 4xx', async () => {
    mockEnv.DISCORD_RELEASES_WEBHOOK_URL = 'https://discord.com/api/webhooks/aaa/bbb';
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await sendReleaseWebhook(basePayload);
    expect(result).toEqual({ ok: false, threadUrl: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
