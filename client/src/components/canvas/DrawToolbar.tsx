import { useEffect, type ReactNode } from 'react';
import {
  MousePointer2, Pencil, Square, Circle, Minus, MoveUpRight, Type, Zap,
  Undo, Redo, Trash2, X, Eye, EyeOff, User, Grid3x3,
} from 'lucide-react';
import { useDrawStore, DRAW_COLOR_PRESETS, type ActiveDrawTool } from '../../stores/useDrawStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitDrawingClearAll } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import { InfoTooltip } from '../ui/InfoTooltip';
import type { DrawingVisibility } from '@dnd-vtt/shared';

/**
 * DrawToolbar — floating overlay shown while the DM (or a player)
 * is in Draw Mode. Styled to match the rest of the app: dark card
 * background, gold accents for active state, uppercase letterspaced
 * section labels, lucide-react icons (no emoji), and hover tooltips
 * via the shared InfoTooltip component.
 *
 * Layout (horizontal bar docked to top-center of the canvas):
 *
 *   ┌─ TOOLS ─────────────┐  ┌─ STYLE ──────────────┐  ┌─ HISTORY ─────┐
 *   │ select pencil rect… │  │ colors  width  snap  │  │ undo redo del │
 *   │                     │  │ visibility           │  │               │
 *   └─────────────────────┘  └──────────────────────┘  └───────────────┘
 *                                                      [ EXIT DRAW MODE ]
 */

interface ToolMeta {
  id: ActiveDrawTool;
  label: string;
  shortcut: string;
  icon: ReactNode;
  tooltipBody: string;
  tooltipFooter: string;
}

const GOLD = theme.gold.primary;

export function DrawToolbar() {
  const isDrawMode = useDrawStore((s) => s.isDrawMode);
  const activeTool = useDrawStore((s) => s.activeTool);
  const activeColor = useDrawStore((s) => s.activeColor);
  const activeWidth = useDrawStore((s) => s.activeWidth);
  const activeVisibility = useDrawStore((s) => s.activeVisibility);
  const gridSnap = useDrawStore((s) => s.gridSnap);
  const undoStack = useDrawStore((s) => s.undoStack);
  const redoStack = useDrawStore((s) => s.redoStack);
  const isDM = useSessionStore((s) => s.isDM);

  // Keyboard shortcuts — only active while drawing
  useEffect(() => {
    if (!isDrawMode) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore when a modal / input has focus, or when typing into a
      // contentEditable text label.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      const store = useDrawStore.getState();

      if (e.key === 'Escape') {
        if (store.drawingInProgress) {
          store.cancelStroke();
        } else {
          store.exitDrawMode();
        }
        e.preventDefault();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selectedDrawingId) {
          store.deleteSelected();
          e.preventDefault();
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) store.redo();
        else store.undo();
        e.preventDefault();
        return;
      }

      const toolMap: Record<string, ActiveDrawTool> = {
        s: 'select',
        p: 'freehand',
        r: 'rect',
        c: 'circle',
        l: 'line',
        a: 'arrow',
        t: 'text',
        q: 'ephemeral',
      };
      const tool = toolMap[e.key.toLowerCase()];
      if (tool) {
        store.setTool(tool);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDrawMode]);

  if (!isDrawMode) return null;

  const handleClearAll = () => {
    const msg = isDM
      ? 'Clear ALL drawings on this map? This cannot be undone.'
      : 'Clear all of YOUR drawings on this map? This cannot be undone.';
    // eslint-disable-next-line no-alert
    if (!confirm(msg)) return;
    emitDrawingClearAll(isDM ? 'all' : 'mine');
  };

  const tools: ToolMeta[] = [
    {
      id: 'select', label: 'Select', shortcut: 'S',
      icon: <MousePointer2 size={16} />,
      tooltipBody: 'Click a drawing to select it, then press Delete or Backspace to remove it. Clicking empty canvas clears the selection.',
      tooltipFooter: 'Only your own drawings can be deleted unless you are the DM.',
    },
    {
      id: 'freehand', label: 'Pencil', shortcut: 'P',
      icon: <Pencil size={16} />,
      tooltipBody: 'Draw freehand strokes. Click and drag to paint a smoothed polyline across the map.',
      tooltipFooter: 'Permanent until cleared.',
    },
    {
      id: 'rect', label: 'Rectangle', shortcut: 'R',
      icon: <Square size={16} />,
      tooltipBody: 'Drag to draw a hollow rectangle. Enable Grid Snap to lock the corners to whole grid cells — great for marking 10/20 ft zones.',
      tooltipFooter: 'Hollow outline, not filled.',
    },
    {
      id: 'circle', label: 'Circle', shortcut: 'C',
      icon: <Circle size={16} />,
      tooltipBody: 'Drag from center outward to draw a hollow circle. With Grid Snap on, the radius snaps to half-cells.',
      tooltipFooter: 'Hollow outline, not filled.',
    },
    {
      id: 'line', label: 'Line', shortcut: 'L',
      icon: <Minus size={16} />,
      tooltipBody: 'Drag to draw a straight line between two points.',
      tooltipFooter: 'No arrowhead. Use Arrow tool for pointers.',
    },
    {
      id: 'arrow', label: 'Arrow', shortcut: 'A',
      icon: <MoveUpRight size={16} />,
      tooltipBody: 'Drag to draw a line with an arrowhead at the end. Great for "focus fire here" callouts and movement suggestions.',
      tooltipFooter: 'Arrowhead scales with stroke width.',
    },
    {
      id: 'text', label: 'Text', shortcut: 'T',
      icon: <Type size={16} />,
      tooltipBody: 'Click anywhere on the map to plant a text label. A prompt will ask for the content.',
      tooltipFooter: 'Font size scales with the width slider.',
    },
    {
      id: 'ephemeral', label: 'Quick', shortcut: 'Q',
      icon: <Zap size={16} />,
      tooltipBody: 'Quick-sketch pen for temporary highlights. Strokes auto-fade after 10 seconds — perfect for "look here!" moments that shouldn\'t clutter the map.',
      tooltipFooter: 'Not persisted. Gone on refresh.',
    },
  ];

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={styles.shell}
    >
      {/* Row 1: Tools + History + Exit — fixed vocabulary, icon-only */}
      <div style={styles.row}>
        {/* Tools */}
        {tools.map((t) => (
          <InfoTooltip
            key={t.id}
            title={`${t.label} (${t.shortcut})`}
            body={t.tooltipBody}
            footer={t.tooltipFooter}
            accent={GOLD}
            maxWidth={300}
          >
            <ToolButton
              active={activeTool === t.id}
              onClick={() => useDrawStore.getState().setTool(t.id)}
              title={`${t.label} (${t.shortcut})`}
            >
              {t.icon}
              <span style={styles.shortcutHint}>{t.shortcut}</span>
            </ToolButton>
          </InfoTooltip>
        ))}

        <Divider />

        {/* History */}
        <InfoTooltip
          title="Undo"
          body="Reverses your most recent draw operation. Works across the network — undoing a create removes the drawing for everyone."
          footer="⌘Z / Ctrl+Z"
          accent={GOLD}
        >
          <ToolButton
            disabled={undoStack.length === 0}
            onClick={() => useDrawStore.getState().undo()}
          >
            <Undo size={16} />
          </ToolButton>
        </InfoTooltip>

        <InfoTooltip
          title="Redo"
          body="Re-applies the last undone operation."
          footer="⌘⇧Z / Ctrl+Shift+Z"
          accent={GOLD}
        >
          <ToolButton
            disabled={redoStack.length === 0}
            onClick={() => useDrawStore.getState().redo()}
          >
            <Redo size={16} />
          </ToolButton>
        </InfoTooltip>

        <InfoTooltip
          title={isDM ? 'Clear All' : 'Clear My Drawings'}
          body={
            isDM
              ? 'Removes EVERY drawing on the current map — yours, players\', all visibilities. Cannot be undone.'
              : 'Removes only the drawings you created on this map.'
          }
          footer="Confirmation required"
          accent={theme.danger}
        >
          <ToolButton onClick={handleClearAll} tint={theme.danger}>
            <Trash2 size={16} />
          </ToolButton>
        </InfoTooltip>

        <Divider />

        {/* Exit button — styled as a primary gold pill */}
        <InfoTooltip
          title="Exit Draw Mode"
          body="Leaves draw mode. Drawings stay on the map until cleared; undo history is reset."
          footer="Esc"
          accent={GOLD}
        >
          <button onClick={() => useDrawStore.getState().exitDrawMode()} style={styles.exitBtn}>
            <X size={12} />
            <span>EXIT</span>
          </button>
        </InfoTooltip>
      </div>

      {/* Row 2: Style — colors, width, snap, visibility */}
      <div style={styles.row}>
        {/* Color swatches */}
        <div style={styles.swatchRow}>
          {DRAW_COLOR_PRESETS.map((c) => (
            <div
              key={c}
              onClick={() => useDrawStore.getState().setColor(c)}
              style={{
                ...styles.swatch,
                background: c,
                borderColor: activeColor === c ? GOLD : 'rgba(0,0,0,0.4)',
                boxShadow: activeColor === c ? theme.shadow.gold : 'none',
              }}
              title={c}
            />
          ))}
          <label style={styles.customSwatch} title="Custom color">
            <input
              type="color"
              value={activeColor}
              onChange={(e) => useDrawStore.getState().setColor(e.target.value)}
              style={styles.hiddenColorInput}
            />
            <div style={{
              ...styles.customSwatchFace,
              background: `conic-gradient(#ff3b3b, #ffe03b, #3bff6a, #3bb9ff, #c93bff, #ff3b3b)`,
              borderColor: DRAW_COLOR_PRESETS.includes(activeColor) ? 'rgba(0,0,0,0.4)' : GOLD,
            }} />
          </label>
        </div>

        <Divider />

        {/* Width slider */}
        <div style={styles.sliderGroup}>
          <input
            type="range"
            min={1}
            max={16}
            step={1}
            value={activeWidth}
            onChange={(e) => useDrawStore.getState().setWidth(parseInt(e.target.value, 10))}
            style={styles.slider}
          />
          <span style={styles.widthValue}>{activeWidth}px</span>
        </div>

        <Divider />

        {/* Grid snap toggle */}
        <InfoTooltip
          title="Grid Snap"
          body="When ON, rectangle corners and circle radii snap to whole grid cells. Applies only to shape tools (not freehand)."
          footer=""
          accent={GOLD}
        >
          <ToolButton
            active={gridSnap}
            onClick={() => useDrawStore.getState().toggleGridSnap()}
          >
            <Grid3x3 size={16} />
          </ToolButton>
        </InfoTooltip>

        <Divider />

        {/* Visibility picker — icon-only segmented */}
        <VisibilityPicker
          value={activeVisibility}
          isDM={isDM}
          onChange={(v) => useDrawStore.getState().setVisibility(v)}
        />
      </div>
    </div>
  );
}

/** Vertical separator between toolbar sections. */
function Divider() {
  return <div style={styles.divider} />;
}

/**
 * Uniform tool button — icon-only, square, gold-outlined when active,
 * subtle hover background. Matches the ActionEconomy slot style.
 */
function ToolButton({
  children,
  active,
  disabled,
  onClick,
  tint,
  title,
}: {
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  tint?: string;
  title?: string;
}) {
  const accent = tint ?? GOLD;
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{
        ...styles.toolBtn,
        background: active ? theme.gold.bg : 'transparent',
        borderColor: active ? theme.gold.border : theme.border.default,
        color: disabled ? theme.text.muted : active ? accent : theme.text.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled || active) return;
        (e.currentTarget as HTMLButtonElement).style.background = theme.bg.hover;
        (e.currentTarget as HTMLButtonElement).style.borderColor = theme.border.light;
        (e.currentTarget as HTMLButtonElement).style.color = accent;
      }}
      onMouseLeave={(e) => {
        if (disabled || active) return;
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        (e.currentTarget as HTMLButtonElement).style.borderColor = theme.border.default;
        (e.currentTarget as HTMLButtonElement).style.color = theme.text.secondary;
      }}
    >
      {children}
    </button>
  );
}

/**
 * Visibility picker — three-button icon group. Uses the same
 * ToolButton as the main toolbar so styling stays consistent.
 * Non-DMs can only use "Personal".
 */
function VisibilityPicker({
  value,
  isDM,
  onChange,
}: {
  value: DrawingVisibility;
  isDM: boolean;
  onChange: (v: DrawingVisibility) => void;
}) {
  const options: Array<{
    key: DrawingVisibility;
    label: string;
    icon: ReactNode;
    tooltip: string;
  }> = [
    {
      key: 'shared',
      label: 'Shared',
      icon: <Eye size={16} />,
      tooltip: 'Visible to everyone in the session.',
    },
    {
      key: 'dm-only',
      label: 'DM only',
      icon: <EyeOff size={16} />,
      tooltip: 'Only DMs can see — perfect for private notes.',
    },
    {
      key: 'player-only',
      label: 'Personal',
      icon: <User size={16} />,
      tooltip: 'Only you and the DM can see.',
    },
  ];

  return (
    <div style={styles.row}>
      {options.map((opt) => {
        const disabled = !isDM && opt.key !== 'player-only';
        const active = value === opt.key;
        return (
          <InfoTooltip
            key={opt.key}
            title={`${opt.label} visibility`}
            body={opt.tooltip}
            footer={disabled ? 'Players can only create personal drawings.' : ''}
            accent={GOLD}
          >
            <ToolButton
              active={active}
              disabled={disabled}
              onClick={() => onChange(opt.key)}
            >
              {opt.icon}
            </ToolButton>
          </InfoTooltip>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: 'fixed',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 9997,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    boxShadow: theme.shadow.lg,
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontFamily: theme.font.body,
    color: theme.text.primary,
    // Subtle gold accent wash at the top — matches the dark-red/gold
    // panel style used in the character sheet and initiative tracker.
    backgroundImage: `linear-gradient(180deg, ${theme.gold.bg} 0%, ${theme.bg.card} 18%)`,
  },
  row: {
    display: 'flex',
    gap: 3,
    alignItems: 'center',
  },
  divider: {
    width: 1,
    height: 22,
    background: theme.border.default,
    margin: '0 4px',
    flexShrink: 0,
  },
  toolBtn: {
    width: 28,
    height: 28,
    border: '1px solid',
    borderRadius: theme.radius.sm,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
    transition: 'background 120ms, border-color 120ms, color 120ms',
    position: 'relative' as const,
  },
  shortcutHint: {
    position: 'absolute' as const,
    bottom: 1,
    right: 2,
    fontSize: 7,
    fontWeight: 700,
    lineHeight: 1,
    opacity: 0.5,
    pointerEvents: 'none' as const,
  },
  swatchRow: {
    display: 'flex',
    gap: 3,
    alignItems: 'center',
    padding: '0 2px',
  },
  swatch: {
    width: 16,
    height: 16,
    borderRadius: 3,
    cursor: 'pointer',
    border: '1px solid',
    flexShrink: 0,
    transition: 'box-shadow 120ms, border-color 120ms',
  },
  customSwatch: {
    width: 16,
    height: 16,
    position: 'relative',
    display: 'inline-block',
    cursor: 'pointer',
    flexShrink: 0,
  },
  customSwatchFace: {
    width: 16,
    height: 16,
    borderRadius: 3,
    border: '1px solid',
    pointerEvents: 'none',
  },
  hiddenColorInput: {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    width: '100%',
    height: '100%',
    cursor: 'pointer',
    padding: 0,
    border: 'none',
  },
  sliderGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  slider: {
    width: 64,
    accentColor: theme.gold.primary,
    cursor: 'pointer',
  },
  widthValue: {
    fontSize: 10,
    color: theme.text.secondary,
    width: 26,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  exitBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    padding: '0 10px',
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.gold.primary,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
    cursor: 'pointer',
    fontFamily: theme.font.body,
    boxShadow: theme.shadow.gold,
    transition: 'background 120ms, border-color 120ms',
    flexShrink: 0,
  },
};
