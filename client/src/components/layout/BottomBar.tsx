import { useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { QuickActions } from '../quickactions/QuickActions';
import { DiceTray } from '../dice/DiceTray';
import { useAudioStore } from '../../stores/useAudioStore';
import { AudioPopover } from '../audio/AudioPopover';
import { theme } from '../../styles/theme';

/**
 * Bottom bar -- the persistent rune-slab action bar at the base of
 * the screen. Replaces the old MMO-style drag-drop Hotbar with
 * one-click access to the 5e standard actions (Dodge, Dash, etc.)
 * plus Short/Long rest, alongside the redesigned dice tray.
 *
 * Layout:
 *   [ QuickActions ............... | divider | ... DiceTray ]
 */
export function BottomBar() {
  const masterMuted = useAudioStore((s) => s.masterMuted);
  const toggleMasterMute = useAudioStore((s) => s.toggleMasterMute);
  const [showAudioPopover, setShowAudioPopover] = useState(false);

  return (
    <div style={styles.container}>
      <div style={styles.quickActionsSection}>
        <QuickActions />
      </div>
      <div aria-hidden style={styles.divider} />
      <div style={styles.diceSection}>
        <DiceTray />
      </div>
      <div style={{ position: 'relative', flexShrink: 0, marginLeft: theme.space.sm }}>
        <button
          onClick={() => setShowAudioPopover((v) => !v)}
          onContextMenu={(e) => { e.preventDefault(); toggleMasterMute(); }}
          title={masterMuted ? 'Unmute audio (right-click to quick-toggle)' : 'Audio settings (right-click to quick-mute)'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: theme.radius.sm,
            border: `1px solid ${masterMuted ? theme.border.default : theme.gold.border}`,
            background: masterMuted ? theme.bg.deep : theme.gold.bg,
            color: masterMuted ? theme.text.muted : theme.gold.primary,
            cursor: 'pointer',
            flexShrink: 0,
            transition: `all ${theme.motion.fast}`,
          }}
        >
          {masterMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        {showAudioPopover && (
          <AudioPopover onClose={() => setShowAudioPopover(false)} />
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    padding: `0 ${theme.space.lg}px`,
    gap: theme.space.lg,
    overflowX: 'auto',
    overflowY: 'hidden',
    // Layered background matching the tab bar's rune-slab look so the
    // bottom bar reads as a companion piece to the sidebar tabs.
    background: `linear-gradient(180deg, ${theme.bg.base} 0%, ${theme.parchmentEdge} 100%)`,
    borderTop: `1px solid ${theme.gold.border}`,
    boxShadow: `inset 0 1px 0 ${theme.border.default}`,
  },
  quickActionsSection: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  // Rune-slab vertical separator matching the tab bar spacers.
  divider: {
    width: 2,
    height: 52,
    background: `
      linear-gradient(90deg,
        rgba(0,0,0,0.35) 0%,
        rgba(0,0,0,0.35) 50%,
        rgba(232, 196, 85, 0.5) 50%,
        rgba(232, 196, 85, 0.5) 100%
      )
    `,
    flexShrink: 0,
    alignSelf: 'center',
  },
  diceSection: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    marginLeft: 'auto',
  },
};
