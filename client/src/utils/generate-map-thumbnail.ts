/**
 * Browser-side map thumbnail generator.
 *
 * Custom-uploaded maps used to render at full resolution (often
 * 1.5-3 MB) inside the Scene Manager's 68×46 sidebar thumbnail
 * slot — wasteful, and because some maps were huge enough to fail
 * the Konva paint, the slot showed a broken-image icon. We now
 * generate a 480-px-wide JPEG client-side and ship it alongside the
 * original in the upload FormData. The server stores it at
 * /uploads/maps/thumbnails/{uuid}.jpg.
 *
 * Why client-side instead of server-side (sharp/jimp)?
 *   - No new server dep + no Dockerfile bump (sharp needs vips on Alpine).
 *   - The browser already has the file in memory after the user picks it.
 *   - Thumbnails are display-only; even if a malicious client sent a
 *     mismatched preview, the worst outcome is "ugly thumbnail in the
 *     DM's sidebar". The server still validates magic bytes.
 */

const TARGET_WIDTH = 480;
const JPEG_QUALITY = 0.8;

/**
 * Resize a user-picked image File to a 480-px-wide JPEG Blob.
 * Returns null on failure (caller should still upload the original
 * without a thumbnail — it'll just fall back to full-res in the UI).
 */
export async function generateMapThumbnail(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, TARGET_WIDTH / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Use a high-quality smoothing pass; the source is already
    // potentially much larger than 480 px so a simple drawImage
    // with smoothing gives results indistinguishable from sips.
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
    });
  } catch {
    // Don't surface the error — the upload should still succeed
    // without a thumbnail. The Scene Manager will fall back to
    // rendering the full-res image until the next refresh.
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load image for thumbnail'));
    img.src = src;
  });
}
