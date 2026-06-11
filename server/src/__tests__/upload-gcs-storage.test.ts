import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

function fakeFile(buffer: Buffer): Express.Multer.File {
  return {
    buffer,
    fieldname: 'image',
    originalname: 'image.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: buffer.length,
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
  };
}

describe('GCS upload storage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('writes uploads to GCS and serves them back through the private media API', async () => {
    vi.stubEnv('UPLOAD_GCS_BUCKET', 'atlas-bound-data-personal');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('metadata.google.internal')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 300 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/upload/storage/v1/')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/storage/v1/')) {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const { validateAndSaveUpload, tryServeUploadFromGcs } = await import('../routes/uploads.js');
    const filename = await validateAndSaveUpload(fakeFile(PNG_BYTES), 'tokens');

    const uploadCall = calls.find((call) => call.url.includes('/upload/storage/v1/'));
    expect(filename).toMatch(/^[0-9a-f-]+\.png$/);
    expect(uploadCall).toBeTruthy();
    expect(uploadCall?.init?.method).toBe('POST');
    expect(new URL(uploadCall!.url).searchParams.get('name')).toBe(`tokens/${filename}`);
    expect((uploadCall?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token'
    );
    expect(uploadCall?.init?.body).toBeInstanceOf(Blob);

    const headers = new Map<string, string>();
    let sentBody: Buffer | null = null;
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name, value);
        return this;
      },
      send(body: Buffer) {
        sentBody = body;
        return this;
      },
    } as unknown as Response;

    await expect(tryServeUploadFromGcs(`/tokens/${filename}`, res)).resolves.toBe(true);
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(sentBody).toEqual(PNG_BYTES);
  });

  it('classifies backend storage failures separately from bad image uploads', async () => {
    vi.stubEnv('UPLOAD_GCS_BUCKET', 'atlas-bound-data-personal');
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('metadata.google.internal')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 300 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('permission denied', { status: 403 });
    });

    const { validateAndSaveUpload, isUploadStorageError } = await import('../routes/uploads.js');
    const failure = await validateAndSaveUpload(fakeFile(PNG_BYTES), 'tokens').catch(
      (err: unknown) => err
    );

    expect(isUploadStorageError(failure)).toBe(true);
  });
});
