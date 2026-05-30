import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAudioStore } from '../../stores/useAudioStore';
import { theme } from '../../styles/theme';
import { VolumeSlider } from './VolumeSlider';

const POPOVER_WIDTH = 260;
const POPOVER_HEIGHT = 180; // Approximate fixed height used before first render.
const VIEWPORT_MARGIN = 8;

type AnchorRect = Pick<DOMRect, 'top' | 'bottom' | 'right'>;

export function computeAudioPopoverPosition(
  rect: AnchorRect,
  viewportWidth: number,
  viewportHeight: number,
) {
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.right - POPOVER_WIDTH),
    Math.max(VIEWPORT_MARGIN, viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
  );

  const topAbove = rect.top - POPOVER_HEIGHT - VIEWPORT_MARGIN;
  const topBelow = rect.bottom + VIEWPORT_MARGIN;
  const top = topAbove >= VIEWPORT_MARGIN
    ? topAbove
    : Math.min(
        Math.max(VIEWPORT_MARGIN, topBelow),
        Math.max(VIEWPORT_MARGIN, viewportHeight - POPOVER_HEIGHT - VIEWPORT_MARGIN),
      );

  return { top, left };
}

/**
 * Floating popover with Master / Music / SFX volume sliders + mute
 * toggles. Shown for ALL users when clicking the speaker icon in
 * the app chrome. Closes on click-outside.
 *
 * Rendered via React Portal directly on document.body with
 * position: fixed so it escapes any parent z-index stacking context
 * (previously the sidebar and map could paint over it).
 */
export function AudioPopover({ onClose, anchorRef }: {
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const {
    masterVolume, musicVolume, sfxVolume,
    masterMuted, musicMuted, sfxMuted,
    setMasterVolume, setMusicVolume, setSfxVolume,
    toggleMasterMute, toggleMusicMute, toggleSfxMute,
  } = useAudioStore();

  // Compute position from anchor button's bounding rect. Prefer opening
  // above, but fall below top-bar buttons instead of rendering off-screen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos(computeAudioPopoverPosition(rect, window.innerWidth, window.innerHeight));
  }, [anchorRef]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose, anchorRef]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!pos) return null;

  return createPortal(
    <div ref={ref} style={{ ...styles.popover, top: pos.top, left: pos.left }}>
      <VolumeSlider
        label="Master"
        value={masterVolume}
        muted={masterMuted}
        onToggleMute={toggleMasterMute}
        onChange={setMasterVolume}
      />
      <VolumeSlider
        label="Music"
        value={musicVolume}
        muted={musicMuted}
        onToggleMute={toggleMusicMute}
        onChange={setMusicVolume}
        disabled={masterMuted}
      />
      <VolumeSlider
        label="SFX"
        value={sfxVolume}
        muted={sfxMuted}
        onToggleMute={toggleSfxMute}
        onChange={setSfxVolume}
        disabled={masterMuted}
      />
    </div>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  popover: {
    position: 'fixed',
    width: 260,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    boxShadow: theme.shadow.lg,
    zIndex: 10000, // above everything — portal escapes stacking contexts
    animation: 'fadeIn 0.12s ease',
  },
};
