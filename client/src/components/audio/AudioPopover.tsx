import { useEffect, useRef } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useAudioStore } from '../../stores/useAudioStore';
import { theme } from '../../styles/theme';

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
      <SliderRow
        label="Master"
        value={masterVolume}
        muted={masterMuted}
        onToggle={toggleMasterMute}
        onChange={setMasterVolume}
        disabled={false}
        prominent
      />
      <SliderRow
        label="Music"
        value={musicVolume}
        muted={musicMuted}
        onToggle={toggleMusicMute}
        onChange={setMusicVolume}
        disabled={masterMuted}
      />
      <SliderRow
        label="SFX"
        value={sfxVolume}
        muted={sfxMuted}
        onToggle={toggleSfxMute}
        onChange={setSfxVolume}
        disabled={masterMuted}
      />
    </div>
  );
}

function SliderRow({
  label, value, muted, onToggle, onChange, disabled, prominent,
}: {
  label: string;
  value: number;
  muted: boolean;
  onToggle: () => void;
  onChange: (v: number) => void;
  disabled: boolean;
  prominent?: boolean;
}) {
  const dimmed = disabled || muted;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      opacity: disabled && !prominent ? 0.4 : 1,
    }}>
      <button
        onClick={onToggle}
        title={muted ? 'Unmute' : 'Mute'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: theme.radius.sm,
          border: `1px solid ${dimmed ? theme.border.default : theme.gold.border}`,
          background: dimmed ? theme.bg.deep : theme.gold.bg,
          color: dimmed ? theme.text.muted : theme.gold.primary,
          cursor: 'pointer', flexShrink: 0,
        }}
      >
        {dimmed ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
      <span style={{
        fontSize: 11, fontWeight: prominent ? 700 : 600, minWidth: 44,
        color: dimmed ? theme.text.muted : theme.text.secondary,
      }}>
        {label}
      </span>
      <input
        type="range" min={0} max={100} step={1} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        style={{ flex: 1, height: 4, cursor: disabled ? 'not-allowed' : 'pointer', accentColor: theme.gold.primary }}
      />
      <span style={{
        fontSize: 10, fontWeight: 600, width: 28, textAlign: 'right', flexShrink: 0,
        color: dimmed ? theme.text.muted : theme.text.secondary,
      }}>
        {value}%
      </span>
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
    zIndex: 50,
    animation: 'fadeIn 0.12s ease',
  },
};
