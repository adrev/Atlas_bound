import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Point UPLOAD_DIR at a tempdir BEFORE importing the module so the
// thumbnails-dir creation lands in /tmp instead of polluting the real
// `server/uploads/` tree under the repo.
const TMP_UPLOAD_DIR = path.join(os.tmpdir(), `map-thumb-test-${Date.now()}`);
process.env.UPLOAD_DIR = TMP_UPLOAD_DIR;

// Top-level await to honor the env override before the module runs.
const { saveMapThumbnail } = await import('../routes/uploads.js');

/**
 * The thumbnail upload path is new (2026-04-16). It accepts a
 * client-generated 480-px JPEG and stores it next to the original
 * map. The function deliberately rejects anything other than JPEG
 * via magic-byte detection so a malicious client can't inject SVG
 * or HTML through the thumbnail field — this test pins that invariant.
 */
describe('saveMapThumbnail magic-byte gate', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(TMP_UPLOAD_DIR, 'maps', 'thumbnails'), { recursive: true });
  });
  afterAll(() => {
    // Best-effort cleanup of the tempdir tree.
    try { fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Minimal valid JPEG header (SOI marker followed by a JFIF block).
  // We don't decode it — just need the magic bytes for detectImageType.
  const VALID_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    // pad so the buffer is large enough to pass the length check
    ...new Array(64).fill(0x00),
  ]);

  // PNG header — a real attacker might try to mislabel a PNG as JPEG.
  const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...new Array(64).fill(0x00),
  ]);

  // SVG bytes — the actual XSS vector we're closing.
  const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  function fakeFile(buffer: Buffer): Express.Multer.File {
    return {
      buffer,
      fieldname: 'thumbnail',
      originalname: 'thumbnail.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: buffer.length,
      destination: '',
      filename: '',
      path: '',
      stream: undefined as never,
    };
  }

  it('accepts a real JPEG header', () => {
    const baseUuid = `accept-${Date.now()}`;
    const filename = saveMapThumbnail(fakeFile(VALID_JPEG), baseUuid);
    expect(filename).toBe(`${baseUuid}.jpg`);
    // File should exist on disk after the call.
    const written = path.join(TMP_UPLOAD_DIR, 'maps', 'thumbnails', filename);
    expect(fs.existsSync(written)).toBe(true);
  });

  it('rejects a PNG masquerading as a thumbnail', () => {
    expect(() => saveMapThumbnail(fakeFile(PNG_HEADER), 'x')).toThrow(/JPEG/);
  });

  it('rejects raw SVG bytes', () => {
    expect(() => saveMapThumbnail(fakeFile(SVG_BYTES), 'x')).toThrow(/JPEG/);
  });

  it('rejects an empty buffer', () => {
    expect(() => saveMapThumbnail(fakeFile(Buffer.alloc(0)), 'x')).toThrow();
  });
});
