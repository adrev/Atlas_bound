import { Volume2, VolumeX } from 'lucide-react';
import { theme } from '../../styles/theme';

export interface VolumeSliderProps {
  label: string;
  value: number;
  muted: boolean;
  onToggleMute: () => void;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Smaller sizing for inline use (e.g. inside MusicPlayer) */
  compact?: boolean;
}

export function VolumeSlider({
  label,
  value,
  muted,
  onToggleMute,
  onChange,
  disabled = false,
  compact = false,
}: VolumeSliderProps) {
  const dimmed = disabled || muted;
  const btnSize = compact ? 22 : 24;
  const iconSize = compact ? 11 : 12;
  const labelWidth = compact ? 40 : 44;
  const labelFontSize = compact ? 10 : 11;
  const valueFontSize = compact ? 9 : 10;
  const valueWidth = compact ? 24 : 28;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 4 : 6,
        opacity: disabled ? 0.4 : 1,
        transition: `opacity ${theme.motion.normal}`,
      }}
    >
      <button
        onClick={onToggleMute}
        title={muted ? 'Unmute' : 'Mute'}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: btnSize,
          height: btnSize,
          borderRadius: theme.radius.sm,
          border: `1px solid ${dimmed ? theme.border.default : theme.gold.border}`,
          background: dimmed ? theme.bg.deep : theme.gold.bg,
          color: dimmed ? theme.text.muted : theme.gold.primary,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {dimmed ? <VolumeX size={iconSize} /> : <Volume2 size={iconSize} />}
      </button>
      <span
        style={{
          fontSize: labelFontSize,
          fontWeight: 600,
          minWidth: labelWidth,
          color: dimmed ? theme.text.muted : theme.text.secondary,
        }}
      >
        {label}
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        style={{
          flex: 1,
          height: 4,
          cursor: disabled ? 'not-allowed' : 'pointer',
          accentColor: theme.gold.primary,
        }}
      />
      <span
        style={{
          fontSize: valueFontSize,
          fontWeight: 600,
          width: valueWidth,
          textAlign: 'right' as const,
          flexShrink: 0,
          color: dimmed ? theme.text.muted : theme.text.secondary,
        }}
      >
        {value}%
      </span>
    </div>
  );
}
