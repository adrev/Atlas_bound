import { useEffect, useRef } from 'react';
import { useAudioStore } from '../../stores/useAudioStore';
import { theme } from '../../styles/theme';
import { VolumeSlider } from './VolumeSlider';

/**
 * Floating popover with Master / Music / SFX volume sliders + mute
 * toggles. Shown for ALL users when clicking the speaker icon in
 * BottomBar. Closes on click-outside.
 */
export function AudioPopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const {
    masterVolume, musicVolume, sfxVolume,
    masterMuted, musicMuted, sfxMuted,
    setMasterVolume, setMusicVolume, setSfxVolume,
    toggleMasterMute, toggleMusicMute, toggleSfxMute,
  } = useAudioStore();

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener so the opening click doesn't immediately close
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  return (
    <div ref={ref} style={styles.popover}>
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  popover: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: 8,
    width: 260,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    boxShadow: theme.shadow.lg,
    zIndex: 500,
    animation: 'fadeIn 0.12s ease',
  },
};
