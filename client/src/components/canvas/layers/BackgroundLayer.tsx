import { useEffect, useRef, useState } from 'react';
import { Image as KonvaImage, Rect } from 'react-konva';
import { theme } from '../../../styles/theme';

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
    img.crossOrigin = 'anonymous';

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

export function BackgroundLayer({ imageUrl, width, height }: BackgroundLayerProps) {
  const [image, status] = useImage(imageUrl);

  return (
    <>
      {/* Dark background fill */}
      <Rect x={0} y={0} width={width} height={height} fill={theme.bg.base} />

      {/* Map image */}
      {image && status === 'loaded' && (
        <KonvaImage image={image} x={0} y={0} width={width} height={height} />
      )}
    </>
  );
}
