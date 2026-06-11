import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Rect } from 'react-konva';
import { theme } from '../../../styles/theme';
import { isKnownPublicAssetUrl } from '../../../utils/publicAssets';
import { getVisibleMapRect, type ViewportTransform } from '../../../utils/visibleMapRect';

// NOTE on layer consolidation (2026-04): every visual unit in
// client/src/components/canvas/layers/ used to mount its own Konva
// `<Layer>` wrapper. With 8+ layers per map the GPU was running 8
// independent canvases, and Konva itself logged a "stage has 6 layers"
// warning. Each layer now returns a fragment / Group instead, and
// BattleMap.tsx wraps related layers into shared parent `<Layer>`
// nodes (Base / Tokens / Overlays / Tools).

interface BackgroundLayerProps {
  imageUrl: string | null;
  width: number;
  height: number;
  viewport: ViewportTransform;
  stageWidth: number;
  stageHeight: number;
}

function shouldUseAnonymousCors(url: string): boolean {
  // Legacy public art URLs do not always send CORS headers. Setting
  // crossOrigin='anonymous' there can make browsers reject the image.
  return !isKnownPublicAssetUrl(url);
}

function useImage(url: string | null): [HTMLImageElement | null, 'loading' | 'loaded' | 'error'] {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const urlRef = useRef(url);

  useEffect(() => {
    urlRef.current = url;
    if (!url) {
      setImage(null);
      setStatus('loaded');
      return;
    }

    setStatus('loading');
    const img = new window.Image();
    if (shouldUseAnonymousCors(url)) {
      img.crossOrigin = 'anonymous';
    }

    img.onload = () => {
      if (urlRef.current === url) {
        setImage(img);
        setStatus('loaded');
      }
    };

    img.onerror = () => {
      if (urlRef.current === url) {
        setImage(null);
        setStatus('error');
      }
    };

    img.src = url;

    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [url]);

  return [image, status];
}

export function BackgroundLayer({
  imageUrl,
  width,
  height,
  viewport,
  stageWidth,
  stageHeight,
}: BackgroundLayerProps) {
  const [image, status] = useImage(imageUrl);
  const visibleRect = useMemo(
    () => getVisibleMapRect(width, height, viewport, stageWidth, stageHeight),
    [
      width,
      height,
      viewport.x,
      viewport.y,
      viewport.scaleX,
      viewport.scaleY,
      stageWidth,
      stageHeight,
    ]
  );

  if (!visibleRect) return null;

  const imageCrop = image
    ? {
        x: (visibleRect.x / width) * image.width,
        y: (visibleRect.y / height) * image.height,
        width: (visibleRect.width / width) * image.width,
        height: (visibleRect.height / height) * image.height,
      }
    : undefined;

  return (
    <>
      {/* Dark background fill */}
      <Rect
        x={visibleRect.x}
        y={visibleRect.y}
        width={visibleRect.width}
        height={visibleRect.height}
        fill={theme.bg.base}
        listening={false}
      />

      {/* Map image */}
      {image && imageCrop && status === 'loaded' && (
        <KonvaImage
          image={image}
          x={visibleRect.x}
          y={visibleRect.y}
          width={visibleRect.width}
          height={visibleRect.height}
          crop={imageCrop}
          listening={false}
        />
      )}
    </>
  );
}
