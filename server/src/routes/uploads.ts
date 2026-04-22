import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { UPLOAD_DIR } from '../config.js';

// Ensure upload directories exist
const mapUploadsDir = path.join(UPLOAD_DIR, 'maps');
// Thumbnails for custom-uploaded maps (480-px JPEGs generated
// client-side in MapUpload.tsx). Kept in a sub-folder so the
// /uploads default-deny middleware can reason about them as a
// distinct namespace, and so a future cleanup task can wipe them
// without touching the originals.
const mapThumbsDir = path.join(mapUploadsDir, 'thumbnails');
const tokenUploadsDir = path.join(UPLOAD_DIR, 'tokens');
const portraitUploadsDir = path.join(UPLOAD_DIR, 'portraits');
// Handout images — DM attaches a portrait / map-snippet / sketch
// when sending a handout. Stored in its own sub-folder so the
// /uploads/private/ ACL middleware can scope access if we need to
// restrict by session later. Today every logged-in user can fetch.
const handoutUploadsDir = path.join(UPLOAD_DIR, 'handouts');

for (const dir of [mapUploadsDir, mapThumbsDir, tokenUploadsDir, portraitUploadsDir, handoutUploadsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Magic byte signatures for allowed image types
const IMAGE_SIGNATURES: Array<{ bytes: number[]; offset?: number; ext: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: '.png' },           // PNG
  { bytes: [0xff, 0xd8, 0xff], ext: '.jpg' },                   // JPEG
  { bytes: [0x47, 0x49, 0x46], ext: '.gif' },                   // GIF
  // WebP: starts with RIFF....WEBP
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.webp' },            // WebP (first 4 bytes)
];

/** Check first bytes of a buffer to detect the real image type. Returns extension or null. */
function detectImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  for (const sig of IMAGE_SIGNATURES) {
    const offset = sig.offset ?? 0;
    const match = sig.bytes.every((b, i) => buffer[offset + i] === b);
    if (match) {
      // Extra check for WebP: bytes 8-11 must be "WEBP"
      if (sig.ext === '.webp') {
        if (
          buffer[8] === 0x57 && // W
          buffer[9] === 0x45 && // E
          buffer[10] === 0x42 && // B
          buffer[11] === 0x50   // P
        ) {
          return '.webp';
        }
        // RIFF header but not WebP — reject
        continue;
      }
      return sig.ext;
    }
  }
  return null;
}

// Use memory storage so we can validate magic bytes before writing to disk
function createMemoryUpload() {
  return multer({
    storage: multer.memoryStorage(),
    fileFilter(_req, file, cb) {
      // Preliminary client-mimetype check (will also validate bytes after upload)
      if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`));
      }
    },
    limits: { fileSize: MAX_FILE_SIZE },
  });
}

/** Validate magic bytes, write to the target dir with a server-chosen filename, and return the filename. */
export function validateAndSaveUpload(
  file: Express.Multer.File,
  subDir: string,
): string {
  const detectedExt = detectImageType(file.buffer);
  if (!detectedExt) {
    throw new Error('File does not appear to be a valid image (PNG, JPEG, GIF, or WebP).');
  }

  const filename = `${uuidv4()}${detectedExt}`;
  const destDir = path.join(UPLOAD_DIR, subDir);
  const destPath = path.join(destDir, filename);

  fs.writeFileSync(destPath, file.buffer);
  return filename;
}

/**
 * Validate + save a client-generated map thumbnail using the SAME UUID
 * stem as the original map upload, so the auth middleware can pair
 * them up. We accept JPEG only (that's what generateMapThumbnail emits)
 * and reject anything else with magic-byte detection — a malicious
 * client trying to inject an SVG via the thumbnail field gets dropped.
 */
export function saveMapThumbnail(
  file: Express.Multer.File,
  baseUuid: string,
): string {
  const detectedExt = detectImageType(file.buffer);
  if (detectedExt !== '.jpg') {
    throw new Error('Map thumbnail must be a JPEG.');
  }
  const filename = `${baseUuid}.jpg`;
  const destPath = path.join(mapThumbsDir, filename);
  fs.writeFileSync(destPath, file.buffer);
  return filename;
}

export const mapUpload = createMemoryUpload();
export const tokenUpload = createMemoryUpload();
export const portraitUpload = createMemoryUpload();
export const handoutUpload = createMemoryUpload();

export { detectImageType };
